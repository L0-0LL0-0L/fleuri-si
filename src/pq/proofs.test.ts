// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64, canonicalize, domainHash, utf8 } from "./canonical";
import { CTX_PASSPORT, CTX_REGISTRATION, generatePqKeypair, pqKeyHash, pqSign, pqVerify, type PqKeypair } from "./mldsa";
import { signPassport, verifyPassportOffline } from "./passport";
import { buildStatement, CHALLENGE_TTL_MS, GENESIS, registrationHash, validateIdentityProof, validateRegistration } from "./registration";
import { decryptEnvelope, encryptKeypair, parseEnvelope } from "./vault";
import { manifestFixture } from "./fixtures";

let kp:PqKeypair;
beforeAll(()=>{kp=generatePqKeypair();});
describe("canonical launch passports",()=>{
  it("sorts keys consistently while preserving exact amount strings",()=>{
    expect(canonicalize({z:"1000000000000000000",a:{b:2,a:1}})).toBe(canonicalize({a:{a:1,b:2},z:"1000000000000000000"}));
    for(const value of [NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER+1,undefined,new Date()]) expect(()=>canonicalize(value)).toThrow();
  });
  it("uses distinct signing contexts and fresh random independent keys",()=>{
    const other=generatePqKeypair();expect(pqKeyHash(other.publicKey)).not.toBe(pqKeyHash(kp.publicKey));
    const msg=utf8("same payload");const sig=pqSign(kp.secretKey,msg,CTX_REGISTRATION);
    expect(pqVerify(kp.publicKey,msg,sig,CTX_REGISTRATION)).toBe(true);
    expect(pqVerify(kp.publicKey,msg,sig,CTX_PASSPORT)).toBe(false);
    expect(pqVerify(other.publicKey,msg,sig,CTX_REGISTRATION)).toBe(false);
    other.secretKey.fill(0);
  });
  it("accepts a complete genuine ML-DSA-65 signed passport",()=>{
    const p=signPassport(manifestFixture(kp),kp);expect(verifyPassportOffline(p).checks.every(c=>c.status==="pass")).toBe(true);
  });
  it.each(["fees","lp","migration","authority","token"])("rejects alterations to %s",section=>{
    const p=signPassport(manifestFixture(kp),kp);const edited:any=structuredClone(p);
    if(section==="fees")edited.manifest.fees.baseFeeBps++;
    if(section==="lp"){edited.manifest.lp.creatorPermanentLockedPercent++;edited.manifest.lp.partnerPermanentLockedPercent--;}
    if(section==="migration")edited.manifest.migration.quoteThresholdLamports="20000000000";
    if(section==="authority")edited.manifest.authority.leftoverReceiver=Keypair.generate().publicKey.toBase58();
    if(section==="token")edited.manifest.token.imageUri="ipfs://"+"c".repeat(59);
    expect(verifyPassportOffline(edited).checks.some(c=>c.status==="fail")).toBe(true);
  });
  it("does not accept malformed base64, oversized or recursive payloads",()=>{
    const p=signPassport(manifestFixture(kp),kp);
    expect(verifyPassportOffline({...p,signature:"!!"}).checks.some(c=>c.status==="fail")).toBe(true);
    expect(verifyPassportOffline("a".repeat(41000)).passport).toBeNull();
    const cycle:any={};cycle.self=cycle;expect(verifyPassportOffline(cycle).passport).toBeNull();
  });
  it("rejects false supply, fee, LP and config claims before signing",()=>{
    for(const field of ["supply","fee","lp","snapshot","genesis","mintAuthority"]) {
      const m:any=manifestFixture(kp);
      if(field==="supply")m.token.totalSupply="0";
      if(field==="fee")m.fees.creatorTradingFeePercent=21;
      if(field==="lp")m.lp.creatorLiquidityPercent=1;
      if(field==="snapshot")m.config.snapshot.fixedTokenSupplyFlag=0;
      if(field==="genesis")m.genesisHash=GENESIS["mainnet-beta"];
      if(field==="mintAuthority")m.authority.mintAuthority="retained";
      expect(()=>signPassport(m,kp)).toThrow();
    }
    expect(domainHash("domain-a",{x:1})).not.toBe(domainHash("domain-b",{x:1}));
  });
});

