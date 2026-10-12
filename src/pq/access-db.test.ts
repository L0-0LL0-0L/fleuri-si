// @vitest-environment node
// Adversarial tests of the REAL Pollen Access SQL (0016 + 0017) on PGlite: shared wallet budgets, in-flight and
// changed-input requests, stale lease fencing, cross-midnight expiry, atomic effect+debit, ack loss, RLS and grants.
import { beforeEach, describe, expect, it } from "vitest";
import { accessDb } from "@/test/pglite-access";
import { createHash } from "node:crypto";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const W1 = "WalletOne1111111111111111111111111111111111", W2 = "WalletTwo2222222222222222222222222222222222";
const H1 = "a".repeat(64), H2 = "b".repeat(64);
let db: Awaited<ReturnType<typeof accessDb>>;
const q = async (sql: string, p: unknown[] = []) => (await db.pg.query<any>(sql, p)).rows;
const agentOf = (owner: string) => `ag_${owner.slice(0, 8)}`;
const bonusHash = (owner: string) => createHash("sha256").update(`bonus|${agentOf(owner)}|0`).digest("hex");
const acq = (owner: string, action: string, key: string, o: { hash?: string; wallet?: string | null; eligible?: boolean; limit?: number; inflight?: number } = {}) =>
  q("select public.access_acquire($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,120,$8) j", [owner, action, key, o.hash ?? (action === "owner_cycle" ? bonusHash(owner) : H1), o.wallet === undefined ? W1 : o.wallet, o.eligible ?? true, o.limit ?? 2, o.inflight ?? 2]).then((r) => r[0].j);
const commit = (owner: string, id: string, lease: string, bucket?: string, fail = false) =>
  q("select public.access_commit_cycle($1,$2,$3,$4::jsonb,'{\"message\":\"ran\"}'::jsonb) v", [owner, id, lease, JSON.stringify({ cycles: [{ bucket: bucket ?? `access:${id}`, agent_id: agentOf(owner) }], ...(fail ? { fail: "1" } : {}) })]);
const release = (owner: string, id: string, lease: string) => q("select public.access_release($1,$2,$3) j", [owner, id, lease]).then((r) => r[0].j);
const expire = (id: string) => q("update access_reservations set lease_expires_at = now() - interval '1 second' where id=$1", [id]);
const status = async (id: string) => (await q("select status from access_reservations where id=$1", [id]))[0].status;
const effects = async () => (await q("select count(*)::int n from garden_effects"))[0].n;
const K = (n: number) => `bonus:req-${String(n).padStart(4, "0")}`;

beforeEach(async () => {
  db = await accessDb();
  for (const o of [A, B, C]) await q("insert into agents(id,owner_id) values($1,$2)", [agentOf(o), o]);
}, 30_000);

describe("shared wallet + UTC-day budget", () => {
  it("two workspaces on one wallet share the allowance; another wallet is separate", async () => {
    const a = await acq(A, "owner_cycle", K(1)); await commit(A, a.id, a.lease);
    const b = await acq(B, "owner_cycle", K(2)); await commit(B, b.id, b.lease);
    await expect(acq(B, "owner_cycle", K(3))).rejects.toThrow("access_exhausted");
    await expect(acq(A, "owner_cycle", K(4))).rejects.toThrow("access_exhausted");
    expect((await acq(C, "owner_cycle", K(5), { wallet: W2 })).state).toBe("acquired");
  });
  it("live leases count toward the wallet's in-flight cap across workspaces", async () => {
    await acq(A, "owner_cycle", K(1), { limit: 10 }); await acq(B, "deep_trial", "aaaaaaaa-0000-4000-8000-000000000001", { limit: 10 });
    await expect(acq(A, "research_report", "report:x-000001", { limit: 10 })).rejects.toThrow("access_busy");
  });
  it("yesterday's use doesn't count today; an expired lease from yesterday re-counts under today's day", async () => {
    await q(`insert into access_reservations(owner_id,action,request_key,day,tier,status,wallet,input_hash) values($1,'owner_cycle','bonus:old-00001',(now() at time zone 'utc')::date - 1,'extra','consumed',$2,$3)`, [A, W1, H1]);
    const a = await acq(A, "owner_cycle", K(1), { limit: 1 });
    expect(a.state).toBe("acquired");
    await q("update access_reservations set day = day - 1 where id=$1", [a.id]); await expire(a.id);
    const again = await acq(A, "owner_cycle", K(1), { limit: 1 });
    expect(again.id).toBe(a.id); expect(again.generation).toBe(2);
    expect((await q("select day = (now() at time zone 'utc')::date ok from access_reservations where id=$1", [a.id]))[0].ok).toBe(true);
  });
  it("is locked without verified eligibility, but a finished request still replays", async () => {
    await expect(acq(A, "owner_cycle", K(1), { eligible: false, wallet: null })).rejects.toThrow("access_locked");
    const a = await acq(A, "owner_cycle", K(2)); await commit(A, a.id, a.lease);
    expect((await acq(A, "owner_cycle", K(2), { eligible: false, wallet: null })).state).toBe("done");
  });
});

