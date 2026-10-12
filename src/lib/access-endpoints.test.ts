// @vitest-environment node
// The REAL endpoint handlers (gardenCommand "run", ghStart, accessRedeemReport) with createServerFn stubbed
// to call the handler directly and the access ledger on PGlite: quotas are enforced server-side at each route.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessDb, readyChecks } from "@/test/pglite-access";

const m = vi.hoisted(() => ({ deps: null as any, mutate: vi.fn(), start: vi.fn(), build: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => { const b: any = { v: null, middleware: () => b, inputValidator: (v: any) => { b.v = v; return b; }, handler: (h: any) => async (o: any) => h({ data: b.v ? b.v(o.data) : o.data, context: o.context }) }; return b; },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ get supabaseAdmin() { return m.deps.db; } }));
vi.mock("./access.server", async (orig) => ({ ...(await orig<any>()), defaultDeps: async () => m.deps }));
vi.mock("./garden.server", () => ({
  ensureOwner: async () => false, peekGarden: async () => ({ agents: { a_1: { id: "a_1", handle: "rose", status: "active", ownerId: OWNER } } }),
  mutateGarden: (...a: any[]) => m.mutate(...a), recordLaunchProposal: async () => {}, DuplicateCycleError: class extends Error {}, ConflictError: class extends Error {},
}));
vi.mock("@/domain/engine", () => ({ assertOwner: (s: any, _u: string, id: string) => s.agents[id], runCycle: () => ({ decision: "hold", error: null }) }));
vi.mock("./greenhouse-start", () => ({ startTrial: (...a: any[]) => m.start(...a) }));
vi.mock("./botanist.server", () => ({ reportDeps: () => ({}) }));
vi.mock("./botanist-report", () => ({ buildReport: (...a: any[]) => m.build(...a) }));

const OWNER = "11111111-1111-4111-8111-111111111111";
import { gardenCommand } from "./garden.functions";
import { ghStart } from "./greenhouse.functions";
import { accessRedeemReport } from "./access.functions";

let db: Awaited<ReturnType<typeof accessDb>>; let staked = false;
const ctx = { userId: OWNER, supabase: {} };
const count = async (action: string) => (await db.pg.query<any>("select count(*)::int n from access_reservations where action=$1 and status = 'consumed'", [action])).rows[0].n;
beforeEach(async () => {
  db = await accessDb(); staked = false;
  await db.pg.query("insert into owners values($1,'WalletA111111111111111111111111111111111111',true)", [OWNER]);
  await db.pg.query("insert into agents values('a_1',$1)", [OWNER]);
  m.deps = { db, derivePosition: () => "pos", readStaking: vi.fn(async (w: string) => staked
    ? { cluster: "mainnet-beta", programId: "P", checks: readyChecks(), slot: 1, pool: { address: "POOL" }, position: { address: "pos", owner: w, pool: "POOL", active: "1", pendingAmount: "0" } }
    : { cluster: "mainnet-beta", programId: null, checks: readyChecks({ configured: false }), pool: null, position: null }) };
  m.mutate.mockReset().mockResolvedValue({ decision: "hold", error: null, proposal: null });
  m.start.mockReset().mockResolvedValue({ ok: true, data: { id: "run", status: "done", recovered: false } });
  m.build.mockReset().mockResolvedValue({ facts: {} });
}, 30_000);

