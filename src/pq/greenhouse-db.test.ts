// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
let db: PGlite;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const R1 = "aaaaaaaa-0000-4000-8000-000000000001";
const input = { config: { repetitions: 2, scenarios: ["control"] }, policies: [{ agentId: "a_1", policyHash: "p".repeat(64) }] };
const q = async (sql: string, p: any[] = []) => (await db.query<any>(sql, p)).rows;
const as = async (role: string, sub?: string) => { await db.exec(`reset role`); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [sub ?? ""]); await db.exec(`set role ${role}`); };
const claim = (owner = A, req = R1) => q("select (greenhouse_claim_run($1,$2,'greenhouse-rules-1',array['a_1'],$3::jsonb,'ih')).*", [owner, req, JSON.stringify(input)]).then((r) => r[0]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to anon,authenticated,service_role; grant usage on schema public to anon,authenticated,service_role;");
  await db.exec("create table public.agents(id text primary key, handle text not null); create table public.launch_proposals(id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), agent_handle text not null, name text not null, symbol text not null, tagline text default '', reason text default '', status text default 'pending');");
  await db.exec("grant all on all tables in schema public to anon,authenticated;"); // Supabase-like broad defaults
  await db.exec(await readFile(new URL("./sql/0011_greenhouse_trials.sql", import.meta.url), "utf8"));
  await db.exec("insert into agents values('a_1','rose'),('a_2','moss'); insert into launch_proposals(id,agent_handle,name,symbol,origin_agent_id,origin_policy_hash) values('bbbbbbbb-0000-4000-8000-000000000001','rose','Rose','ROSE','a_1','"+"p".repeat(64)+"'),('bbbbbbbb-0000-4000-8000-000000000002','moss','Moss','MOSS',null,null),('bbbbbbbb-0000-4000-8000-000000000003','nobody','X','XXX',null,null);");
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("greenhouse migration", () => {
  it("claims idempotently and recovers the same frozen inputs", async () => {
    await db.exec("reset role");
    const a = await claim(), b = await claim();
    expect(a.id).toBe(b.id); expect(b.status).toBe("running");
    expect((await q("select count(*)::int n from greenhouse_runs"))[0].n).toBe(1);
    await db.exec("update greenhouse_runs set claimed_at=now()-interval '5 minutes'");
    const c = await claim(); expect(c.attempts).toBe(2); expect(c.input).toEqual(input);
  });
  it("finalizes once; a different result or different inputs are refused", async () => {
    const r = await claim();
    await expect(q("select greenhouse_finalize_run($1,$2,'other','{}'::jsonb,'oh','ch')", [r.id, A])).rejects.toThrow("different inputs");
    await q("select greenhouse_finalize_run($1,$2,'ih','{}'::jsonb,'oh','ch')", [r.id, A]);
    await q("select greenhouse_finalize_run($1,$2,'ih','{}'::jsonb,'oh','ch')", [r.id, A]);
    await expect(q("select greenhouse_finalize_run($1,$2,'ih','{}'::jsonb,'zz','ch')", [r.id, A])).rejects.toThrow("different result");
    await expect(q("select greenhouse_finalize_run($1,$2,'ih','{}'::jsonb,'oh','ch')", [r.id, B])).rejects.toThrow("Unknown run");
  });
  it("gives up stuck runs after 3 attempts instead of leaving them running forever", async () => {
    const req = "aaaaaaaa-0000-4000-8000-000000000009";
    await claim(A, req);
    for (let i = 0; i < 3; i++) { await db.exec(`update greenhouse_runs set claimed_at=now()-interval '5 minutes' where request_id='${req}'`); await claim(A, req); }
    expect((await claim(A, req)).status).toBe("failed");
  });
  it("keeps private runs private, publishes explicitly, hides owner ids", async () => {
    const r = await claim();
    await as("anon"); expect(await q("select id from greenhouse_runs")).toHaveLength(0);
    await as("authenticated", B); expect(await q("select id from greenhouse_runs")).toHaveLength(0);
    await as("authenticated", A); expect((await q("select id from greenhouse_runs")).length).toBeGreaterThan(0);
    await expect(q("select owner_id from greenhouse_runs")).rejects.toThrow("permission denied");
    await db.exec("reset role");
    await expect(q("select greenhouse_set_published($1,$2,true)", [r.id, B])).rejects.toThrow("Only your own");
    await q("select greenhouse_set_published($1,$2,true)", [r.id, A]);
    await as("anon"); expect((await q("select id,output_hash from greenhouse_runs"))[0]).toMatchObject({ id: r.id, output_hash: "oh" });
    await db.exec("reset role"); await q("select greenhouse_set_published($1,$2,false)", [r.id, A]);
    await as("anon"); expect(await q("select id from greenhouse_runs")).toHaveLength(0);
  });
  it("denies writes, TRUNCATE and mutation RPCs to anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      await as(role, A);
      await expect(db.exec("insert into greenhouse_runs(owner_id,request_id,engine_version,agent_ids,input,input_hash) values(auth.uid(),gen_random_uuid(),'x','{}','{}','x')")).rejects.toThrow("permission denied");
      await expect(db.exec("update greenhouse_runs set published=true")).rejects.toThrow("permission denied");
      await expect(db.exec("delete from greenhouse_evidence")).rejects.toThrow("permission denied");
      await expect(db.exec("truncate greenhouse_runs cascade")).rejects.toThrow("permission denied");
      for (const f of ["greenhouse_claim_run(null,null,null,null,null,null)", "greenhouse_finalize_run(null,null,null,null,null,null)", "greenhouse_set_published(null,null,null)", "greenhouse_attach_evidence(null,null,null)", "greenhouse_fail_run(null,null,null)"])
        await expect(db.exec(`select ${f}`)).rejects.toThrow("permission denied");
    }
    await db.exec("reset role");
  });
  it("attaches per-reviewer evidence only for the originating agent, owner-scoped", async () => {
    await db.exec("reset role");
    const r = await claim();
    const e = (await q("select (greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000001',$2)).*", [A, r.id]))[0];
    expect(e).toMatchObject({ origin_agent_id: "a_1", run_policy_hash: "p".repeat(64), proposal_policy_hash: "p".repeat(64), repetitions: 2 });
    const again = (await q("select (greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000001',$2)).*", [A, r.id]))[0];
    expect(again.id).toBe(e.id);
    await expect(q("select greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000001',$2)", [B, r.id])).rejects.toThrow("Only your own");
    await expect(q("select greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000002',$2)", [A, r.id])).rejects.toThrow("does not include");
    await expect(q("select greenhouse_attach_evidence($1,'bbbbbbbb-0000-4000-8000-000000000003',$2)", [A, r.id])).rejects.toThrow("does not include");
    await as("authenticated", B); expect(await q("select id from greenhouse_evidence")).toHaveLength(0);
    await as("anon"); await expect(q("select id from greenhouse_evidence")).rejects.toThrow("permission denied");
    await as("authenticated", A); expect(await q("select id from greenhouse_evidence")).toHaveLength(1);
    await db.exec("reset role");
  });
  it("rate-limits claims per owner", async () => {
    await db.exec("reset role; update greenhouse_runs set status='done'");
    for (let i = 0; i < 40; i++) {
      const req = `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`;
      try { await claim(B, req); await db.exec(`update greenhouse_runs set status='done' where request_id='${req}'`); } catch (e) { expect(String(e)).toMatch(/limit/); expect(i).toBe(30); return; }
    }
    throw new Error("never limited");
  });
});
