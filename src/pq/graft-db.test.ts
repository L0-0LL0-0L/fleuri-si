// @vitest-environment node
// Real-SQL tests of Graft 0022 through the server orchestration (PGlite, controllable clock in an isolated DB).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { graftDb } from "@/test/pglite-graft";
import * as G from "@/lib/graft.server";

const M = vi.hoisted(() => ({ model: "model-x" }));
vi.mock("@/lib/ai.server", () => ({ get AI_MODEL() { return M.model; } }));
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const POOL = "DwyTJxxgyA8KF2MS8Jnmw4PymX2NjvBjnnQjLjj1tG5r";
const rid = () => crypto.randomUUID();
let db: Awaited<ReturnType<typeof graftDb>>;
let clockMs = 0;
const clock = () => clockMs;
const okObs: G.Observer = async () => ({ ok: true, fetchedAt: new Date(clockMs - 1000).toISOString(), slot: 123, cluster: "mainnet-beta", genesisHash: "g", result: { stage: "curve" }, qualifications: [{ id: "dbc_owner", label: "x", status: "met", detail: "" }] });
const terms = (o: Partial<G.Terms> = {}): G.Terms => ({ agentId: "ag1", poolKind: "dbc", pool: POOL, tools: ["watchtower.dbc_pool"], hours: 24, runsPerDay: 3, evidenceTtlSecs: 300, maxObservationAgeSecs: 120, purchaseService: "botanist.report", purchaseMaxAtomic: "1000000", note: "", ...o });

async function activeMandate(owner = A) {
  const c = await G.createDraft(db, owner, { requestId: rid(), terms: terms() }, okObs, clockMs);
  await G.transition(db, owner, c.id, "review");
  const r = await G.approve(db, owner, c.id, c.draftHash, okObs, clock);
  expect(r.status).toBe("active");
  return c;
}

beforeEach(async () => {
  M.model = "model-x";
  db = await graftDb();
  clockMs = (await db.now()).getTime();
  await db.pg.exec(`insert into public.agents(id,handle,archetype,risk,owner_id) values ('ag1','rose','gardener',3,'${A}'),('ag2','moss','gardener',3,'${B}')`);
});

