// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
let db: PGlite;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333", IDT = "44444444-4444-4444-8444-444444444444", IDT_B = "44444444-4444-4444-8444-4444444444bb";
const H = (c: string) => c.repeat(64);
const q = async (sql: string, p: any[] = []) => (await db.query<any>(sql, p)).rows;
const as = async (role: string, sub?: string) => { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [sub ?? ""]); await db.exec(`set role ${role}`); };
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const manifest = (hash = "c") => ({ cluster: "devnet", issuer: { wallet: W, keyHash: H("k") }, source: { inputHash: "ih", outputHash: "oh", contentHash: "ch" }, tag: hash });
const draft = (req: string, id: string, over: any = {}) => q("select research_create_draft($1,$2,$3::jsonb) j", [over.owner ?? A, req, JSON.stringify({ id, run_id: over.run ?? RUN, identity_id: over.identity ?? IDT, manifest: over.manifest ?? manifest(id[0]), manifest_hash: over.hash ?? H(id[0]), experiment: { e: 1.25 } })]).then((r) => r[0].j);
const R = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const D = (n: number) => `${n}ddddddd-0000-4000-8000-000000000000`;
const prepRow = (id: string, hash: string, over: any = {}) => JSON.stringify({ wallet: W, cluster: "devnet", subject: id, message_hash: H("m"), message_b64: "AA==", transaction_b64: "AA==", payload: { memo: `fleuri:receipt:v1:${hash}` }, expires_at: new Date(Date.now() + 90_000).toISOString(), ...over });

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema public to anon,authenticated,service_role; grant usage on schema auth to anon,authenticated,service_role;");
  await db.exec(`create table public.agents(id text primary key, handle text not null);
    create table public.launch_proposals(id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), agent_handle text not null, name text not null, symbol text not null, tagline text default '', reason text default '', status text default 'pending');
    create table public.pq_identities(id uuid primary key, owner_id uuid not null, wallet text not null, key_hash text not null, status text not null default 'unanchored');
    create table public.chain_preparations(id uuid primary key default gen_random_uuid(), owner_id uuid not null, kind text not null, wallet text not null, cluster text not null, message_hash text not null, message_b64 text not null, subject text not null, payload jsonb not null default '{}', expires_at timestamptz not null, submitted_at timestamptz, signature text unique, created_at timestamptz default now(), transaction_b64 text, signed_transaction_b64 text, confirmed_at timestamptz);`);
  for (const f of ["0011_greenhouse_trials", "0012_greenhouse_leases", "0013_greenhouse_recovery_limit"]) await db.exec(await readFile(new URL(`./sql/${f}.sql`, import.meta.url), "utf8"));
  await db.exec("grant all on all tables in schema public to anon,authenticated;"); // Supabase-like broad defaults that 0014 must override
  await db.exec(await readFile(new URL("./sql/0014_research_receipts.sql", import.meta.url), "utf8"));
  await db.exec(`insert into pq_identities values('${IDT}','${A}','${W}','${H("k")}','unanchored'),('${IDT_B}','${B}','${W}','${H("j")}','unanchored');
    insert into greenhouse_runs(id,owner_id,request_id,status,engine_version,agent_ids,input,input_hash,output,output_hash,content_hash) values('${RUN}','${A}',gen_random_uuid(),'done','greenhouse-rules-2','{a}','{}','ih','{}','oh','ch');`);
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("research receipts migration", () => {
  it("creates a frozen draft idempotently; conflicting reuse and other owners are refused", async () => {
    const a = await draft(R(1), D(1));
    expect(a).toMatchObject({ created: true, status: "draft" });
    expect(await draft(R(1), D(1))).toMatchObject({ created: false, id: a.id });
    await expect(draft(R(1), D(2), { identity: IDT_B })).rejects.toThrow("different trial or identity");
    await expect(draft(R(2), D(2), { owner: B, identity: IDT_B })).rejects.toThrow("Only your own completed");
    await expect(draft(R(3), D(3), { identity: IDT_B })).rejects.toThrow("Identity not found");
    await expect(draft(R(4), D(4), { manifest: { ...manifest(), source: { inputHash: "x", outputHash: "oh", contentHash: "ch" } } })).rejects.toThrow("stored trial checksums");
  });
  it("drafts are frozen; signing is idempotent with the original bytes; signed evidence is immutable", async () => {
    await expect(db.exec(`update research_receipts set experiment='{"e":2}' where id='${D(1)}'`)).rejects.toThrow("frozen");
    await expect(q("select research_sign($1,$2,$3,'pk','sig1','{}')", [A, D(1), H("z")])).rejects.toThrow("different document");
    expect((await q("select research_sign($1,$2,$3,'pk','sig1','{}') j", [A, D(1), H("1")]))[0].j.applied).toBe(true);
    expect((await q("select research_sign($1,$2,$3,'pk','sig2','{}') j", [A, D(1), H("1")]))[0].j.applied).toBe(false);
    expect((await q("select signature from research_receipts where id=$1", [D(1)]))[0].signature).toBe("sig1");
    await expect(q("select research_sign($1,$2,$3,'other','sig3','{}')", [A, D(1), H("1")])).rejects.toThrow("different key");
    await expect(q("select research_sign($1,$2,$3,'pk','sig1','{}')", [B, D(1), H("1")])).rejects.toThrow("not found");
    await expect(db.exec(`update research_receipts set signature='x' where id='${D(1)}'`)).rejects.toThrow("immutable");
  });
  it("private by default; publish is explicit; private columns are never readable", async () => {
    await as("anon"); expect(await q("select id from research_receipts")).toHaveLength(0);
    await as("authenticated", B); expect(await q("select id from research_receipts")).toHaveLength(0);
    await as("authenticated", A); expect(await q("select id from research_receipts")).toHaveLength(1);
    for (const col of ["owner_id", "request_id", "identity_id", "anchor_preparation_id", "run_id"]) await expect(q(`select ${col} from research_receipts`)).rejects.toThrow("permission denied");
    await db.exec("reset role");
    await expect(q("select research_set_published($1,$2,true)", [B, D(1)])).rejects.toThrow("Only your own");
    await q("select research_set_published($1,$2,true)", [A, D(1)]);
    await as("anon"); expect((await q("select id, signature from research_receipts"))[0]).toEqual({ id: D(1), signature: "sig1" });
    await db.exec("reset role"); await q("select research_set_published($1,$2,false)", [A, D(1)]);
    await as("anon"); expect(await q("select id from research_receipts")).toHaveLength(0);
    await db.exec("reset role");
  });
  it("denies table writes and every receipt RPC to anon/authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      await as(role, A);
      await expect(db.exec(`update research_receipts set published=true`)).rejects.toThrow("permission denied");
      await expect(db.exec(`delete from research_receipts`)).rejects.toThrow("permission denied");
      await expect(db.exec(`truncate research_receipts`)).rejects.toThrow("permission denied");
      await expect(db.exec(`insert into research_receipts(id,owner_id,request_id,run_id,identity_id,manifest,manifest_hash,experiment) values(gen_random_uuid(),auth.uid(),gen_random_uuid(),'${RUN}','${IDT}','{}','${H("e")}','{}')`)).rejects.toThrow("permission denied");
      for (const f of ["research_create_draft(null,null,null)", "research_sign(null,null,null,null,null,null)", "research_set_published(null,null,null)", "research_create_anchor_preparation(null,null,null)", "research_record_anchor(null,null,null,null,null,null)"])
        await expect(db.exec(`select ${f}`)).rejects.toThrow("permission denied");
    }
    await db.exec("reset role");
  });
  it("anchor: atomic link, one active attempt, mismatch refused, confirm once, failure terminal", async () => {
    await expect(q("select (research_create_anchor_preparation($1,$2,$3::jsonb)).id", [A, D(1), prepRow(D(1), H("0"))])).rejects.toThrow("does not match");
    await expect(q("select (research_create_anchor_preparation($1,$2,$3::jsonb)).id", [A, D(1), prepRow(D(1), H("1"), { wallet: "x" })])).rejects.toThrow("does not match");
    await expect(q("select (research_create_anchor_preparation($1,$2,$3::jsonb)).id", [B, D(1), prepRow(D(1), H("1"))])).rejects.toThrow("Only your own");
    const [p1, p2] = await Promise.all([1, 2].map(() => q("select (research_create_anchor_preparation($1,$2,$3::jsonb)).id", [A, D(1), prepRow(D(1), H("1"))]).then((r) => r[0].id)));
    expect(p2).toBe(p1); // concurrent clicks reuse the one active unsubmitted preparation
    expect((await q("select count(*)::int n from chain_preparations where kind='receipt_anchor'"))[0].n).toBe(1);
    await db.exec(`update chain_preparations set submitted_at=now(), signature='SIG1' where id='${p1}'`);
    await expect(q("select research_create_anchor_preparation($1,$2,$3::jsonb)", [A, D(1), prepRow(D(1), H("1"))])).rejects.toThrow("already submitted");
    await expect(q("select research_record_anchor($1,$2,gen_random_uuid(),true,'SIG1',5)", [A, D(1)])).rejects.toThrow("current anchor");
    expect((await q("select research_record_anchor($1,$2,$3,false,'SIG1',5) j", [A, D(1), p1]))[0].j.anchor_status).toBe("failed");
    expect((await q("select research_record_anchor($1,$2,$3,true,'SIG1',5) j", [A, D(1), p1]))[0].j).toMatchObject({ anchor_status: "failed", applied: false });
    // a new attempt after a terminal failure
    const p3 = (await q("select (research_create_anchor_preparation($1,$2,$3::jsonb)).id", [A, D(1), prepRow(D(1), H("1"))]))[0].id;
    expect(p3).not.toBe(p1);
    expect((await q("select research_record_anchor($1,$2,$3,true,'SIG3',7) j", [A, D(1), p3]))[0].j.anchor_status).toBe("confirmed");
    expect((await q("select research_record_anchor($1,$2,$3,true,'SIG3',7) j", [A, D(1), p3]))[0].j.applied).toBe(false);
    await expect(q("select research_record_anchor($1,$2,$3,true,'OTHER',7)", [A, D(1), p3])).rejects.toThrow("different anchor");
    await expect(q("select research_create_anchor_preparation($1,$2,$3::jsonb)", [A, D(1), prepRow(D(1), H("1"))])).rejects.toThrow("already anchored");
    await expect(db.exec(`update research_receipts set anchor_status='none' where id='${D(1)}'`)).rejects.toThrow("final");
    expect((await q("select confirmed_at is not null c from chain_preparations where id=$1", [p3]))[0].c).toBe(true);
  });
  it("drafts cannot be anchored or published", async () => {
    await draft(R(5), D(5));
    await expect(q("select research_create_anchor_preparation($1,$2,$3::jsonb)", [A, D(5), prepRow(D(5), H("5"))])).rejects.toThrow("signed receipts");
    await expect(q("select research_set_published($1,$2,true)", [A, D(5)])).rejects.toThrow("signed receipts");
  });
});
