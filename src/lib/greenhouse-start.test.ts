import { describe, expect, it, vi } from "vitest";
import * as G from "@/domain/greenhouse";
import { buildSeed } from "@/domain/seed";
import { startTrial } from "./greenhouse-start";

const NOW = 1_800_000_000_000;
const OWNER = "11111111-1111-4111-8111-111111111111", REQ = "aaaaaaaa-0000-4000-8000-000000000001";
const s = buildSeed(NOW);
const agents = Object.values(s.agents).slice(0, 2);
const cfg = { agentIds: agents.map((a) => a.id), seed: 3, repetitions: 1, cycles: 5, scenarios: ["control"] as G.Scenario[] };
const input = G.makeInput(cfg, G.freezeMarket(s, NOW), agents.map(G.snapshotPolicy));
const ih = G.inputHash(input);

function fakeDb(opts: { stored?: any; claim?: any; finErr?: string }) {
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === "greenhouse_claim_lease") return { data: opts.claim ?? { id: "run1", status: "running", acquired: true, lease: "L1", attempts: 1, input: args._input, input_hash: args._input_hash }, error: null };
    if (name === "greenhouse_finalize_lease") return opts.finErr ? { data: null, error: { message: opts.finErr } } : { data: { id: "run1", status: "done" }, error: null };
    return { data: { applied: true }, error: null };
  });
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: opts.stored ?? null, error: null }) };
  return { from: vi.fn(() => chain), rpc };
}
const names = (db: any) => db.rpc.mock.calls.map((c: any[]) => c[0]);

describe("ghStart orchestration", () => {
  it("fresh request: reads live once, claims, computes and finalizes with the lease", async () => {
    const db = fakeDb({}); const live = vi.fn(async () => s);
    const r = await startTrial(G, db, OWNER, { requestId: REQ, config: cfg }, live);
    expect(r).toMatchObject({ ok: true, data: { status: "done" } });
    expect(live).toHaveBeenCalledTimes(1);
    expect(names(db)).toEqual(["greenhouse_claim_lease", "greenhouse_finalize_lease"]);
    expect(db.rpc.mock.calls[1][1]._lease).toBe("L1");
  });
  it("recovery uses the stored request without any live garden read, even if agents were deleted", async () => {
    const stored = { id: "run1", status: "running", input, input_hash: ih };
    const db = fakeDb({ stored }); const live = vi.fn(async () => { throw new Error("garden unavailable"); });
    const r = await startTrial(G, db, OWNER, { requestId: REQ, config: { ...cfg, agentIds: [...cfg.agentIds].reverse() } }, live);
    expect(r.ok).toBe(true); expect(live).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls[0][1]._input).toBe(input);
  });
  it("not acquired (lease held elsewhere): returns running and never simulates", async () => {
    const spy = vi.spyOn(G, "runTrial");
    const db = fakeDb({ stored: { id: "run1", status: "running", input, input_hash: ih }, claim: { id: "run1", status: "running", acquired: false, lease: null, attempts: 1 } });
    const r = await startTrial(G, db, OWNER, { requestId: REQ, config: cfg }, async () => s);
    expect(r).toMatchObject({ ok: true, data: { status: "running" } });
    expect(names(db)).toEqual(["greenhouse_claim_lease"]);
    spy.mockRestore();
  });
  it("conflicting settings for the same request id are rejected before any write", async () => {
    const db = fakeDb({ stored: { id: "run1", status: "done", input, input_hash: ih } });
    const r = await startTrial(G, db, OWNER, { requestId: REQ, config: { ...cfg, seed: 4 } }, async () => s);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/different trial settings/) });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("terminal rows are returned as-is", async () => {
    const db = fakeDb({ stored: { id: "run1", status: "failed", input, input_hash: ih } });
    expect(await startTrial(G, db, OWNER, { requestId: REQ, config: cfg }, async () => s)).toMatchObject({ ok: true, data: { status: "failed" } });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("an old-engine stored run is failed with the lease token, never relabelled and recomputed", async () => {
    const old = { ...input, engineVersion: "greenhouse-rules-1" };
    const db = fakeDb({ stored: { id: "run1", status: "running", input: old, input_hash: ih } });
    const r = await startTrial(G, db, OWNER, { requestId: REQ, config: cfg }, async () => s);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported engine/) });
    expect(names(db)).toEqual(["greenhouse_claim_lease", "greenhouse_fail_lease"]);
    expect(db.rpc.mock.calls[1][1]._lease).toBe("L1");
  });
  it("stored checksum mismatch fails the run under the lease", async () => {
    const db = fakeDb({ stored: { id: "run1", status: "running", input, input_hash: "0".repeat(64) } });
    const r = await startTrial(G, db, OWNER, { requestId: REQ, config: cfg }, async () => s);
    expect(r.ok).toBe(false); expect(names(db)).toContain("greenhouse_fail_lease");
  });
  it("a stale-lease finalize refusal surfaces as an error without a fail write", async () => {
    const db = fakeDb({ finErr: "Stale worker: this trial lease belongs to another attempt." });
    await expect(startTrial(G, db, OWNER, { requestId: REQ, config: cfg }, async () => s)).rejects.toThrow(/Stale worker/);
    expect(names(db)).not.toContain("greenhouse_fail_lease");
  });
});
