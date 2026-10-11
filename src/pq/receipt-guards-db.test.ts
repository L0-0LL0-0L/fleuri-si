// @vitest-environment node
// Migration 0015: null-safe and binding-checked receipt RPCs, applied on top of 0014.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
let db: PGlite;
const A = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333", IDT = "44444444-4444-4444-8444-444444444444";
const H = (c: string) => c.repeat(64);
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const q = async (sql: string, p: any[] = []) => (await db.query<any>(sql, p)).rows;
const D = (n: number) => `${n}ddddddd-0000-4000-8000-000000000000`;
const R = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const manifest = (id: string, over: any = {}) => ({ schema: "fleuri.research-receipt/v2", receiptId: id, cluster: "devnet", issuer: { wallet: W, keyHash: H("k"), registrationHash: H("r") }, source: { runId: RUN, inputHash: "ih", outputHash: "oh", contentHash: "ch" }, ...over });
const draft = (req: string, id: string, over: any = {}) => q("select research_create_draft($1,$2,$3::jsonb) j", [A, req, JSON.stringify({ id, run_id: RUN, identity_id: IDT, manifest: over.manifest ?? manifest(id), manifest_hash: over.hash ?? H(id[0]), experiment: { e: 1 }, ...over.extra })]).then((r) => r[0].j);
const prepRow = (id: string, hash: string, over: any = {}) => JSON.stringify({ wallet: W, cluster: "devnet", subject: id, message_hash: H("m"), message_b64: "AA==", transaction_b64: "AA==", payload: { memo: `fleuri:receipt:v1:${hash}` }, expires_at: new Date(Date.now() + 90_000).toISOString(), ...over });

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema public to anon,authenticated,service_role;");
  await db.exec(`create table public.agents(id text primary key, handle text not null);
    create table public.launch_proposals(id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), agent_handle text not null, name text not null, symbol text not null, tagline text default '', reason text default '', status text default 'pending');
    create table public.pq_identities(id uuid primary key, owner_id uuid not null, wallet text not null, key_hash text not null, registration_hash text not null, status text not null default 'unanchored');
    create table public.chain_preparations(id uuid primary key default gen_random_uuid(), owner_id uuid not null, kind text not null, wallet text not null, cluster text not null, message_hash text not null, message_b64 text not null, subject text not null, payload jsonb not null default '{}', expires_at timestamptz not null, submitted_at timestamptz, signature text unique, created_at timestamptz default now(), transaction_b64 text, signed_transaction_b64 text, confirmed_at timestamptz);`);
  for (const f of ["0011_greenhouse_trials", "0012_greenhouse_leases", "0013_greenhouse_recovery_limit", "0014_research_receipts", "0015_research_receipt_guards"]) await db.exec(await readFile(new URL(`./sql/${f}.sql`, import.meta.url), "utf8"));
  await db.exec(`insert into pq_identities values('${IDT}','${A}','${W}','${H("k")}','${H("r")}','unanchored');
    insert into greenhouse_runs(id,owner_id,request_id,status,engine_version,agent_ids,input,input_hash,output,output_hash,content_hash) values('${RUN}','${A}',gen_random_uuid(),'done','greenhouse-rules-2','{a}','{}','ih','{}','oh','ch');`);
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("receipt RPC null and binding guards (0015)", () => {
  it("draft creation refuses missing fields, unbound run/receipt ids, NULL issuer fields and new requestId", async () => {
    await expect(q("select research_create_draft($1,$2,null)", [A, R(1)])).rejects.toThrow("required");
    await expect(draft(R(1), D(1), { hash: "nothex" })).rejects.toThrow("missing required");
    await expect(draft(R(1), D(1), { manifest: manifest(D(1), { source: { inputHash: "ih", outputHash: "oh", contentHash: "ch" } }) })).rejects.toThrow("not bound");
    await expect(draft(R(1), D(1), { manifest: manifest(D(2)) })).rejects.toThrow("not bound");
    await expect(draft(R(1), D(1), { manifest: manifest(D(1), { issuer: { wallet: W, keyHash: H("k") } }) })).rejects.toThrow("issuer does not match"); // NULL registrationHash no longer slips through
    await expect(draft(R(1), D(1), { manifest: manifest(D(1), { requestId: R(1) }) })).rejects.toThrow("private request id");
    expect(await draft(R(1), D(1))).toMatchObject({ created: true });
    // an existing request with a missing run_id is a conflict, not a silent return
    await expect(q("select research_create_draft($1,$2,$3::jsonb)", [A, R(1), JSON.stringify({ id: D(1), identity_id: IDT, manifest: manifest(D(1)), manifest_hash: H("1"), experiment: {} })])).rejects.toThrow("missing required");
  });
  it("signing refuses NULL hash/key/signature/proof and a proof for another issuer", async () => {
    for (const args of [["null", "'pk'", "'s'", "'{}'"], [`'${H("1")}'`, "null", "'s'", "'{}'"], [`'${H("1")}'`, "'pk'", "null", "'{}'"], [`'${H("1")}'`, "'pk'", "'s'", "null"]])
      await expect(q(`select research_sign($1,$2,${args.join(",")})`, [A, D(1)])).rejects.toThrow("required");
    await expect(q("select research_sign($1,$2,$3,'pk','s',$4::jsonb)", [A, D(1), H("1"), JSON.stringify({ key_hash: H("x"), wallet: W })])).rejects.toThrow("issuer");
    expect((await q("select research_sign($1,$2,$3,'pk','s',$4::jsonb) j", [A, D(1), H("1"), JSON.stringify({ key_hash: H("k"), wallet: W })]))[0].j.applied).toBe(true);
    await expect(q("select research_set_published($1,$2,null)", [A, D(1)])).rejects.toThrow("required");
  });
  it("anchor RPCs refuse NULL rows/results and a signature other than the stored submission", async () => {
    await expect(q("select research_create_anchor_preparation($1,$2,null)", [A, D(1)])).rejects.toThrow("required");
    await expect(q("select research_create_anchor_preparation($1,$2,$3::jsonb)", [A, D(1), prepRow(D(1), H("1"), { wallet: null })])).rejects.toThrow("does not match");
    await expect(q("select research_create_anchor_preparation($1,$2,$3::jsonb)", [A, D(1), prepRow(D(1), H("1"), { message_b64: null })])).rejects.toThrow("incomplete");
    const p = (await q("select (research_create_anchor_preparation($1,$2,$3::jsonb)).id", [A, D(1), prepRow(D(1), H("1"))]))[0].id;
    await db.exec(`update chain_preparations set submitted_at=now(), signature='SIG1' where id='${p}'`);
    await expect(q("select research_record_anchor($1,$2,$3,null,'SIG1',5)", [A, D(1), p])).rejects.toThrow("required");
    await expect(q("select research_record_anchor($1,$2,$3,true,null,5)", [A, D(1), p])).rejects.toThrow("required");
    await expect(q("select research_record_anchor($1,$2,$3,true,'SIG1',null)", [A, D(1), p])).rejects.toThrow("slot");
    await expect(q("select research_record_anchor($1,$2,$3,true,'OTHER',5)", [A, D(1), p])).rejects.toThrow("stored submission");
    expect((await q("select research_record_anchor($1,$2,$3,true,'SIG1',5) j", [A, D(1), p]))[0].j.anchor_status).toBe("confirmed");
  });
  it("keeps every receipt RPC unavailable to anon/authenticated after 0015", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const f of ["research_create_draft(null,null,null)", "research_sign(null,null,null,null,null,null)", "research_set_published(null,null,null)", "research_create_anchor_preparation(null,null,null)", "research_record_anchor(null,null,null,null,null,null)"])
        await expect(db.exec(`select ${f}`)).rejects.toThrow("permission denied");
      await db.exec("reset role");
    }
  });
});
