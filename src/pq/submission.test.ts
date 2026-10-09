// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { b64 } from "./canonical";
import { messageHash } from "./chain-pure";
import { GENESIS } from "./registration";
import { buildMemoTx } from "@/lib/solana.server";

const mock=vi.hoisted(()=>({prep:null as any,events:[] as string[],failSend:false,raw:[] as Uint8Array[],height:1,confirmed:null as any,tables:[] as string[]}));
vi.mock("@/integrations/supabase/client.server",()=>({supabaseAdmin:{
  from:(t:string)=>{mock.tables.push(t);let patch:any=null;const q:any={select:()=>q,eq:()=>q,update:(v:any)=>{patch=v;mock.events.push("update:"+t);return q;},maybeSingle:async()=>({data:mock.prep,error:null}),then:(r:any)=>{if(patch)mock.prep={...mock.prep,...patch};return Promise.resolve({data:null,error:null}).then(r);}};return q;},
  rpc:async(_name:string,args:any)=>{
    mock.events.push("persist");
    const p=mock.prep;
    if(p.submitted_at && (p.signature!==args._signature || p.signed_transaction_b64!==args._transaction)) return {error:{message:"Different transaction"}};
    mock.prep={...p,submitted_at:new Date().toISOString(),signature:args._signature,signed_transaction_b64:args._transaction};
    return {data:mock.prep,error:null};
  },
}}));
vi.mock("@/lib/solana.server",async(importOriginal)=>{
  const actual:any=await importOriginal();
  return {...actual,readConfirmedTx:async()=>mock.confirmed,connection:()=>({
    getGenesisHash:async()=>GENESIS.devnet,getBlockHeight:async()=>mock.height,
    sendRawTransaction:async(raw:Uint8Array)=>{mock.events.push("broadcast");mock.raw.push(raw);if(mock.failSend)throw new Error("RPC connection lost");return mock.prep.signature;},
  })};
});
import { confirmPrepared, retryPrepared, submitPrepared } from "@/lib/pq.server";

const owner=crypto.randomUUID(),id=crypto.randomUUID();
let signed:string,signature:string,message:Uint8Array;
beforeEach(async()=>{
  mock.events=[];mock.raw=[];mock.failSend=false;mock.height=1;mock.confirmed=null;mock.tables=[];
  const wallet=Keypair.generate();const built=await buildMemoTx({getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100})} as any,wallet.publicKey.toBase58(),"fleuri:pqid:v1:test");
  built.tx.sign(wallet);message=built.message;signed=b64(built.tx.serialize());signature=bs58.encode(built.tx.signature!);
  mock.prep={id,owner_id:owner,cluster:"devnet",wallet:wallet.publicKey.toBase58(),message_hash:messageHash(built.message),message_b64:b64(built.message),expires_at:new Date(Date.now()+90000).toISOString(),submitted_at:null,signature:null,payload:{lastValidBlockHeight:100}};
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
  it("rejects expired blockhashes and expired unsigned preparations before consuming them",async()=>{
    mock.height=101;await expect(submitPrepared(owner,id,signed)).rejects.toThrow("expired");expect(mock.events).toEqual([]);
    mock.height=1;mock.prep.expires_at=new Date(Date.now()-1000).toISOString();await expect(submitPrepared(owner,id,signed)).rejects.toThrow("expired");expect(mock.events).toEqual([]);
  });
  it("rejects an altered prepared-message commitment before touching RPC submission",async()=>{
    mock.prep.message_hash="f".repeat(64);await expect(submitPrepared(owner,id,signed)).rejects.toThrow("differs");expect(mock.events).toEqual([]);
  });
  it("records a confirmed failed transaction as terminal without publishing a passport or launch",async()=>{
    await submitPrepared(owner,id,signed);mock.prep.kind="launch";mock.events=[];mock.tables=[];
    mock.confirmed={slot:7,err:{InstructionError:[0,"Custom"]},serialized:message,ixs:[],signers:[mock.prep.wallet]};
    await expect(confirmPrepared(owner,id)).rejects.toThrow("failed on chain");
    expect(mock.prep.confirmed_at).toBeTruthy();expect(mock.prep.payload.confirmationError).toEqual({InstructionError:[0,"Custom"]});
    expect(mock.events).toEqual(["update:chain_preparations"]);expect(mock.tables.filter(t=>t==="passports"||t==="launches")).toEqual([]);
  });
});
