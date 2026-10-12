// @vitest-environment node
// Pollen Access enforcement against the real 0016 SQL (PGlite): free baseline, live eligibility gates
// (wallet link, mainnet, readiness, PDA/owner/pool, active vs pending stake), refunds, replays, cross-owner.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessDb, readyChecks } from "@/test/pglite-access";
import { AccessError, cycleKey, eligibility, metered, redeemReport, reserve, usage, type AccessDeps } from "./access.server";
import { ACCESS_POLICY, utcDay } from "@/pq/access";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const WA = "WalletA111111111111111111111111111111111111", WB = "WalletB111111111111111111111111111111111111";
const PROG = "Prog111111111111111111111111111111111111111", POOL = "Pool111111111111111111111111111111111111111";
const pda = (w: string) => `pos-${w}`;
let db: Awaited<ReturnType<typeof accessDb>>; let deps: AccessDeps; let chain: Record<string, any>;
const state = (wallet: string, over: any = {}) => ({ cluster: "mainnet-beta", programId: PROG, checks: readyChecks(), slot: 900, pool: { address: POOL },
  position: { address: pda(wallet), owner: wallet, pool: POOL, active: "5000000", pendingAmount: "0" }, ...over });

beforeEach(async () => {
  db = await accessDb();
  await db.pg.query("insert into owners values($1,$2,true),($3,$4,true)", [A, WA, B, WB]);
  chain = {};
  deps = { db: db as any, readStaking: vi.fn(async (w: string) => chain[w] ?? state(w, { programId: null, checks: readyChecks({ configured: false, program: false, code: false, pool: false, vaults: false }), position: null, pool: null })), derivePosition: (_p, w) => pda(w) };
}, 30_000);
const useBase = async (owner: string, n = ACCESS_POLICY.owner_cycle.base) => { for (let i = 0; i < n; i++) await metered(deps, owner, "owner_cycle", `base-key-${i}`, async () => ({ ok: true, value: 1 })); };

describe("free baseline", () => {
  it("is used first with no chain read, and stays free for everyone", async () => {
    await useBase(A, 3);
    expect(deps.readStaking).not.toHaveBeenCalled();
    expect((await usage(db as any, A, utcDay(Date.now()))).owner_cycle).toEqual({ base: 3, extra: 0 });
  });
  it("deep trials and research credits have no free units: they lock without a stake", async () => {
    await expect(reserve(deps, A, "deep_trial", "trial:x1234567")).rejects.toMatchObject({ kind: "locked" });
    await expect(reserve(deps, A, "research_report", "report:x1234567")).rejects.toMatchObject({ kind: "locked" });
  });
});

describe("eligibility gates", () => {
  it("unready / undeployed staking keeps extra units locked with live blockers", async () => {
    await useBase(A);
    const e = await reserve(deps, A, "owner_cycle", "extra-key-1").catch((x) => x);
    expect(e).toBeInstanceOf(AccessError); expect(e.kind).toBe("locked");
    expect(e.blockers.join(" ")).toMatch(/configured/);
    expect((await usage(db as any, A, utcDay(Date.now()))).owner_cycle.extra).toBe(0);
  });
  it("a verified mainnet active stake on the canonical PDA unlocks extra units", async () => {
    chain[WA] = state(WA);
    await useBase(A);
    expect((await reserve(deps, A, "owner_cycle", "extra-key-2")).tier).toBe("extra");
  });
  for (const [name, over, re] of [
    ["devnet stake", { cluster: "devnet" }, /mainnet/],
    ["pending-unstake only", { position: { address: pda(WA), owner: WA, pool: POOL, active: "0", pendingAmount: "9" } }, /pending/],
    ["position owned by another wallet", { position: { address: pda(WA), owner: WB, pool: POOL, active: "5", pendingAmount: "0" } }, /different wallet/],
    ["non-canonical position", { position: { address: "elsewhere", owner: WA, pool: POOL, active: "5", pendingAmount: "0" } }, /canonical/],
    ["wrong pool", { position: { address: pda(WA), owner: WA, pool: "OtherPool", active: "5", pendingAmount: "0" } }, /different pool/],
    ["code hash mismatch", { checks: readyChecks({ code: false }) }, /code/],
    ["mint authority not revoked", { checks: readyChecks({ mintAuth: false }) }, /mintAuth/],
  ] as const) it(`rejects ${name}`, async () => {
    chain[WA] = state(WA, over);
    const el = await eligibility(deps, A, true);
    expect(el.eligible).toBe(false); expect(el.blockers.join(" ")).toMatch(re);
  });
  it("an unverified or missing wallet link never reads the chain", async () => {
    await db.pg.query("update owners set wallet_verified=false where id=$1", [A]);
    const el = await eligibility(deps, A, true);
    expect(el.eligible).toBe(false); expect(deps.readStaking).not.toHaveBeenCalled();
  });
  it("a failed staking read keeps benefits locked", async () => {
    deps.readStaking = vi.fn(async () => { throw new Error("rpc down"); });
    const el = await eligibility(deps, A, true);
    expect(el.eligible).toBe(false); expect(el.blockers[0]).toMatch(/read failed/);
  });
  it("caches per owner and wallet only; a re-linked wallet or another owner re-reads; extra spending reads fresh", async () => {
    chain[WA] = state(WA);
    await eligibility(deps, A); await eligibility(deps, A);
    expect(deps.readStaking).toHaveBeenCalledTimes(1);
    expect((await eligibility(deps, B)).eligible).toBe(false); // B has no stake; A's cache doesn't leak
    await db.pg.query("update owners set wallet_address=$2 where id=$1", [A, WB]);
    expect((await eligibility(deps, A)).eligible).toBe(false);
    await useBase(A);
    chain[WB] = state(WB);
    expect((await reserve(deps, A, "owner_cycle", "extra-fresh")).tier).toBe("extra");
  });
});