describe("idempotency and fencing", () => {
  it("an identical in-flight request is refused, never run twice (also under concurrency)", async () => {
    const both = await Promise.allSettled([acq(A, "owner_cycle", K(1)), acq(A, "owner_cycle", K(1))]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(String((both.find((x) => x.status === "rejected") as PromiseRejectedResult).reason)).toMatch("access_inflight");
  });
  it("changed input under the same request id is a conflict, before and after completion", async () => {
    const a = await acq(A, "owner_cycle", K(1));
    await expect(acq(A, "owner_cycle", K(1), { hash: H2 })).rejects.toThrow("access_conflict");
    await commit(A, a.id, a.lease);
    await expect(acq(A, "owner_cycle", K(1), { hash: H2 })).rejects.toThrow("access_conflict");
  });
  it("a stale lease can neither commit nor refund the new holder's reservation", async () => {
    const a = await acq(A, "owner_cycle", K(1)); await expire(a.id);
    const b = await acq(A, "owner_cycle", K(1));
    expect(b.lease).not.toBe(a.lease);
    await expect(commit(A, a.id, a.lease)).rejects.toThrow("access_stale");
    expect((await release(A, a.id, a.lease)).applied).toBe(false);
    expect(await status(a.id)).toBe("reserved"); expect(await effects()).toBe(0);
    await commit(A, b.id, b.lease);
    expect(await status(a.id)).toBe("consumed"); expect(await effects()).toBe(1);
  });
  it("an expired lease stops counting and can no longer commit, so a stale worker can't oversubscribe", async () => {
    const a = await acq(A, "owner_cycle", K(1), { limit: 1 }); await expire(a.id);
    const b = await acq(B, "owner_cycle", K(2), { limit: 1 }); await commit(B, b.id, b.lease);
    await expect(commit(A, a.id, a.lease)).rejects.toThrow("access_stale");
    expect(await effects()).toBe(1);
  });
});

describe("effect + debit atomicity", () => {
  it("a failed garden effect rolls back with no debit, then refunds", async () => {
    const a = await acq(A, "owner_cycle", K(1), { limit: 1 });
    await expect(commit(A, a.id, a.lease, undefined, true)).rejects.toThrow();
    expect(await effects()).toBe(0); expect(await status(a.id)).toBe("reserved");
    expect((await release(A, a.id, a.lease)).status).toBe("refunded");
    expect((await acq(A, "owner_cycle", K(2), { limit: 1 })).state).toBe("acquired");
  });
  it("a committed effect whose reply was lost replays its result and can never be refunded", async () => {
    const a = await acq(A, "owner_cycle", K(1)); await commit(A, a.id, a.lease);
    expect((await release(A, a.id, a.lease)).applied).toBe(false);
    const again = await acq(A, "owner_cycle", K(1));
    expect(again).toMatchObject({ state: "done", result: { message: "ran" } });
    expect(await effects()).toBe(1); expect(await status(a.id)).toBe("consumed");
  });
  it("the cycle must carry this reservation's unique bucket", async () => {
    const a = await acq(A, "owner_cycle", K(1));
    await expect(commit(A, a.id, a.lease, "owner:123")).rejects.toThrow("not bound");
    expect(await effects()).toBe(0);
  });
  it("research report + debit save together, bound to the reserved mint", async () => {
    const mint = "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri";
    const hash = (await q("select encode(sha256(convert_to('report|' || $1, 'UTF8')),'hex') h", [mint]))[0].h;
    const a = await acq(A, "research_report", "report:abc-0001", { hash });
    const store = (m: string, lease = a.lease) => q("select public.access_store_report($1,$2,$3,$4,'{}'::jsonb,$5) j", [A, a.id, lease, m, "c".repeat(64)]);
    await expect(store("So11111111111111111111111111111111111111112")).rejects.toThrow("does not match");
    await store(mint);
    expect(await status(a.id)).toBe("consumed");
    await expect(store(mint)).rejects.toThrow("access_stale");
    expect((await acq(A, "research_report", "report:abc-0001", { hash })).state).toBe("done");
    expect((await q("select count(*)::int n from access_reports"))[0].n).toBe(1);
  });
});

describe("deep trial recovery", () => {
  const R = "aaaaaaaa-0000-4000-8000-000000000001";
  it("a crashed worker's credit is bound to its frozen run: recovered as done, never re-spent or refunded", async () => {
    const a = await acq(A, "deep_trial", R, { limit: 1 });
    await q("insert into greenhouse_runs(owner_id,request_id,status) values($1,$2,'running')", [A, R]);
    expect((await release(A, a.id, a.lease)).status).toBe("consumed");
    expect((await acq(A, "deep_trial", R, { limit: 1 })).state).toBe("done");
  });
  it("expired lease with a stored run recovers as done; without a run it is re-acquired; settle refunds when no run", async () => {
    const a = await acq(A, "deep_trial", R); await expire(a.id);
    await q("insert into greenhouse_runs(owner_id,request_id,status) values($1,$2,'done')", [A, R]);
    expect((await acq(A, "deep_trial", R)).state).toBe("done");
    const R2 = "aaaaaaaa-0000-4000-8000-000000000002";
    const b = await acq(A, "deep_trial", R2);
    expect((await q("select public.access_settle_trial($1,$2,$3) j", [A, b.id, b.lease]))[0].j.status).toBe("refunded");
  });
});

describe("permissions", () => {
  it("owners read only their own rows and cannot call any access function; v1 entry points are retired", async () => {
    await acq(A, "owner_cycle", K(1)); await acq(B, "owner_cycle", K(2), { wallet: W2 });
    await db.pg.exec("grant usage on schema public to authenticated, anon; grant usage on schema auth to authenticated, anon");
    await db.pg.query("select set_config('request.jwt.claim.sub',$1,false)", [A]);
    await db.pg.exec("set role authenticated");
    expect((await q("select owner_id from access_reservations")).map((r) => r.owner_id)).toEqual([A]);
    await expect(q("select public.access_acquire($1,'owner_cycle','bonus:zzzz0001',$2,$3,true,99,'{}'::jsonb,120,2)", [A, H1, W1])).rejects.toThrow(/permission denied/);
    await expect(q("insert into access_reservations(owner_id,action,request_key,day,tier) values($1,'owner_cycle','bonus:zzzz0002',current_date,'extra')", [A])).rejects.toThrow(/permission denied/);
    await db.pg.exec("reset role");
    await expect(q("select public.access_reserve($1,'owner_cycle','bonus:zzzz0003',0,1,true,'{}'::jsonb,2)", [A])).rejects.toThrow("Obsolete");
  });
});

describe("0018 durable deep-credit binding", () => {
  const RQ = (n: number) => `dddddddd-0000-4000-8000-00000000000${n}`;
  const claim = (owner: string, id: string, lease: string | null, req: string) =>
    q("select public.access_claim_deep_trial($1,$2,$3,$4,'e',array['a'],$5::jsonb,'ih') j", [owner, id, lease, req, JSON.stringify({ config: { profile: "deep-1" } })]).then((r) => r[0].j);
  it("three frozen deep runs that then expire still count; a second workspace's fourth is denied", async () => {
    for (const n of [1, 2, 3]) {
      const a = await acq(A, "deep_trial", RQ(n), { limit: 3, inflight: 5 });
      await claim(A, a.id, a.lease, RQ(n));
      expect(await status(a.id)).toBe("consumed");
      await expire(a.id);
    }
    await expect(acq(B, "deep_trial", RQ(4), { limit: 3, inflight: 5 })).rejects.toThrow("access_exhausted");
  });
  it("0017-era reserved rows with a frozen run are reconciled before counting", async () => {
    for (const n of [1, 2, 3]) {
      const a = await acq(A, "deep_trial", RQ(n), { limit: 3, inflight: 5 });
      await q("insert into greenhouse_runs(owner_id,request_id,status) values($1,$2,'running')", [A, RQ(n)]); await expire(a.id);
    }
    await expect(acq(B, "deep_trial", RQ(4), { limit: 3, inflight: 5 })).rejects.toThrow("access_exhausted");
    expect((await q("select count(*)::int n from access_reservations where status='consumed'"))[0].n).toBe(3);
  });
  it("a lease-expired worker without a run cannot create a trial after a replacement takes the slot", async () => {
    const a = await acq(A, "deep_trial", RQ(1), { limit: 1 }); await expire(a.id);
    const b = await acq(B, "deep_trial", RQ(2), { limit: 1 });
    await expect(claim(A, a.id, a.lease, RQ(1))).rejects.toThrow("access_stale");
    expect((await q("select count(*)::int n from greenhouse_runs where request_id=$1", [RQ(1)]))[0].n).toBe(0);
    await claim(B, b.id, b.lease, RQ(2));
    expect(await status(b.id)).toBe("consumed");
  });
  it("a bound credit only recovers its own run, a mismatched request is refused, and a failed run refunds once", async () => {
    const a = await acq(A, "deep_trial", RQ(1), { limit: 1 });
    await expect(claim(A, a.id, a.lease, RQ(2))).rejects.toThrow("does not match");
    await claim(A, a.id, a.lease, RQ(1));
    expect((await claim(A, a.id, null, RQ(1))).acquired).toBe(false);
    await expect(claim(B, a.id, null, RQ(1))).rejects.toThrow("does not match");
    await q("update greenhouse_runs set status='failed' where request_id=$1", [RQ(1)]);
    expect((await q("select public.access_settle_trial($1,$2,$3) j", [A, a.id, "00000000-0000-4000-8000-000000000000"]))[0].j.applied).toBe(false);
    expect((await q("select public.access_settle_trial($1,$2,$3) j", [A, a.id, a.lease]))[0].j.status).toBe("refunded");
  });
  it("bonus commit refuses another owner's agent or an agent other than the reserved one", async () => {
    const a = await acq(A, "owner_cycle", K(1));
    const p = (agent: string) => JSON.stringify({ cycles: [{ bucket: `access:${a.id}`, agent_id: agent }] });
    await expect(q("select public.access_commit_cycle($1,$2,$3,$4::jsonb,'{}'::jsonb)", [A, a.id, a.lease, p(agentOf(B))])).rejects.toThrow("not yours");
    await q("insert into agents values('ag_other',$1)", [A]);
    await expect(q("select public.access_commit_cycle($1,$2,$3,$4::jsonb,'{}'::jsonb)", [A, a.id, a.lease, p("ag_other")])).rejects.toThrow("does not match");
    expect(await effects()).toBe(0);
  });
});
