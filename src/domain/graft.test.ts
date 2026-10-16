import { describe, expect, it } from "vitest";
import { BUNDLE_FORMAT, DISCLOSURE, agentVersion, agentVersionHash, draftHash, gate, hashOf, regressionCases, reportHash, runRegressions, validateDraft, verifyBundle, MANDATE_SCHEMA, REPORT_SCHEMA, type MandateDraft } from "./graft";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const POOL = "DwyTJxxgyA8KF2MS8Jnmw4PymX2NjvBjnnQjLjj1tG5r";
const agent = { id: "ag1", archetype: "gardener", risk: 3, handle: "rose", persona: "p", strategy: "s" };
const ver = agentVersion(agent, "model-x");
const draft = (o: Partial<MandateDraft> = {}): any => ({ schema: MANDATE_SCHEMA, agentId: "ag1", agentVersionHash: agentVersionHash(ver), cluster: "mainnet-beta", pool: { kind: "dbc", address: POOL }, tools: ["watchtower.dbc_pool"], expiresAt: "2026-10-17T12:00:00.000Z", budgets: { runsPerDay: 2, maxInflight: 1 }, evidenceTtlSecs: 300, requirements: { maxObservationAgeSecs: 120, requireSlot: true }, purchases: { services: [], currency: "USDC", maxAtomic: "0" }, note: "", ...o });

describe("graft mandate validation", () => {
  it("accepts a bounded read-only mandate", () => expect(validateDraft(draft(), NOW).pool.kind).toBe("dbc"));
  it("rejects unsupported capabilities, tools, past expiry, oversized budgets", () => {
    expect(() => validateDraft({ ...draft(), capabilities: ["swap"] }, NOW)).toThrow(/unsupported field/);
    expect(() => validateDraft(draft({ tools: ["wallet.transfer" as any] }), NOW)).toThrow(/unsupported tool/);
    expect(() => validateDraft(draft({ tools: ["damm_v2.pool_account"] }), NOW)).toThrow(/does not apply/);
    expect(() => validateDraft(draft({ expiresAt: "2026-10-16T11:00:00.000Z" }), NOW)).toThrow(/future/);
    expect(() => validateDraft(draft({ expiresAt: "2026-12-30T11:00:00.000Z" }), NOW)).toThrow(/30 days/);
    expect(() => validateDraft(draft({ budgets: { runsPerDay: 4, maxInflight: 1 } }), NOW)).toThrow(/runs per day/);
    expect(() => validateDraft(draft({ purchases: { services: ["botanist.report"], currency: "USDC", maxAtomic: "5000001" } }), NOW)).toThrow(/cap/);
    expect(() => validateDraft(draft({ pool: { kind: "dbc", address: "https://evil" } }), NOW)).toThrow(/Solana address/);
  });
  it("agent version hash changes with prompt/model/settings", () => {
    const h = agentVersionHash(ver);
    expect(agentVersionHash(agentVersion({ ...agent, persona: "p2" }, "model-x"))).not.toBe(h);
    expect(agentVersionHash(agentVersion(agent, "model-y"))).not.toBe(h);
    expect(agentVersionHash(agentVersion({ ...agent, risk: 4 }, "model-x"))).not.toBe(h);
  });
});

describe("gate + regression cases", () => {
  const d = validateDraft(draft(), NOW);
  const base = { draft: d, draftHash: draftHash(d), agentVersionHash: agentVersionHash(ver), now: NOW };
  it("every typed failure reproduces its expected deny outcome", () => {
    const r = runRegressions(regressionCases(base));
    expect(r.map((x) => [x.id, x.got])).toEqual([["baseline", "allow"], ["expired", "expired_mandate"], ["stale", "stale_proof"], ["no-slot", "stale_proof"], ["changed", "changed_config"], ["unavailable", "service_unavailable"], ["mismatch", "request_mismatch"], ["unsupported", "unsupported_pool"]]);
    expect(r.every((x) => x.pass)).toBe(true);
  });
  it("unknown agent version fails closed", () => {
    expect(gate({ mandate: { status: "active", expiresAt: d.expiresAt, draftHash: base.draftHash, agentVersionHash: base.agentVersionHash, draft: d }, currentAgentVersionHash: null, now: NOW })).toMatchObject({ allow: false, code: "changed_config" });
  });
  it("non-active status denies", () => {
    expect(gate({ mandate: { status: "suspended", expiresAt: d.expiresAt, draftHash: base.draftHash, agentVersionHash: base.agentVersionHash, draft: d }, currentAgentVersionHash: base.agentVersionHash, now: NOW })).toMatchObject({ code: "not_active" });
  });
});

