// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient, StateService, MigrationOption } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { vi } from "vitest";
import { b64 } from "./canonical";
import { checkSubmission, mapLifecycle, messageHash } from "./chain-pure";
import { buildCreatePoolTx, buildMemoTx, decodeTokenMetadata, derivePool, finalizeUnsigned, MEMO_PROGRAM_ID, unsignedB64 } from "@/lib/solana.server";
import { DBC_PROGRAM_ID } from "./passport";

describe("prepared chain transactions",()=>{
  it("accepts only the exact signed message and every required signature",async()=>{
    const wallet=Keypair.generate();const conn:any={getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000})};
    const built=await buildMemoTx(conn,wallet.publicKey.toBase58(),"fleuri:pqid:v1:test");
    const prepared={messageHash:messageHash(built.message),messageB64:b64(built.message)};
    expect(()=>checkSubmission(prepared,unsignedB64(built.tx))).toThrow("signature");
    built.tx.sign(wallet);const raw=built.tx.serialize();expect(checkSubmission(prepared,b64(raw))).toEqual(raw);
    const changed=Transaction.from(raw);changed.instructions[0].data=Buffer.from("changed");changed.sign(wallet);
    expect(()=>checkSubmission(prepared,b64(changed.serialize()))).toThrow("differs");
  });
  it("constructs a genuine Meteora DBC pool transaction with the mint and creator signers",async()=>{
    const wallet=Keypair.generate(),mint=Keypair.generate(),config=Keypair.generate();
    const conn=new Connection("https://api.devnet.solana.com","confirmed");
    conn.getLatestBlockhash=async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000});
    conn.getAccountInfo=async key=>key.equals(NATIVE_MINT)?{owner:TOKEN_PROGRAM_ID,data:Buffer.alloc(82),lamports:0,executable:false}:null;
    const spy=vi.spyOn(StateService.prototype,"getPoolConfig").mockResolvedValue({poolFees:{baseFee:{baseFeeMode:0}},migrationOption:MigrationOption.MET_DAMM_V2,tokenType:0,quoteMint:NATIVE_MINT} as any);
    try {
      const built=await buildCreatePoolTx(conn,{config:config.publicKey.toBase58(),baseMint:mint.publicKey.toBase58(),creator:wallet.publicKey.toBase58(),name:"Test Bloom",symbol:"TEST",uri:"ipfs://"+"b".repeat(59)});
      built.tx.partialSign(mint,wallet);
      expect(built.signers.sort()).toEqual([mint.publicKey.toBase58(),wallet.publicKey.toBase58()].sort());
      expect(built.tx.instructions[0].programId.toBase58()).toBe(DBC_PROGRAM_ID);
      expect(built.tx.instructions[0].keys.some(k=>k.pubkey.toBase58()===derivePool(mint.publicKey.toBase58(),config.publicKey.toBase58()))).toBe(true);
      expect(built.tx.verifySignatures()).toBe(true);expect(built.tx.serialize().length).toBeLessThanOrEqual(1232);
    } finally {spy.mockRestore();}
  });
  it("retains both actual SDK migration position-mint signatures until the wallet signs",async()=>{
    const conn=new Connection("https://api.devnet.solana.com","confirmed"),wallet=Keypair.generate(),mint=Keypair.generate(),config=Keypair.generate();
    const client=new DynamicBondingCurveClient(conn,"confirmed");
    const poolSpy=vi.spyOn(StateService.prototype,"getPool").mockResolvedValue({poolState:{config:config.publicKey,baseMint:mint.publicKey,baseVault:Keypair.generate().publicKey,quoteVault:Keypair.generate().publicKey}} as any);
    const configSpy=vi.spyOn(StateService.prototype,"getPoolConfig").mockResolvedValue({quoteMint:NATIVE_MINT,tokenType:0,quoteTokenFlag:0} as any);
    try {
      const r=await client.migration.migrateToDammV2({payer:wallet.publicKey,pool:Keypair.generate().publicKey,dammConfig:Keypair.generate().publicKey});
      const nfts=[r.firstPositionNftKeypair,r.secondPositionNftKeypair];
      const built=finalizeUnsigned(r.transaction,wallet.publicKey,{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000},[wallet.publicKey.toBase58(),...nfts.map(k=>k.publicKey.toBase58())]);
      built.tx.partialSign(...nfts);const restored=Transaction.from(Buffer.from(unsignedB64(built.tx),"base64"));
      expect(restored.signatures.filter(s=>s.signature).length).toBe(2);restored.partialSign(wallet);expect(restored.verifySignatures()).toBe(true);expect(restored.serialize().length).toBeLessThanOrEqual(1232);
    } finally {poolSpy.mockRestore();configSpy.mockRestore();}
  });
  it("rejects unexpected signers and oversized legacy messages",()=>{
    const wallet=Keypair.generate(),other=Keypair.generate();const bh={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000};
    const tx=new Transaction().add(new TransactionInstruction({programId:MEMO_PROGRAM_ID,keys:[{pubkey:other.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(10)}));
    expect(()=>finalizeUnsigned(tx,wallet.publicKey,bh,[wallet.publicKey.toBase58()])).toThrow("unexpected signers");
    const large=new Transaction().add(new TransactionInstruction({programId:MEMO_PROGRAM_ID,keys:[],data:Buffer.alloc(1200)}));
    expect(()=>finalizeUnsigned(large,wallet.publicKey,bh,[wallet.publicKey.toBase58()])).toThrow();
  });
  it("requires an actual confirmed DAMM v2 pool before calling graduation live",()=>{
    const p={isMigrated:0,migrationProgress:0,quoteReserve:0n,migrationQuoteThreshold:100n};
    expect(mapLifecycle(p)).toBe("curve_active");expect(mapLifecycle({...p,quoteReserve:100n})).toBe("curve_completed");
    expect(mapLifecycle({...p,migrationProgress:2})).toBe("migration_pending");expect(mapLifecycle({...p,isMigrated:1})).toBe("migration_pending");
    expect(mapLifecycle({...p,isMigrated:1,dammV2Confirmed:true})).toBe("damm_v2_live");
  });
  it("rejects metadata for a different mint and truncated fields",()=>{
    const mint=Keypair.generate().publicKey;const d=Buffer.alloc(200);d[0]=4;mint.toBuffer().copy(d,33);d.writeUInt32LE(300,65);
    expect(()=>decodeTokenMetadata(d,mint.toBase58())).toThrow();expect(()=>decodeTokenMetadata(Buffer.alloc(20),mint.toBase58())).toThrow();
    expect(()=>decodeTokenMetadata(d,Keypair.generate().publicKey.toBase58())).toThrow();expect(DBC_PROGRAM_ID).not.toBe(MEMO_PROGRAM_ID.toBase58());
  });
});
