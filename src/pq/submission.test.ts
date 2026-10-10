// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { b64 } from "./canonical";
import { messageHash } from "./chain-pure";
import { GENESIS } from "./registration";
import { buildMemoTx } from "@/lib/solana.server";
import { DBC_PROGRAM_ID } from "./passport";

const mock=vi.hoisted(()=>({prep:null as any,launch:null as any,pool:null as any,meta:null as any,mint:null as any,dbcConfig:null as any,events:[] as string[],failSend:false,raw:[] as Uint8Array[],height:1,confirmed:null as any,tables:[] as string[]}));
vi.mock("@/integrations/supabase/client.server",()=>({supabaseAdmin:{
  from:(table:string)=>{mock.tables.push(table);const q:any={select:()=>q,eq:()=>q,update:(p:any)=>{if(table==="chain_preparations")mock.prep={...mock.prep,...p};else mock.events.push("publish");return q;},single:async()=>({data:mock.launch,error:null}),maybeSingle:async()=>({data:mock.prep,error:null}),then:(resolve:any)=>resolve({data:mock.prep,error:null})};return q;},
  rpc:async(name:string,args:any)=>{
    mock.events.push("persist");
    const p=mock.prep;
    if(name==="record_launch_confirmation") return {data:"passport-id",error:null};
    if(p.submitted_at && (p.signature!==args._signature || p.signed_transaction_b64!==args._transaction)) return {error:{message:"Different transaction"}};
    mock.prep={...p,submitted_at:new Date().toISOString(),signature:args._signature,signed_transaction_b64:args._transaction};
    return {data:mock.prep,error:null};
  },
}}));
vi.mock("@/lib/solana.server",async(importOriginal)=>{
  const actual:any=await importOriginal();
  return {...actual,readPool:async()=>mock.pool,readConfirmedTx:async()=>mock.confirmed,
    readTokenMetadata:async()=>mock.meta,readTokenMint:async()=>mock.mint,readDbcConfig:async()=>mock.dbcConfig,
    connection:()=>({
    getGenesisHash:async()=>GENESIS.devnet,getBlockHeight:async()=>mock.height,
    sendRawTransaction:async(raw:Uint8Array)=>{mock.events.push("broadcast");mock.raw.push(raw);if(mock.failSend)throw new Error("RPC connection lost");return mock.prep.signature;},
  })};
});
import { confirmPrepared, retryPrepared, submitPrepared } from "@/lib/pq.server";

// Pin the server cluster so this suite never inherits a deployment's SOLANA_CLUSTER secret.
process.env.SOLANA_CLUSTER = "devnet";

const owner=crypto.randomUUID(),id=crypto.randomUUID();
let signed:string,signature:string;
beforeEach(async()=>{
  mock.events=[];mock.raw=[];mock.failSend=false;mock.height=1;mock.confirmed=null;mock.tables=[];mock.launch=null;mock.pool=null;
  const wallet=Keypair.generate();const built=await buildMemoTx({getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100})} as any,wallet.publicKey.toBase58(),"fleuri:pqid:v1:test");
  built.tx.sign(wallet);signed=b64(built.tx.serialize());signature=bs58.encode(built.tx.signature!);
  mock.prep={id,owner_id:owner,cluster:"devnet",wallet:wallet.publicKey.toBase58(),message_hash:messageHash(built.message),message_b64:b64(built.message),expires_at:new Date(Date.now()+90000).toISOString(),submitted_at:null,signature:null,payload:{lastValidBlockHeight:100}};
  mock.prep._testMessage=built.message;
});
describe("server submission recovery",()=>{
  it("durably records the deterministic signature before broadcast, then safely recovers an uncertain RPC failure",async()=>{
    mock.failSend=true;await expect(submitPrepared(owner,id,signed)).rejects.toThrow("RPC connection lost");
    expect(mock.events).toEqual(["persist","broadcast"]);expect(mock.prep.signature).toBe(signature);expect(mock.prep.signed_transaction_b64).toBe(signed);
    mock.failSend=false;expect(await retryPrepared(owner,id)).toEqual({signature});expect(mock.raw[1]).toEqual(mock.raw[0]);
  });
  it("denies cross-owner retries without a database mutation or broadcast",async()=>{
    await expect(submitPrepared(crypto.randomUUID(),id,signed)).rejects.toThrow("not found");expect(mock.events).toEqual([]);
    await expect(retryPrepared(crypto.randomUUID(),id)).rejects.toThrow("No signed");
  });
  it("refuses a preparation built for another cluster without broadcasting it",async()=>{
    process.env.SOLANA_CLUSTER="mainnet-beta";
    try { await expect(submitPrepared(owner,id,signed)).rejects.toThrow("not this server's current cluster"); expect(mock.events).toEqual([]); }
    finally { process.env.SOLANA_CLUSTER="devnet"; }
  });
  it("rejects expired blockhashes and expired unsigned preparations before consuming them",async()=>{
    mock.height=101;await expect(submitPrepared(owner,id,signed)).rejects.toThrow("expired");expect(mock.events).toEqual([]);
    mock.height=1;mock.prep.expires_at=new Date(Date.now()-1000).toISOString();await expect(submitPrepared(owner,id,signed)).rejects.toThrow("expired");expect(mock.events).toEqual([]);
  });
  it("rejects an altered prepared-message commitment before touching RPC submission",async()=>{
    mock.prep.message_hash="f".repeat(64);await expect(submitPrepared(owner,id,signed)).rejects.toThrow("differs");expect(mock.events).toEqual([]);
  });
  it("records a confirmed chain failure as terminal and never publishes a successful launch",async()=>{
    await submitPrepared(owner,id,signed);
    mock.confirmed={serialized:mock.prep._testMessage,signers:[mock.prep.wallet],ixs:[],slot:42,err:{InstructionError:[0,"InvalidArgument"]}};
    await expect(confirmPrepared(owner,id)).rejects.toThrow("failed on chain");
    expect(mock.prep.confirmed_at).toBeTruthy();expect(mock.prep.payload.confirmationError).toEqual(mock.confirmed.err);
    expect(mock.tables.every(t=>t==="chain_preparations")).toBe(true);
  });
  it("confirms vesting setup without recording migration or publishing a live DAMM pool",async()=>{
    await submitPrepared(owner,id,signed);
    mock.prep.kind="migrate";mock.prep.payload.stage="locker";
    mock.launch={id:crypto.randomUUID(),owner_id:owner,creator_wallet:mock.prep.wallet,base_mint:"mint",config:"config",pool:"pool",passport_id:"passport"};
    mock.confirmed={serialized:mock.prep._testMessage,signers:[mock.prep.wallet],ixs:[{program:DBC_PROGRAM_ID}],slot:42,err:null};
    mock.pool={migrationProgress:1,baseMint:"mint",config:"config",creator:mock.prep.wallet};
    expect((await confirmPrepared(owner,id)).status).toBe("pending");expect(mock.prep.confirmed_at).toBeUndefined();
    mock.pool.migrationProgress=2;
    const r=await confirmPrepared(owner,id);expect(r.status).toBe("confirmed");expect(r.detail).toContain("Migrate again");
    expect(mock.prep.confirmed_at).toBeTruthy();expect(mock.events).not.toContain("publish");expect(mock.tables).not.toContain("passports");
  });
});