describe("gardenCommand: free run stays unlimited; bonus is metered", () => {
  const run = () => (gardenCommand as any)({ data: { type: "run", agentId: "a_1", useAi: false }, context: ctx });
  const bonus = (id: string) => (gardenCommand as any)({ data: { type: "bonus", agentId: "a_1", useAi: false, requestId: id }, context: ctx });
  it("free Run a cycle never reserves, never reads stake and has no daily cap", async () => {
    for (let i = 0; i < 120; i++) expect((await run()).ok).toBe(true);
    expect(m.mutate).toHaveBeenCalledTimes(120);
    expect(m.mutate.mock.calls.every((c: any[]) => c[3] === undefined)).toBe(true); // plain garden_commit
    expect(m.deps.readStaking).not.toHaveBeenCalled();
    expect((await db.pg.query<any>("select count(*)::int n from access_reservations")).rows[0].n).toBe(0);
  });
  it("bonus cycle is locked without stake and changes nothing", async () => {
    const r = await bonus("aaaaaaaa-0000-4000-8000-0000000000b1");
    expect(r.ok).toBe(false); expect(r.kind).toBe("locked"); expect(m.mutate).not.toHaveBeenCalled();
  });
  it("bonus cycle with verified stake commits effect + debit together; a retry replays", async () => {
    staked = true;
    m.mutate.mockImplementation(async (_o: string, fn: any, _n: number, commit: any) => {
      const out = fn({ agents: { a_1: { id: "a_1" } }, coins: {} });
      const r = await db.rpc(commit.fn, commit.args({ cycles: out.cycles }, out.result)); if (r.error) throw new Error(r.error.message);
      return out.result;
    });
    const r = await bonus("aaaaaaaa-0000-4000-8000-0000000000b2");
    expect(r.ok).toBe(true); expect(r.message).toMatch(/Bonus cycle/);
    expect((await bonus("aaaaaaaa-0000-4000-8000-0000000000b2")).replay).toBe(true);
    expect(m.mutate).toHaveBeenCalledTimes(1);
    expect((await db.pg.query<any>("select count(*)::int n from garden_effects")).rows[0].n).toBe(1);
    expect(await count("owner_cycle")).toBe(1);
  });
});

describe("ghStart (Greenhouse)", () => {
  const cfg = (o: any = {}) => ({ agentIds: ["a_1"], seed: 1, repetitions: 2, cycles: 30, scenarios: ["control"], ...o });
  const deepCfg = (o: any = {}) => cfg({ profile: "deep-1", repetitions: 8, cycles: 100, ...o });
  it("the free legacy profile keeps its original limits (no silent widening)", async () => {
    await expect((ghStart as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000011", config: cfg({ repetitions: 6 }) }, context: ctx })).rejects.toThrow();
    await expect((ghStart as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000012", config: cfg({ cycles: 61 }) }, context: ctx })).rejects.toThrow();
    expect(m.start).not.toHaveBeenCalled();
  });
  it("free trials stay unmetered", async () => {
    expect((await (ghStart as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000001", config: cfg() }, context: ctx })).ok).toBe(true);
    expect(await count("deep_trial")).toBe(0);
  });
  it("deep trials lock without stake (no compute), and spend once per request when staked", async () => {
    const deep = { requestId: "aaaaaaaa-0000-4000-8000-000000000002", config: deepCfg() };
    const r = await (ghStart as any)({ data: deep, context: ctx });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/Pollen Access/); expect(m.start).not.toHaveBeenCalled();
    staked = true;
    m.start.mockImplementation(async (_G: any, _db: any, owner: string, d: any) => {
      await db.pg.query("insert into greenhouse_runs(owner_id,request_id,status) select $1,$2,'done' where not exists (select 1 from greenhouse_runs where request_id=$2)", [owner, d.requestId]);
      return { ok: true, data: { id: "run", status: "done", recovered: false } };
    });
    expect((await (ghStart as any)({ data: deep, context: ctx })).ok).toBe(true);
    expect((await (ghStart as any)({ data: deep, context: ctx })).ok).toBe(true); // recovery replay is free
    expect((await (ghStart as any)({ data: { ...deep, config: deepCfg({ seed: 2 }) }, context: ctx })).error).toMatch(/different input/);
    expect(await count("deep_trial")).toBe(1);
  });
  it("rejects configs over the deep compute budget at the endpoint", async () => {
    staked = true;
    await expect((ghStart as any)({ data: { requestId: "aaaaaaaa-0000-4000-8000-000000000003", config: deepCfg({ agentIds: ["a", "b", "c", "d"], repetitions: 10, cycles: 120, scenarios: ["control", "sell_pressure", "liquidity_shock"] }) }, context: ctx })).rejects.toThrow();
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
