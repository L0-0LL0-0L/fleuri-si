// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
let db:PGlite;
const owner="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",identity="33333333-3333-4333-8333-333333333333";
const wallet="1".repeat(32),nonce="a".repeat(32),hash="a".repeat(64);
beforeAll(async()=>{
  db=new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to anon,authenticated,service_role;");
  await db.exec(await readFile(new URL("../../drizzle/migrations/0003_pq_launchpad.sql",import.meta.url),"utf8"));
  // Reproduce Supabase's broad default grants so TRUNCATE bypass is actually exercised.
  await db.exec("grant all on all tables in schema public to anon,authenticated;");
  await db.exec(await readFile(new URL("./sql/0004_pq_atomic_and_permissions.sql",import.meta.url),"utf8"));
},30_000);
beforeEach(async()=>{
  await db.exec("reset role; truncate pq_challenges,pq_identities,chain_preparations,launch_nonces,passports,launches cascade;");
  await db.query("insert into pq_identities(id,owner_id,wallet,cluster,genesis_hash,public_key,key_hash,statement,registration_hash,wallet_signature,pq_signature,status) values($1,$2,$3,'devnet','genesis','public-key',$4,'statement',$5,'wallet-proof','pq-proof','anchored')",[identity,owner,wallet,"c".repeat(64),"d".repeat(64)]);
  await db.query("insert into launch_nonces(nonce,owner_id,identity_id,expires_at) values($1,$2,$3,now()+interval '15 minutes')",[nonce,owner,identity]);
});
afterAll(async()=>{await db?.close();});
const queryRow=async(sql:string,params:any[]=[])=>((await db.query<any>(sql,params)).rows[0]);
function prepRow(manifestHash=hash) {
  return {wallet,cluster:"devnet",subject:"mint",message_hash:hash,message_b64:"message",transaction_b64:"unsigned",expires_at:new Date(Date.now()+90000).toISOString(),payload:{identityId:identity,baseMint:"mint",pool:"pool",config:"config",metadataUri:"ipfs://content",metadataHash:hash,passport:{manifestHash,manifest:{token:{name:"Bloom"}},signature:"pq-signature"}}};
}
const prepare=(row=prepRow(),who=owner)=>queryRow("select (create_launch_preparation($1,$2,$3,$4::jsonb)).*",[who,nonce,identity,JSON.stringify(row)]);
const claim=(id:string,signature="wallet-signature",signed="signed-bytes",who=owner)=>queryRow("select (claim_chain_submission($1,$2,$3,$4,$5)).*",[id,who,hash,signature,signed]);
describe("actual PostgreSQL migrations and privileges",()=>{
  it("lets anonymous readers inspect confirmed identities while denying TRUNCATE, writes and RPC execution",async()=>{
    await db.exec("set role anon");expect((await db.query("select id from pq_identities")).rows).toHaveLength(1);
    await expect(db.exec("truncate pq_identities cascade")).rejects.toThrow("permission denied");
    await expect(db.exec("delete from pq_identities")).rejects.toThrow("permission denied");
    await expect(db.query("select register_pq_identity($1,$2,'{}')",[identity,owner])).rejects.toThrow("permission denied");
    await expect(db.exec("select * from chain_preparations")).rejects.toThrow("permission denied");
  });
  it("isolates private preparations by authenticated owner and denies authenticated TRUNCATE",async()=>{
    const p=await prepare();await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);expect((await db.query("select * from chain_preparations")).rows).toHaveLength(0);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);expect((await db.query("select * from chain_preparations")).rows[0]).toMatchObject({id:p.id});
    await expect(db.exec("truncate chain_preparations")).rejects.toThrow("permission denied");
  });
  it("prepares one immutable launch per nonce and supports identical-response recovery",async()=>{
    const a=await prepare(),b=await prepare();expect(a.id).toBe(b.id);expect((await db.query("select id from chain_preparations")).rows).toHaveLength(1);
    await expect(prepare(prepRow("b".repeat(64)))).rejects.toThrow("different terms");
    await expect(prepare(prepRow(),other)).rejects.toThrow("wrong owner");
  });
  it("keeps the nonce unused if preparation creation rolls back",async()=>{
    await expect(prepare({...prepRow(),message_hash:"invalid"})).rejects.toThrow();
    expect(await queryRow("select used_at,preparation_id from launch_nonces")).toEqual({used_at:null,preparation_id:null});
    expect((await prepare()).id).toBeTruthy();
  });
  it("persists signed bytes before broadcast and permits only exact retries",async()=>{
    const p=await prepare();const a=await claim(p.id),b=await claim(p.id);expect(a.signature).toBe("wallet-signature");expect(a.signed_transaction_b64).toBe("signed-bytes");expect(a.id).toBe(b.id);
    await expect(claim(p.id,"different","changed")).rejects.toThrow("Different signed");await expect(claim(p.id,"wallet-signature","signed-bytes",other)).rejects.toThrow("mismatch");
  });
  it("does not consume expired preparations, but keeps prior signed submissions recoverable",async()=>{
    const p=await prepare();await db.query("update chain_preparations set expires_at=now()-interval '1 minute' where id=$1",[p.id]);await expect(claim(p.id)).rejects.toThrow("expired");
    expect((await queryRow("select submitted_at from chain_preparations")).submitted_at).toBeNull();
    await db.query("update chain_preparations set expires_at=now()+interval '1 minute' where id=$1",[p.id]);await claim(p.id);
    await db.query("update chain_preparations set expires_at=now()-interval '1 minute' where id=$1",[p.id]);expect((await claim(p.id)).signature).toBe("wallet-signature");
  });
  it("publishes passport and launch atomically and idempotently",async()=>{
    const p=await prepare();await claim(p.id);
    const run=()=>queryRow("select record_launch_confirmation($1,$2,42,'curve_active') as id",[p.id,owner]);
    expect(await run()).toEqual(await run());expect((await db.query("select * from passports")).rows).toHaveLength(1);expect((await db.query("select * from launches")).rows).toHaveLength(1);
    expect((await queryRow("select confirmed_at from chain_preparations")).confirmed_at).not.toBeNull();
  });
  it("rolls back public passport publication when launch confirmation fails",async()=>{
    const p=await prepare();await claim(p.id);
    await expect(db.query("select record_launch_confirmation($1,$2,42,'fake-state')",[p.id,owner])).rejects.toThrow();
    expect((await db.query("select * from passports")).rows).toHaveLength(0);expect((await queryRow("select confirmed_at from chain_preparations")).confirmed_at).toBeNull();
  });
  it("consumes a registration challenge only after identity insertion succeeds",async()=>{
    const challenge=crypto.randomUUID();
    await db.query("insert into pq_challenges(id,owner_id,wallet,pq_key_hash,cluster,genesis_hash,nonce,statement,expires_at) values($1,$2,$3,$4,'devnet','genesis','unique','proof statement',now()+interval '5 minutes')",[challenge,owner,wallet,"e".repeat(64)]);
    const proof={publicKey:"key",walletSignature:"wallet",pqSignature:"pq",registrationHash:"f".repeat(64)};
    const run=(value:any)=>queryRow("select (register_pq_identity($1,$2,$3::jsonb)).*",[challenge,owner,JSON.stringify(value)]);
    await expect(run({...proof,registrationHash:"bad"})).rejects.toThrow();expect((await queryRow("select used_at from pq_challenges where id=$1",[challenge])).used_at).toBeNull();
    const a=await run(proof),b=await run(proof);expect(a.id).toBe(b.id);expect((await queryRow("select used_at from pq_challenges where id=$1",[challenge])).used_at).not.toBeNull();
  });
});
