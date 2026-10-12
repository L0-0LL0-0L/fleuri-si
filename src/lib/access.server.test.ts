// @vitest-environment node
// Server-side Pollen Access logic against the real SQL on PGlite: fail-closed eligibility with sanitized reasons,
// bonus-cycle atomicity/refund/replay and research-credit refunds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessDb, readyChecks } from "@/test/pglite-access";
import { bonusCycle, eligibility, redeemReport, reportInputHash, usage, type AccessDeps } from "./access.server";
import { utcDay } from "@/pq/access";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const W = "WalletA111111111111111111111111111111111111";
const MINT = "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri";
let db: Awaited<ReturnType<typeof accessDb>>;
const live = (over: any = {}) => ({ cluster: "mainnet-beta", programId: "P", checks: readyChecks(), slot: 7, pool: { address: "POOL" }, position: { address: "pos", owner: W, pool: "POOL", active: "5", pendingAmount: "0" }, ...over });
const deps = (read: (w: string) => Promise<any>): AccessDeps => ({ get db() { return db; }, readStaking: read, derivePosition: () => "pos" } as AccessDeps);
const ready = deps(async () => live());

beforeEach(async () => {
  db = await accessDb();
  await db.pg.query("insert into owners values($1,$2,true),($3,$2,true)", [A, W, B]);
  await db.pg.query("insert into agents values('a_1',$1),('a_2',$2)", [A, B]);
}, 30_000);

describe("eligibility fails closed", () => {
  const cases: [string, any][] = [
    ["read throws with RPC details", async () => { throw new Error("fetch https://rpc.example/?api-key=SECRET123 failed"); }],
    ["devnet", async () => live({ cluster: "devnet" })],
    ["unknown network", async () => live({ cluster: "weird-net https://x" })],
    ["truthy non-boolean check", async () => live({ checks: readyChecks().map((c) => (c.id === "code" ? { ...c, ok: "true" } : c)) })],
    ["failed check with raw detail", async () => live({ checks: readyChecks({ vaults: false }).map((c) => ({ ...c, detail: "RPC https://rpc.example/?key=SECRET123" })) })],
    ["missing checks", async () => live({ checks: undefined })],
    ["negative stake", async () => live({ position: { address: "pos", owner: W, pool: "POOL", active: "-5", pendingAmount: "0" } })],
    ["pending unstake only", async () => live({ position: { address: "pos", owner: W, pool: "POOL", active: "0", pendingAmount: "9" } })],
    ["other wallet's position", async () => live({ position: { address: "pos", owner: "Other", pool: "POOL", active: "5", pendingAmount: "0" } })],
    ["non-canonical position", async () => live({ position: { address: "fake", owner: W, pool: "POOL", active: "5", pendingAmount: "0" } })],
  ];
  for (const [name, read] of cases) it(name, async () => {
    const e = await eligibility(deps(read), A, true);
    expect(e.eligible).toBe(false);
    expect(JSON.stringify(e)).not.toMatch(/SECRET|https?:\/\//);
  });
  it("an unverified wallet is never read", async () => {
    await db.pg.query("update owners set wallet_verified=false where id=$1", [A]);
    const read = vi.fn(async () => live());
    expect((await eligibility(deps(read), A, true)).eligible).toBe(false); expect(read).not.toHaveBeenCalled();
  });
  it("a fully ready mainnet active position qualifies", async () => {
    expect(await eligibility(ready, A, true)).toMatchObject({ eligible: true, activeStake: "5", cluster: "mainnet-beta" });
  });
});

describe("bonus cycles", () => {
  const commitVia = async (c: any) => { const a = c.args({ cycles: [{ bucket: c.bucket }] }, { message: "Bonus cycle: hold" }); a.p.cycles[0].agent_id = a._owner === A ? "a_1" : "a_2"; const r = await db.rpc(c.fn, a); if (r.error) throw new Error(r.error.message); return { message: "Bonus cycle: hold" }; };
  it("debits with the effect; a retry after a lost reply replays without a second effect", async () => {
    const req = { requestId: "aaaaaaaa-0000-4000-8000-000000000001", agentId: "a_1", useAi: false };
    expect((await bonusCycle(ready, A, req, commitVia)).replay).toBe(false);
    const run = vi.fn(commitVia);
    expect(await bonusCycle(ready, A, req, run)).toMatchObject({ replay: true, message: "Bonus cycle: hold" });
    expect(run).not.toHaveBeenCalled();
    expect((await usage(db, W, utcDay(Date.now()))).owner_cycle).toBe(1);
  });
  it("is shared by both workspaces on the wallet", async () => {
    await bonusCycle(ready, A, { requestId: "aaaaaaaa-0000-4000-8000-000000000002", agentId: "a_1", useAi: false }, commitVia);
    await bonusCycle(ready, B, { requestId: "aaaaaaaa-0000-4000-8000-000000000003", agentId: "a_2", useAi: false }, commitVia);
    expect((await usage(db, W, utcDay(Date.now()))).owner_cycle).toBe(2);
  });
  it("a failure before commit refunds and leaves no effect", async () => {
    await expect(bonusCycle(ready, A, { requestId: "aaaaaaaa-0000-4000-8000-000000000004", agentId: "a_1", useAi: false }, async () => { throw new Error("AI down"); })).rejects.toThrow("AI down");
    expect((await usage(db, W, utcDay(Date.now()))).owner_cycle).toBe(0);
    expect((await db.pg.query<any>("select count(*)::int n from garden_effects")).rows[0].n).toBe(0);
  });
  it("is locked when staking isn't ready, without running anything", async () => {
    const run = vi.fn(commitVia);
    await expect(bonusCycle(deps(async () => live({ checks: readyChecks({ configured: false }) })), A, { requestId: "aaaaaaaa-0000-4000-8000-000000000005", agentId: "a_1", useAi: false }, run)).rejects.toMatchObject({ kind: "locked" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("research credits", () => {
  it("saves one owner-private report, replays it, and refunds a failed build", async () => {
    const r1 = await redeemReport(ready, A, { requestId: "aaaaaaaa-0000-4000-8000-00000000000a", mint: MINT }, async () => ({ facts: 1 }));
    expect(r1.replay).toBe(false);
    expect(await redeemReport(ready, A, { requestId: "aaaaaaaa-0000-4000-8000-00000000000a", mint: MINT }, async () => { throw new Error("no"); })).toMatchObject({ id: r1.id, replay: true });
    await expect(redeemReport(ready, A, { requestId: "aaaaaaaa-0000-4000-8000-00000000000a", mint: "So11111111111111111111111111111111111111112" }, async () => ({}))).rejects.toMatchObject({ kind: "conflict" });
    await expect(redeemReport(ready, A, { requestId: "aaaaaaaa-0000-4000-8000-00000000000b", mint: MINT }, async () => { throw new Error("rpc"); })).rejects.toThrow(/refunded/);
    expect((await usage(db, W, utcDay(Date.now()))).research_report).toBe(1);
    expect(await reportInputHash(MINT)).toMatch(/^[0-9a-f]{64}$/);
  });
});
