// @vitest-environment node
// The REAL endpoint handlers (gardenCommand "run", ghStart, accessRedeemReport) with createServerFn stubbed
// to call the handler directly and the access ledger on PGlite: quotas are enforced server-side at each route.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessDb, readyChecks } from "@/test/pglite-access";

const m = vi.hoisted(() => ({ deps: null as any, mutate: vi.fn(), start: vi.fn(), build: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => { const b: any = { v: null, middleware: () => b, inputValidator: (v: any) => { b.v = v; return b; }, handler: (h: any) => (o: any) => h({ data: b.v ? b.v(o.data) : o.data, context: o.context }) }; return b; },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ get supabaseAdmin() { return m.deps.db; } }));
vi.mock("./access.server", async (orig) => ({ ...(await orig<any>()), defaultDeps: async () => m.deps }));
vi.mock("./garden.server", () => ({
  ensureOwner: async () => false, peekGarden: async () => ({ agents: { a_1: { id: "a_1", handle: "rose", status: "active", ownerId: OWNER } } }),
  mutateGarden: (...a: any[]) => m.mutate(...a), recordLaunchProposal: async () => {}, DuplicateCycleError: class extends Error {}, ConflictError: class extends Error {},
}));
vi.mock("@/domain/engine", () => ({ assertOwner: (s: any, _u: string, id: string) => s.agents[id] }));
vi.mock("./greenhouse-start", () => ({ startTrial: (...a: any[]) => m.start(...a) }));
vi.mock("./botanist.server", () => ({ reportDeps: () => ({}) }));
vi.mock("./botanist-report", () => ({ buildReport: (...a: any[]) => m.build(...a) }));

const OWNER = "11111111-1111-4111-8111-111111111111";
import { gardenCommand } from "./garden.functions";
import { ghStart } from "./greenhouse.functions";
import { accessRedeemReport } from "./access.functions";
import { ACCESS_POLICY } from "@/pq/access";

let db: Awaited<ReturnType<typeof accessDb>>; let staked = false;
const ctx = { userId: OWNER, supabase: {} };
const count = async (action: string) => (await db.pg.query<any>("select count(*)::int n from access_reservations where action=$1 and status in ('reserved','consumed')", [action])).rows[0].n;
beforeEach(async () => {
  db = await accessDb(); staked = false;
  await db.pg.query("insert into owners values($1,'WalletA111111111111111111111111111111111111',true)", [OWNER]);
  m.deps = { db, derivePosition: () => "pos", readStaking: vi.fn(async (w: string) => staked
    ? { cluster: "mainnet-beta", programId: "P", checks: readyChecks(), slot: 1, pool: { address: "POOL" }, position: { address: "pos", owner: w, pool: "POOL", active: "1", pendingAmount: "0" } }
    : { cluster: "mainnet-beta", programId: null, checks: readyChecks({ configured: false }), pool: null, position: null }) };
  m.mutate.mockReset().mockResolvedValue({ decision: "hold", error: null, proposal: null });
  m.start.mockReset().mockResolvedValue({ ok: true, data: { id: "run", status: "done", recovered: false } });
  m.build.mockReset().mockResolvedValue({ facts: {} });
}, 30_000);

describe("gardenCommand run (owner cycles)", () => {
  it("meters each cycle server-side; a repeated bucket never runs twice; beyond the free allowance it locks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-13T00:00:01Z"));
    try {
      const run = () => (gardenCommand as any)({ data: { type: "run", agentId: "a_1", useAi: false }, context: ctx });
      expect((await run()).ok).toBe(true);
      expect((await run()).message).toMatch(/already ran/); // same 5 s bucket
      expect(m.mutate).toHaveBeenCalledTimes(1);
      await db.pg.exec(`insert into access_reservations(owner_id,action,request_key,day,tier,status) select '${OWNER}','owner_cycle','fill-key-'||g,(now() at time zone 'utc')::date,'base','consumed' from generate_series(1,${ACCESS_POLICY.owner_cycle.base}) g`);
      vi.setSystemTime(new Date("2026-10-13T00:00:11Z"));
      const r = await run();
      expect(r.ok).toBe(false); expect(r.message).toMatch(/Pollen Access/);
      expect(m.mutate).toHaveBeenCalledTimes(1);
      staked = true; vi.setSystemTime(new Date("2026-10-13T00:00:21Z"));
      expect((await run()).ok).toBe(true); expect(m.mutate).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("refunds the unit when the cycle commit fails", async () => {
    m.mutate.mockRejectedValueOnce(new Error("Cloud commit failed"));
    await expect((gardenCommand as any)({ data: { type: "run", agentId: "a_1", useAi: false }, context: ctx })).rejects.toThrow();
    expect(await count("owner_cycle")).toBe(0);
  });
});

describe("ghStart (Greenhouse)", () => {
  const cfg = (o: any = {}) => ({ agentIds: ["a_1"], seed: 1, repetitions: 2, cycles: 30, scenarios: ["control"], ...o });
  it("free trials stay unmetered", async () => {
    expect((await (ghStart as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000001", config: cfg() }, context: ctx })).ok).toBe(true);
    expect(await count("deep_trial")).toBe(0);
  });
  it("deep trials lock without stake (no compute), and spend once per request when staked", async () => {
    const deep = { requestId: "aaaaaaaa-0000-4000-8000-000000000002", config: cfg({ repetitions: 8, cycles: 100 }) };
    const r = await (ghStart as any)({ data: deep, context: ctx });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/Pollen Access/); expect(m.start).not.toHaveBeenCalled();
    staked = true;
    expect((await (ghStart as any)({ data: deep, context: ctx })).ok).toBe(true);
    expect((await (ghStart as any)({ data: deep, context: ctx })).ok).toBe(true); // recovery replay is free
    expect(await count("deep_trial")).toBe(1);
  });
  it("rejects configs over the deep compute budget at the endpoint", async () => {
    staked = true;
    await expect((ghStart as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000003", config: cfg({ agentIds: ["a", "b", "c", "d"], repetitions: 10, cycles: 120, scenarios: ["control", "sell_pressure"] }) }, context: ctx })).rejects.toThrow();
    expect(m.start).not.toHaveBeenCalled();
  });
});

describe("accessRedeemReport", () => {
  it("is locked while staking isn't ready and builds nothing", async () => {
    const r = await (accessRedeemReport as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000009", mint: "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri" }, context: ctx });
    expect(r.ok).toBe(false); expect(r.kind).toBe("locked"); expect(r.blockers.join(" ")).toMatch(/configured/);
    expect(m.build).not.toHaveBeenCalled();
  });
});