describe("bundle verifier", () => {
  const d = validateDraft(draft(), NOW); const dh = draftHash(d); const vh = agentVersionHash(ver);
  const result = { stage: "curve", slot: 10 };
  const report = { schema: REPORT_SCHEMA, mandateId: "m1", draftHash: dh, agentVersionHash: vh, jobId: "j1", requestId: "r", inputHash: "a".repeat(64), generation: 1, observations: [{ tool: "watchtower.dbc_pool", slot: 10, result, resultHash: hashOf("fleuri.graft.observation-result/1", result) }], qualifications: [], note: "" };
  const rh = reportHash(report);
  const bundle = () => ({
    format: BUNDLE_FORMAT, mandate: { id: "m1", status: "revoked", draft: d, draftHash: dh, agentVersion: ver, agentVersionHash: vh, expiresAt: d.expiresAt, approvedAt: "2026-10-16T12:01:00.000Z", approvedHash: dh, createdAt: "2026-10-16T12:00:00.000Z" },
    events: [
      { kind: "created", from: null, to: "draft", at: "2026-10-16T12:00:00.000Z", detail: {} },
      { kind: "review", from: "draft", to: "review", at: "2026-10-16T12:00:30.000Z", detail: {} },
      { kind: "approved", from: "review", to: "active", at: "2026-10-16T12:01:00.000Z", detail: {} },
      { kind: "report", from: "active", to: "active", at: "2026-10-16T12:02:00.000Z", detail: { job: "j1", reportHash: rh } },
      { kind: "revoked", from: "active", to: "revoked", at: "2026-10-16T12:03:00.000Z", detail: {} },
    ],
    reports: [{ jobId: "j1", reportHash: rh, createdAt: "2026-10-16T12:02:00.000Z", report }], incidents: [], proposals: [], exportedAt: "2026-10-16T12:04:00.000Z", disclosure: DISCLOSURE,
  });
  it("verifies a consistent bundle", () => { const v = verifyBundle(JSON.stringify(bundle())); expect(v.checks.filter((c) => c.status !== "pass")).toEqual([]); expect(v.valid).toBe(true); });
  it("rejects duplicate keys, non-finite numbers, unknown fields and unsupported versions", () => {
    expect(verifyBundle(JSON.stringify(bundle()).replace('"format"', '"format":"x","format"')).valid).toBe(false);
    expect(verifyBundle(JSON.stringify(bundle()).replace('"generation":1', '"generation":1e999')).valid).toBe(false);
    expect(verifyBundle(JSON.stringify({ ...bundle(), extra: 1 })).valid).toBe(false);
    const u = verifyBundle(JSON.stringify({ ...bundle(), format: "fleuri.graft.bundle/9" }));
    expect(u.valid).toBe(false); expect(u.checks.some((c) => c.status === "unsupported")).toBe(true);
  });
  it("detects hash, version, history and report tampering", () => {
    const t1 = bundle(); (t1.mandate.draft as any).budgets.runsPerDay = 3; expect(verifyBundle(JSON.stringify(t1)).checks.find((c) => c.id === "draft")!.status).toBe("fail");
    const t2 = bundle(); (t2.mandate.agentVersion as any).modelId = "other"; expect(verifyBundle(JSON.stringify(t2)).checks.find((c) => c.id === "version")!.status).toBe("fail");
    const t3 = bundle(); t3.events.splice(1, 1); expect(verifyBundle(JSON.stringify(t3)).checks.find((c) => c.id === "history")!.status).toBe("fail");
    const t4 = bundle(); (t4.reports[0].report.observations[0].result as any).stage = "graduated"; expect(verifyBundle(JSON.stringify(t4)).valid).toBe(false);
    const t5 = bundle(); t5.mandate.status = "active"; expect(verifyBundle(JSON.stringify(t5)).checks.find((c) => c.id === "history")!.status).toBe("fail");
  });
});