describe("graft SQL", () => {
  it("only owners can draft for their agents; RLS hides other owners; client roles cannot write", async () => {
    await expect(G.createDraft(db, B, { requestId: rid(), terms: terms() }, okObs, clockMs)).rejects.toThrow(/own agents/);
    const c = await G.createDraft(db, A, { requestId: rid(), terms: terms() }, okObs, clockMs);
    await db.pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    expect((await db.pg.query("select * from public.graft_mandates")).rows.length).toBe(0);
    await expect(db.pg.query("update public.graft_mandates set status='active'")).rejects.toThrow();
    await expect(db.pg.query(`select public.graft_transition('${A}','${c.id}','review')`)).rejects.toThrow(/permission/);
    await db.pg.exec(`select set_config('request.jwt.claim.sub','${A}',false);`);
    expect((await db.pg.query("select * from public.graft_mandates")).rows.length).toBe(1);
    await db.pg.exec("reset role;");
    await db.pg.exec("set role anon;");
    await expect(db.pg.query("select * from public.graft_mandates")).rejects.toThrow();
    await db.pg.exec("reset role;");
  });

  it("approval binds the reviewed draft hash; retry with a changed draft is a mismatch; terms are immutable", async () => {
    const req = rid();
    const c = await G.createDraft(db, A, { requestId: req, terms: terms() }, okObs, clockMs);
    await expect(G.createDraft(db, A, { requestId: req, terms: terms({ runsPerDay: 1 }) }, okObs, clockMs)).rejects.toThrow(/different terms/);
    expect((await G.createDraft(db, A, { requestId: req, terms: terms() }, okObs, clockMs)).created).toBe(false);
    await expect(G.approve(db, A, c.id, c.draftHash, okObs, clock)).rejects.toThrow(/only a mandate in review/);
    await G.transition(db, A, c.id, "review");
    await expect(G.approve(db, A, c.id, "f".repeat(64), okObs, clock)).rejects.toThrow(/different draft/);
    await expect(db.pg.query(`update public.graft_mandates set draft = '{}'::jsonb where id = '${c.id}'`)).rejects.toThrow(/immutable/);
    expect((await G.approve(db, A, c.id, c.draftHash, okObs, clock)).status).toBe("active");
    await expect(db.pg.query(`delete from public.graft_events`)).rejects.toThrow(/append-only/);
  });

  it("agent config change suspends review/active mandates atomically; changed config at approval is denied", async () => {
    const c = await activeMandate();
    const c2 = await G.createDraft(db, A, { requestId: rid(), terms: terms() }, okObs, clockMs);
    await G.transition(db, A, c2.id, "review");
    await db.pg.exec("update public.agents set cash = 5 where id = 'ag1'"); // unrelated column: no effect
    expect((await G.getMandate(db, c.id)).status).toBe("active");
    await db.pg.exec("update public.agents set persona = 'new prompt' where id = 'ag1'");
    expect((await G.getMandate(db, c.id)).status).toBe("suspended");
    expect((await G.getMandate(db, c2.id)).status).toBe("suspended");
    expect((await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock))).toMatchObject({ status: "denied", code: "not_active" });
    await expect(G.transition(db, A, c.id, "review")).rejects.toThrow(/cannot move/); // no self-reactivation
  });

  it("runs a bounded job, commits a frozen report, replays the same request, and rejects a changed retry body", async () => {
    const c = await activeMandate();
    const req = rid();
    const r = await G.run(db, A, { mandateId: c.id, requestId: req }, okObs, clock);
    expect(r.status).toBe("done");
    expect(await G.run(db, A, { mandateId: c.id, requestId: req }, okObs, clock)).toMatchObject({ status: "done" });
    const rows = (await db.pg.query<any>("select report, report_hash from public.graft_reports")).rows;
    expect(rows.length).toBe(1);
    expect(G.toBundle).toBeTypeOf("function");
    const d = await G.detail(db, c.id, A);
    const { verifyBundle } = await import("@/domain/graft");
    const v = verifyBundle(JSON.stringify(G.toBundle(d!)));
    expect(v.checks.filter((x) => x.status !== "pass")).toEqual([]);
    expect(await G.detail(db, c.id, B)).toBeNull(); // private by default
    await G.setShared(db, A, c.id, true);
    const pub = await G.detail(db, c.id, null);
    expect(pub!.jobs).toEqual([]); expect((pub!.mandate as any).owner_id).toBeUndefined();
  });

  it("stale or unknown observations, unavailable service and unsupported pools fail closed with sanitized incidents", async () => {
    const c = await activeMandate();
    const stale: G.Observer = async () => ({ ok: true, fetchedAt: new Date(clockMs - 600_000).toISOString(), slot: 1, cluster: "m", genesisHash: "g", result: {}, qualifications: [] });
    const noSlot: G.Observer = async () => ({ ok: true, fetchedAt: new Date(clockMs).toISOString(), slot: 0, cluster: "m", genesisHash: "g", result: {}, qualifications: [] });
    const down: G.Observer = async () => ({ ok: false, reason: "unavailable", detail: "fetch https://secret-rpc.example/key=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ failed" });
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, stale, clock)).toMatchObject({ code: "stale_proof" });
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, noSlot, clock)).toMatchObject({ code: "stale_proof" });
    clockMs += 0;
    await db.pg.exec("update public.graft_jobs set day = day - 1"); // isolated test: free daily budget
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, down, clock)).toMatchObject({ code: "service_unavailable" });
    const inc = (await db.pg.query<any>("select code, detail from public.graft_incidents order by at")).rows;
    expect(inc.map((i) => i.code)).toEqual(["stale_proof", "stale_proof", "service_unavailable"]);
    expect(inc[2].detail).not.toMatch(/secret-rpc|abcdefghijklmnop/);
    expect((await db.pg.query("select * from public.graft_reports")).rows.length).toBe(0);
    await expect(G.createDraft(db, A, { requestId: rid(), terms: terms() }, async () => ({ ok: false, reason: "unsupported_pool", detail: "x" }), clockMs)).rejects.toThrow(/not a supported DBC pool/);
  });

  it("expired mandate refuses runs; expiry reached mid-run denies the late commit", async () => {
    const c = await G.createDraft(db, A, { requestId: rid(), terms: terms({ hours: 1 }) }, okObs, clockMs);
    await G.transition(db, A, c.id, "review"); await G.approve(db, A, c.id, c.draftHash, okObs, clock);
    await db.advance(3590); clockMs += 3590_000;
    const slow: G.Observer = async () => { await db.advance(20); clockMs += 20_000; return okObs("watchtower.dbc_pool", POOL); };
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, slow, clock)).toMatchObject({ status: "denied", code: "expired_mandate" });
    expect((await db.pg.query("select * from public.graft_reports")).rows.length).toBe(0);
    expect((await G.getMandate(db, c.id)).status).toBe("expired");
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock)).toMatchObject({ code: "not_active" });
  });

  it("SQL commit fence rejects a report after expiry even if the worker skips its own gate", async () => {
    const c = await G.createDraft(db, A, { requestId: rid(), terms: terms({ hours: 1 }) }, okObs, clockMs);
    await G.transition(db, A, c.id, "review"); await G.approve(db, A, c.id, c.draftHash, okObs, clock);
    const m = await G.getMandate(db, c.id); const req = rid();
    const { hashOf, reportHash } = await import("@/domain/graft");
    const input = { schema: "fleuri.graft.job-input/1", mandateId: m.id, draftHash: m.draft_hash, pool: m.draft.pool, tools: m.draft.tools, requestId: req };
    const ih = hashOf("fleuri.graft.job-input/1", input);
    await db.advance(3570);
    const cl = (await db.rpc("graft_claim_job_v2", { _owner: A, _mandate: c.id, _request: req, _input: input, _input_hash: ih, _agent_version_hash: m.agent_version_hash, _owner_limit: 6, _max_inflight: 2, _lease_secs: 60 })).data;
    await db.advance(40);
    const rep = { mandateId: m.id, draftHash: m.draft_hash, agentVersionHash: m.agent_version_hash, inputHash: ih };
    const r = (await db.rpc("graft_commit_report_v2", { _owner: A, _job: cl.job, _lease: cl.lease, _report: rep, _report_hash: reportHash(rep), _agent_version_hash: m.agent_version_hash, _observed_at: (await db.now()).toISOString() })).data;
    expect(r.denied).toBe("expired_mandate");
    expect((await db.pg.query("select * from public.graft_reports")).rows.length).toBe(0);
  });

  it("leases fence workers: a live lease is busy, an expired lease is reclaimed with stored input, the old worker cannot commit", async () => {
    const c = await activeMandate();
    const req = rid();
    const m = await G.getMandate(db, c.id);
    const input = { schema: "fleuri.graft.job-input/1", mandateId: m.id, draftHash: m.draft_hash, pool: m.draft.pool, tools: m.draft.tools, requestId: req };
    const { hashOf } = await import("@/domain/graft");
    const ih = hashOf("fleuri.graft.job-input/1", input);
    const claim = (await db.rpc("graft_claim_job_v2", { _owner: A, _mandate: c.id, _request: req, _input: input, _input_hash: ih, _agent_version_hash: m.agent_version_hash, _owner_limit: 6, _max_inflight: 2, _lease_secs: 60 })).data;
    expect(claim.status).toBe("claimed");
    expect(await G.run(db, A, { mandateId: c.id, requestId: req }, okObs, clock)).toMatchObject({ status: "busy" });
    await db.advance(61); clockMs += 61_000;
    const r = await G.run(db, A, { mandateId: c.id, requestId: req }, okObs, clock);
    expect(r.status).toBe("done");
    const late = await db.rpc("graft_commit_report_v2", { _owner: A, _job: claim.job, _lease: claim.lease, _report: {}, _report_hash: "a".repeat(64), _agent_version_hash: m.agent_version_hash, _observed_at: (await db.now()).toISOString() });
    expect(late.data?.status === "done" || /lease_lost/.test(late.error?.message ?? "")).toBe(true);
    expect((await db.pg.query("select * from public.graft_reports")).rows.length).toBe(1);
  });

  it("enforces per-mandate daily budget, owner inflight cap and owner daily compute; budgets cannot self-expand", async () => {
    const c = await activeMandate();
    for (let i = 0; i < 3; i++) expect((await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock)).status).toBe("done");
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock)).toMatchObject({ code: "quota_exceeded" });
    const c2 = await activeMandate(); const c3 = await activeMandate();
    const m2 = await G.getMandate(db, c2.id);
    const { hashOf } = await import("@/domain/graft");
    const claim = async (mid: string) => { const m = await G.getMandate(db, mid); const req = rid(); const input = { schema: "fleuri.graft.job-input/1", mandateId: m.id, draftHash: m.draft_hash, pool: m.draft.pool, tools: m.draft.tools, requestId: req }; return (await db.rpc("graft_claim_job_v2", { _owner: A, _mandate: mid, _request: req, _input: input, _input_hash: hashOf("fleuri.graft.job-input/1", input), _agent_version_hash: m.agent_version_hash, _owner_limit: 6, _max_inflight: 2, _lease_secs: 60 })).data; };
    expect((await claim(c2.id)).status).toBe("claimed");
    expect((await claim(c2.id)).status).toBe("claimed");
    expect((await claim(c3.id)).denied).toBe("quota_exceeded"); // 2 inflight
    await db.advance(61);
    expect((await claim(c3.id)).status).toBe("claimed"); // 6th job today
    expect((await claim(c3.id)).denied).toBe("quota_exceeded"); // owner daily cap
    expect(m2.draft.budgets.runsPerDay).toBe(3);
  });

  it("purchase proposals never grant payment; caps, allowlist and mandate binding enforced", async () => {
    const c = await activeMandate();
    await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock);
    const base = { mandateId: c.id, service: "botanist.report" as const, mint: POOL, minutes: 60, purpose: "deep report" };
    await expect(G.propose(db, A, { ...base, requestId: rid(), maxAtomic: "2000000" })).rejects.toThrow(/cap/);
    const p = await G.propose(db, A, { ...base, requestId: rid(), maxAtomic: "500000" });
    const row = (await db.pg.query<any>(`select proposal_hash from public.graft_proposals where id = '${p.id}'`)).rows[0];
    await expect(G.decide(db, A, p.id, "0".repeat(64), true)).rejects.toThrow(/does not match/);
    await expect(G.decide(db, B, p.id, row.proposal_hash, true)).rejects.toThrow(/not found/);
    expect((await G.decide(db, A, p.id, row.proposal_hash, true)).status).toBe("approved_awaiting_wallet_payment");
    await expect(db.pg.query(`update public.graft_proposals set status = 'paid'`)).rejects.toThrow();
  });

  it("same request id + body after time passes recovers the stored draft and proposal; changed terms reject", async () => {
    const req = rid();
    const c = await G.createDraft(db, A, { requestId: req, terms: terms() }, okObs, clockMs);
    const fail: G.Observer = async () => { throw new Error("must not read the pool on recovery"); };
    const again = await G.createDraft(db, A, { requestId: req, terms: terms() }, fail, clockMs + 90_000);
    expect(again).toMatchObject({ id: c.id, created: false, draftHash: c.draftHash });
    await expect(G.createDraft(db, A, { requestId: req, terms: terms({ note: "x" }) }, fail, clockMs + 90_000)).rejects.toThrow(/different terms/);
    await G.transition(db, A, c.id, "review"); await G.approve(db, A, c.id, c.draftHash, okObs, clock);
    await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock);
    const preq = rid(); const pb = { mandateId: c.id, requestId: preq, service: "botanist.report" as const, mint: POOL, maxAtomic: "1000", minutes: 60, purpose: "p" };
    const p1 = await G.propose(db, A, pb, clockMs);
    expect(await G.propose(db, A, pb, clockMs + 120_000)).toMatchObject({ id: p1.id, created: false });
    await expect(G.propose(db, A, { ...pb, maxAtomic: "2000" }, clockMs)).rejects.toThrow(/different proposal/);
  });

  it("approval needs fresh qualified evidence; stale, unknown or unqualified evidence denies", async () => {
    const c = await G.createDraft(db, A, { requestId: rid(), terms: terms() }, okObs, clockMs);
    await G.transition(db, A, c.id, "review");
    const stale: G.Observer = async () => ({ ok: true, fetchedAt: new Date(clockMs - 3600_000).toISOString(), slot: 9, cluster: "mainnet-beta", genesisHash: "g", result: {}, qualifications: [{ id: "dbc_owner", label: "", status: "met", detail: "" }] });
    const unq: G.Observer = async () => ({ ok: true, fetchedAt: new Date(clockMs).toISOString(), slot: 9, cluster: "mainnet-beta", genesisHash: "g", result: {}, qualifications: [{ id: "dbc_owner", label: "", status: "unknown", detail: "" }] });
    await expect(G.approve(db, A, c.id, c.draftHash, stale, clock)).rejects.toThrow(/stale/);
    await expect(G.approve(db, A, c.id, c.draftHash, unq, clock)).rejects.toThrow(/program check/);
    await expect(G.approve(db, A, c.id, c.draftHash, async () => ({ ok: false, reason: "unavailable", detail: "" }), clock)).rejects.toThrow(/could not be fetched/);
    // SQL refuses a forged old proof even if the server check were bypassed
    const m = await G.getMandate(db, c.id);
    const r = await db.rpc("graft_approve_v2", { _owner: A, _id: c.id, _draft_hash: m.draft_hash, _agent_version_hash: m.agent_version_hash, _expires: m.expires_at, _agent_version: m.agent_version, _proof: { draftHash: m.draft_hash }, _proof_hash: "a".repeat(64), _proof_fetched_at: new Date(clockMs - 3600_000).toISOString() });
    expect(r.error?.message).toMatch(/stale_proof/);
    expect((await G.getMandate(db, c.id)).status).toBe("review");
    expect((await G.approve(db, A, c.id, c.draftHash, okObs, clock)).status).toBe("active");
    expect((await G.getMandate(db, c.id)).approval_proof_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("server code version change (model) blocks commit, proposals and decisions, and expires approved proposals", async () => {
    const c = await activeMandate();
    await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock);
    const p = await G.propose(db, A, { mandateId: c.id, requestId: rid(), service: "botanist.report", mint: POOL, maxAtomic: "1000", minutes: 60, purpose: "p" }, clockMs);
    const h = (await db.pg.query<any>(`select proposal_hash from public.graft_proposals where id='${p.id}'`)).rows[0].proposal_hash;
    expect((await G.decide(db, A, p.id, h, true)).status).toBe("approved_awaiting_wallet_payment");
    // model changes mid-run: commit must refuse
    const slow: G.Observer = async (t, a) => { M.model = "model-y"; return okObs(t, a); };
    expect(await G.run(db, A, { mandateId: c.id, requestId: rid() }, slow, clock)).toMatchObject({ status: "denied", code: "changed_config" });
    expect((await G.getMandate(db, c.id)).status).toBe("suspended");
    expect((await db.pg.query<any>(`select status from public.graft_proposals where id='${p.id}'`)).rows[0].status).toBe("expired");
    await expect(G.propose(db, A, { mandateId: c.id, requestId: rid(), service: "botanist.report", mint: POOL, maxAtomic: "1000", minutes: 60, purpose: "p" }, clockMs)).rejects.toThrow(/not_active/);
  });

  it("decision under a changed code version suspends instead of approving; revoke expires approved proposals", async () => {
    const c = await activeMandate();
    await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock);
    const mk = async () => { const p = await G.propose(db, A, { mandateId: c.id, requestId: rid(), service: "botanist.report", mint: POOL, maxAtomic: "1000", minutes: 60, purpose: "p" }, clockMs); return { id: p.id, h: (await db.pg.query<any>(`select proposal_hash from public.graft_proposals where id='${p.id}'`)).rows[0].proposal_hash }; };
    const a = await mk();
    M.model = "model-z";
    expect(await G.decide(db, A, a.id, a.h, true)).toMatchObject({ denied: "changed_config" });
    expect((await db.pg.query<any>(`select status from public.graft_proposals where id='${a.id}'`)).rows[0].status).toBe("expired");
    M.model = "model-x";
    const c2 = await activeMandate(); await G.run(db, A, { mandateId: c2.id, requestId: rid() }, okObs, clock);
    const p2 = await G.propose(db, A, { mandateId: c2.id, requestId: rid(), service: "botanist.report", mint: POOL, maxAtomic: "1000", minutes: 60, purpose: "p" }, clockMs);
    const h2 = (await db.pg.query<any>(`select proposal_hash from public.graft_proposals where id='${p2.id}'`)).rows[0].proposal_hash;
    await G.decide(db, A, p2.id, h2, true);
    await G.transition(db, A, c2.id, "revoked");
    expect((await db.pg.query<any>(`select status from public.graft_proposals where id='${p2.id}'`)).rows[0].status).toBe("expired");
  });

  it("proposals need a report within the evidence TTL", async () => {
    const c = await activeMandate();
    await expect(G.propose(db, A, { mandateId: c.id, requestId: rid(), service: "botanist.report", mint: POOL, maxAtomic: "1000", minutes: 60, purpose: "p" }, clockMs)).rejects.toThrow(/run the steward first/);
  });

  it("incidents capture typed gate snapshots that replay to the same code; bundles verify and detect history edits", async () => {
    const c = await activeMandate();
    const stale: G.Observer = async () => ({ ok: true, fetchedAt: new Date(clockMs - 600_000).toISOString(), slot: 1, cluster: "mainnet-beta", genesisHash: "g", result: {}, qualifications: [] });
    await G.run(db, A, { mandateId: c.id, requestId: rid() }, stale, clock);
    await G.run(db, A, { mandateId: c.id, requestId: rid() }, okObs, clock);
    const d = (await G.detail(db, c.id, A))!;
    const cap = d.regressions.filter((r: any) => r.source === "incident snapshot");
    expect(cap).toHaveLength(1); expect(cap[0]).toMatchObject({ expected: "stale_proof", got: "stale_proof", pass: true });
    const { verifyBundle } = await import("@/domain/graft");
    const b = G.toBundle(d);
    const v = verifyBundle(JSON.stringify(b));
    expect(v.checks.filter((x) => x.status !== "pass")).toEqual([]);
    const t = JSON.parse(JSON.stringify(b)); t.incidents[0].detail = "edited"; 
    expect(verifyBundle(JSON.stringify(t)).checks.find((x) => x.id === "root")!.status).toBe("fail");
    const t2 = JSON.parse(JSON.stringify(b)); t2.incidents[0].gateCase.now = 0;
    expect(verifyBundle(JSON.stringify(t2)).valid).toBe(false);
  });
});