describe("metering", () => {
  it("refunds a failed action and lets the same key retry", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true, value: 7 });
    await expect(metered(deps, A, "owner_cycle", "retry-key", run)).rejects.toThrow("boom");
    expect(await metered(deps, A, "owner_cycle", "retry-key", run)).toBe(7);
    expect((await usage(db as any, A, utcDay(Date.now()))).owner_cycle.base).toBe(1);
  });
  it("never runs a consumed key twice and refuses a concurrent duplicate", async () => {
    let n = 0; let release!: () => void;
    const slow = () => new Promise<{ ok: boolean; value: number }>((r) => { release = () => r({ ok: true, value: ++n }); });
    const first = metered(deps, A, "owner_cycle", await cycleKey("a_1", "owner:1"), slow);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(metered(deps, A, "owner_cycle", await cycleKey("a_1", "owner:1"), slow)).rejects.toThrow(/in progress/);
    release(); expect(await first).toBe(1);
    await expect(metered(deps, A, "owner_cycle", await cycleKey("a_1", "owner:1"), slow)).rejects.toThrow(/already ran/);
    expect(n).toBe(1);
  });
});

describe("research credits", () => {
  it("locked without stake; with stake creates one saved report per request, refunds on failure", async () => {
    const build = vi.fn(async (m: string) => ({ mint: m, facts: { ok: true } }));
    await expect(redeemReport(deps, A, { requestId: "aaaaaaaa-0000-4000-8000-000000000001", mint: "M".repeat(43) }, build)).rejects.toMatchObject({ kind: "locked" });
    expect(build).not.toHaveBeenCalled();
    chain[WA] = state(WA);
    const r1 = await redeemReport(deps, A, { requestId: "aaaaaaaa-0000-4000-8000-000000000002", mint: "M".repeat(43) }, build);
    const r2 = await redeemReport(deps, A, { requestId: "aaaaaaaa-0000-4000-8000-000000000002", mint: "M".repeat(43) }, build);
    expect(r2).toEqual({ id: r1.id, replay: true }); expect(build).toHaveBeenCalledTimes(1);
    await expect(redeemReport(deps, A, { requestId: "aaaaaaaa-0000-4000-8000-000000000003", mint: "M".repeat(43) }, async () => { throw new Error("rpc"); })).rejects.toThrow(/refunded/);
    expect((await usage(db as any, A, utcDay(Date.now()))).research_report.extra).toBe(1);
    // Another owner can't see or replay A's report.
    await expect(redeemReport(deps, B, { requestId: "aaaaaaaa-0000-4000-8000-000000000002", mint: "M".repeat(43) }, build)).rejects.toMatchObject({ kind: "locked" });
  });
});
