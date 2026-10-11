// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
let db: PGlite;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const R1 = "aaaaaaaa-0000-4000-8000-000000000001";
const input = { config: { repetitions: 2, scenarios: ["control"], seed: 1 }, policies: [{ agentId: "a_1", policyHash: "p".repeat(64) }] };
const q = async (sql: string, p: any[] = []) => (await db.query<any>(sql, p)).rows;
const as = async (role: string, sub?: string) => { await db.exec(`reset role`); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [sub ?? ""]); await db.exec(`set role ${role}`); };
const claim = (owner = A, req = R1, inp: any = input) => q("select greenhouse_claim_lease($1,$2,'greenhouse-rules-2',array['a_1'],$3::jsonb,'ih') j", [owner, req, JSON.stringify(inp)]).then((r) => r[0].j);
const fin = (id: string, lease: string | null, oh = "oh", owner = A) => q("select greenhouse_finalize_lease($1,$2,$3,'ih','{}'::jsonb,$4,'ch') j", [id, owner, lease, oh]).then((r) => r[0].j);
const failL = (id: string, lease: string | null) => q("select greenhouse_fail_lease($1,$2,$3,'boom') j", [id, A, lease]).then((r) => r[0].j);
const expire = (req: string) => db.exec(`update greenhouse_runs set lease_expires_at=now()-interval '1 second' where request_id='${req}'`);
const rid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to anon,authenticated,service_role; grant usage on schema public to anon,authenticated,service_role;");
  await db.exec("create table public.agents(id text primary key, handle text not null); create table public.launch_proposals(id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), agent_handle text not null, name text not null, symbol text not null, tagline text default '', reason text default '', status text default 'pending');");
  await db.exec("grant all on all tables in schema public to anon,authenticated;"); // Supabase-like broad defaults
  await db.exec(await readFile(new URL("./sql/0011_greenhouse_trials.sql", import.meta.url), "utf8"));
  await db.exec("grant all on all tables in schema public to anon,authenticated;"); // defaults re-granted later must be revoked by 0012
  await db.exec(await readFile(new URL("./sql/0012_greenhouse_leases.sql", import.meta.url), "utf8"));
  await db.exec("insert into agents values('a_1','rose'),('a_2','moss'); insert into launch_proposals(id,agent_handle,name,symbol,origin_agent_id,origin_policy_hash) values('bbbbbbbb-0000-4000-8000-000000000001','rose','Rose','ROSE','a_1','"+"p".repeat(64)+"'),('bbbbbbbb-0000-4000-8000-000000000002','moss','Moss','MOSS',null,null),('bbbbbbbb-0000-4000-8000-000000000003','nobody','X','XXX',null,null);");
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("greenhouse leases (0012)", () => {
  it("acquires once; an immediate retry gets running without a lease (no duplicate computation)", async () => {
    await db.exec("reset role");
    const a = await claim(), b = await claim();
    expect(a.acquired).toBe(true); expect(a.lease).toMatch(/-/);
    expect(b.id).toBe(a.id); expect(b.status).toBe("running"); expect(b.acquired).toBe(false); expect(b.lease).toBeNull();
    expect((await q("select count(*)::int n from greenhouse_runs"))[0].n).toBe(1);
  });
  it("rejects the same request id with different settings", async () => {
    await expect(claim(A, R1, { ...input, config: { ...input.config, seed: 2 } })).rejects.toThrow("different trial settings");
  });
  it("expired lease renews a new token; the stale worker cannot finalize or fail", async () => {
    const first = (await q("select lease_token from greenhouse_runs where request_id=$1", [R1]))[0].lease_token;
    await expire(R1);
    const c = await claim();
    expect(c.acquired).toBe(true); expect(c.attempts).toBe(2); expect(c.lease).not.toBe(first); expect(c.input).toEqual(input);
    await expect(fin(c.id, first)).rejects.toThrow("Stale worker");
    expect((await failL(c.id, first)).applied).toBe(false);
    expect((await q("select status from greenhouse_runs where id=$1", [c.id]))[0].status).toBe("running");
    expect((await fin(c.id, c.lease)).applied).toBe(true);
    expect((await fin(c.id, c.lease)).applied).toBe(false); // identical retry is idempotent
    await expect(fin(c.id, c.lease, "zz")).rejects.toThrow("different result");
    await expect(q("select greenhouse_finalize_lease($1,$2,$3,'other','{}'::jsonb,'oh','ch')", [c.id, A, c.lease])).rejects.toThrow("different inputs");
    await expect(fin(c.id, c.lease, "oh", B)).rejects.toThrow("Unknown run");
  });
  it("terminal failure stays failed: a late finalize is refused", async () => {
    const r = await claim(A, rid(50));
    expect((await failL(r.id, r.lease)).applied).toBe(true);
    await expect(fin(r.id, r.lease)).rejects.toThrow("terminal failure");
    const again = await claim(A, rid(50));
    expect(again).toMatchObject({ status: "failed", acquired: false });
  });
  it("gives up after 3 attempts instead of running forever", async () => {
    const req = rid(51);
    await claim(A, req);
    for (let i = 0; i < 2; i++) { await expire(req); expect((await claim(A, req)).acquired).toBe(true); }
    await expire(req);
    expect(await claim(A, req)).toMatchObject({ status: "failed", acquired: false });
  });
  it("keeps private runs private, publishes explicitly, hides owner/request/lease", async () => {
    const r = (await q("select id from greenhouse_runs where request_id=$1", [R1]))[0];
    await as("anon"); expect(await q("select id from greenhouse_runs")).toHaveLength(0);
    await as("authenticated", B); expect(await q("select id from greenhouse_runs")).toHaveLength(0);
    await as("authenticated", A); expect((await q("select id from greenhouse_runs")).length).toBeGreaterThan(0);
    for (const col of ["owner_id", "request_id", "lease_token", "lease_expires_at"]) await expect(q(`select ${col} from greenhouse_runs`)).rejects.toThrow("permission denied");
    await db.exec("reset role");
    await expect(q("select greenhouse_set_published($1,$2,true)", [r.id, B])).rejects.toThrow("Only your own");
    await q("select greenhouse_set_published($1,$2,true)", [r.id, A]);
    await as("anon"); expect((await q("select id,output_hash from greenhouse_runs"))[0]).toMatchObject({ id: r.id, output_hash: "oh" });
    await expect(q("select lease_token from greenhouse_runs")).rejects.toThrow("permission denied");
    await db.exec("reset role"); await q("select greenhouse_set_published($1,$2,false)", [r.id, A]);
    await as("anon"); expect(await q("select id from greenhouse_runs")).toHaveLength(0);
  });
  it("denies writes, TRUNCATE and every mutation RPC to anon and authenticated; obsolete RPCs are dead", async () => {
    for (const role of ["anon", "authenticated"]) {
      await as(role, A);
      await expect(db.exec("insert into greenhouse_runs(owner_id,request_id,engine_version,agent_ids,input,input_hash) values(auth.uid(),gen_random_uuid(),'x','{}','{}','x')")).rejects.toThrow("permission denied");
      await expect(db.exec("update greenhouse_runs set published=true")).rejects.toThrow("permission denied");
      await expect(db.exec("delete from greenhouse_evidence")).rejects.toThrow("permission denied");
      await expect(db.exec("truncate greenhouse_runs cascade")).rejects.toThrow("permission denied");
      for (const f of ["greenhouse_claim_lease(null,null,null,null,null,null)", "greenhouse_finalize_lease(null,null,null,null,null,null,null)", "greenhouse_fail_lease(null,null,null,null)", "greenhouse_claim_run(null,null,null,null,null,null)", "greenhouse_finalize_run(null,null,null,null,null,null)", "greenhouse_set_published(null,null,null)", "greenhouse_attach_evidence(null,null,null)", "greenhouse_fail_run(null,null,null)"])
        await expect(db.exec(`select ${f}`)).rejects.toThrow("permission denied");
    }
    await db.exec("reset role");
    const priv = await q("select has_function_privilege('service_role','public.greenhouse_finalize_run(uuid,uuid,text,jsonb,text,text)','execute') f, has_function_privilege('service_role','public.greenhouse_finalize_lease(uuid,uuid,uuid,text,jsonb,text,text)','execute') l");
    expect(priv[0]).toEqual({ f: false, l: true });
    await expect(q("select greenhouse_fail_run($1,$2,'x')", [rid(50), A])).rejects.toThrow("Obsolete");
  });
  it("attaches per-reviewer evidence only for the originating agent, owner-scoped", async () => {
    const r = (await q("select id from greenhouse_runs where request_id=$1", [R1]))[0];
    const e = (await q("select (greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000001',$2)).*", [A, r.id]))[0];
    expect(e).toMatchObject({ origin_agent_id: "a_1", run_policy_hash: "p".repeat(64), proposal_policy_hash: "p".repeat(64), repetitions: 2 });
    expect((await q("select (greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000001',$2)).*", [A, r.id]))[0].id).toBe(e.id);
    await expect(q("select greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000001',$2)", [B, r.id])).rejects.toThrow("Only your own");
    await expect(q("select greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000002',$2)", [A, r.id])).rejects.toThrow("does not include");
    await expect(q("select greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000003',$2)", [A, r.id])).rejects.toThrow("does not include");
    await as("authenticated", B); expect(await q("select id from greenhouse_evidence")).toHaveLength(0);
    await as("anon"); await expect(q("select id from greenhouse_evidence")).rejects.toThrow("permission denied");
    await as("authenticated", A); expect(await q("select id from greenhouse_evidence")).toHaveLength(1);
    await db.exec("reset role");
  });
  it("enforces 2 active trials per owner, even for concurrent claims", async () => {
    const reqs = [1, 2, 3, 4].map((i) => `dddddddd-0000-4000-8000-00000000000${i}`);
    const res = await Promise.allSettled(reqs.map((r) => claim(C, r)));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect(res.filter((x) => x.status === "rejected").every((x: any) => /already running/.test(String(x.reason)))).toBe(true);
    await db.exec(`update greenhouse_runs set status='done' where owner_id='${C}'`);
  });
  it("rate-limits 30 per hour per owner", async () => {
    for (let i = 0; i < 40; i++) {
      const req = `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`;
      try { await claim(B, req); await db.exec(`update greenhouse_runs set status='done' where request_id='${req}'`); } catch (e) { expect(String(e)).toMatch(/limit/); expect(i).toBe(30); return; }
    }
    throw new Error("never limited");
  });
});