describe("encrypted backups",()=>{
  it("restores the same identity and rejects a wrong password, changed header or ciphertext",async()=>{
    const env=await encryptKeypair(kp,"a very long test password");
    const restored=await decryptEnvelope(parseEnvelope(JSON.stringify(env)),"a very long test password");
    expect(pqKeyHash(restored.publicKey)).toBe(env.keyHash);expect(restored.secretKey).toEqual(kp.secretKey);restored.secretKey.fill(0);
    await expect(decryptEnvelope(env,"wrong password here")).rejects.toThrow("Wrong password");
    await expect(decryptEnvelope({...env,createdAt:"2020-01-01T00:00:00Z"},"a very long test password")).rejects.toThrow();
    const ct=env.ciphertext;await expect(decryptEnvelope({...env,ciphertext:(ct[0]==="A"?"B":"A")+ct.slice(1)},"a very long test password")).rejects.toThrow();
    expect(()=>parseEnvelope({...env,cipher:{...env.cipher,iv:b64(new Uint8Array(1))}})).toThrow();
  });
});

describe("dual-signed registration and public identity proofs",()=>{
  function fixture() {
    const wallet=Keypair.generate();const owner=crypto.randomUUID();const now=Date.now();
    const fields={domain:"https://fleuri.test",cluster:"devnet" as const,genesisHash:GENESIS.devnet,ownerId:owner,wallet:wallet.publicKey.toBase58(),pqKeyHash:pqKeyHash(kp.publicKey),challengeId:crypto.randomUUID(),nonce:"a".repeat(32),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+CHALLENGE_TTL_MS).toISOString()};
    const statement=buildStatement(fields);const msg=utf8(statement);
    const input={challenge:{id:fields.challengeId,owner_id:owner,wallet:fields.wallet,pq_key_hash:fields.pqKeyHash,statement,expires_at:fields.expiresAt,used_at:null as string|null},ownerId:owner,now,publicKeyB64:b64(kp.publicKey),walletSignatureB64:b64(ed25519.sign(msg,wallet.secretKey.subarray(0,32))),pqSignatureB64:b64(pqSign(kp.secretKey,msg,CTX_REGISTRATION))};
    return {input,fields,identity:{owner_id:owner,wallet:fields.wallet,cluster:fields.cluster,genesis_hash:fields.genesisHash,public_key:input.publicKeyB64,key_hash:fields.pqKeyHash,statement,registration_hash:registrationHash(statement),wallet_signature:input.walletSignatureB64,pq_signature:input.pqSignatureB64}};
  }
  it("verifies both signatures and later validates the original immutable proof",()=>{
    const f=fixture();expect(validateRegistration(f.input).registrationHash).toBe(f.identity.registration_hash);expect(validateIdentityProof(f.identity,f.fields.domain).wallet).toBe(f.fields.wallet);
  });
  it("rejects expired, reused, cross-owner and modified challenges",()=>{
    const {input}=fixture();
    expect(()=>validateRegistration({...input,now:input.now+CHALLENGE_TTL_MS})).toThrow("expired");
    expect(()=>validateRegistration({...input,ownerId:crypto.randomUUID()})).toThrow("different account");
    expect(()=>validateRegistration({...input,challenge:{...input.challenge,used_at:new Date().toISOString()}})).toThrow("already used");
    expect(()=>validateRegistration({...input,challenge:{...input.challenge,statement:input.challenge.statement+"changed"}})).toThrow("Wallet signature");
    expect(()=>validateRegistration({...input,challenge:{...input.challenge,expires_at:"invalid"}})).toThrow("expired");
  });
  it("rejects a substituted wallet, proof, network or domain",()=>{
    const {identity}=fixture();
    expect(()=>validateIdentityProof(identity,"https://another.test")).toThrow();
    expect(()=>validateIdentityProof({...identity,wallet:Keypair.generate().publicKey.toBase58()})).toThrow();
    expect(()=>validateIdentityProof({...identity,genesis_hash:GENESIS["mainnet-beta"]})).toThrow();
    expect(()=>validateIdentityProof({...identity,registration_hash:"c".repeat(64)})).toThrow();
  });
});
