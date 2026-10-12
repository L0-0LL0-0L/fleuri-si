// @vitest-environment node
// Pollen Access SQL (0016) in PGlite: atomic reserve/consume/refund, idempotency, quotas, concurrency,
// stale-reservation rollback, RLS owner reads and service-role-only functions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

let db: PGlite;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const q = async (sql: string, p: any[] = []) => (await db.query<any>(sql, p)).rows;
const as = async (role: string, sub?: string) => { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [sub ?? ""]); await db.exec(`set role ${role}`); };
const reserve = (owner: string, action: string, key: string, base: number, extra: number, eligible: boolean, inflight = 2) =>
  q("select access_reserve($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7) j", [owner, action, key, base, extra, eligible, inflight]).then((r) => r[0].j);
const finish = (owner: string, id: string, ok: boolean) => q("select access_finish($1,$2,$3) j", [owner, id, ok]).then((r) => r[0].j);
const k = (i: number) => `key-${String(i).padStart(6, "0")}`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to anon,authenticated,service_role; grant usage on schema public to anon,authenticated,service_role;");
  await db.exec("alter default privileges in schema public grant all on tables to anon, authenticated;"); // Supabase-like broad defaults must be revoked
  await db.exec(await readFile(new URL("./sql/0016_pollen_access.sql", import.meta.url), "utf8"));
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("access reservations (0016)", () => {
  it("uses free base units first, then requires eligibility, then exhausts", async () => {
    await db.exec("reset role");
    const a = await reserve(A, "owner_cycle", k(1), 1, 1, false);
    expect(a).toMatchObject({ tier: "base", status: "reserved", replay: false });
    await finish(A, a.id, true);
    await expect(reserve(A, "owner_cycle", k(2), 1, 1, false)).rejects.toThrow("access_locked");
    const b = await reserve(A, "owner_cycle", k(2), 1, 1, true);
    expect(b.tier).toBe("extra"); await finish(A, b.id, true);
    await expect(reserve(A, "owner_cycle", k(3), 1, 1, true)).rejects.toThrow("access_exhausted");
    // Another owner's quota is independent.
    expect((await reserve(B, "owner_cycle", k(3), 1, 1, false)).tier).toBe("base");
  });
  it("is idempotent per request key: a replay never spends twice", async () => {
    const before = (await q("select count(*)::int n from access_reservations where owner_id=$1", [A]))[0].n;
    const r = await reserve(A, "owner_cycle", k(1), 1, 1, true);
    expect(r).toMatchObject({ replay: true, status: "consumed" });
    expect((await q("select count(*)::int n from access_reservations where owner_id=$1", [A]))[0].n).toBe(before);
    expect((await finish(A, r.id, true)).applied).toBe(false);
    expect((await finish(A, r.id, false)).status).toBe("consumed"); // consumed is final, never refunded
  });
  it("refunds failures and lets the same key retry within quota", async () => {
    const r = await reserve(A, "deep_trial", k(10), 0, 1, true);
    expect((await finish(A, r.id, false)).status).toBe("refunded");
    const again = await reserve(A, "deep_trial", k(10), 0, 1, true);
    expect(again).toMatchObject({ id: r.id, replay: false, status: "reserved", tier: "extra" });
    await finish(A, again.id, true);
    await expect(reserve(A, "deep_trial", k(11), 0, 1, true)).rejects.toThrow("access_exhausted");
  });
  it("limits in-flight reservations per owner and expires stale ones (rollback safety)", async () => {
    await reserve(A, "research_report", k(20), 0, 5, true, 2);
    await reserve(A, "research_report", k(21), 0, 5, true, 2);
    await expect(reserve(A, "research_report", k(22), 0, 5, true, 2)).rejects.toThrow("access_busy");
    await db.exec("update access_reservations set created_at=now()-interval '11 minutes' where request_key in ('key-000020','key-000021')");
    const r = await reserve(A, "research_report", k(22), 0, 5, true, 2);
    expect(r.status).toBe("reserved");
    expect((await q("select status from access_reservations where request_key='key-000020'"))[0].status).toBe("refunded");
  });
  it("serializes concurrent reservations on the owner lock: no over-spend", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => reserve(B, "deep_trial", k(100 + i), 0, 2, true, 10)));
    expect(results.filter((x) => x.status === "fulfilled").length).toBe(2);
    expect((await q("select count(*)::int n from access_reservations where owner_id=$1 and action='deep_trial'", [B]))[0].n).toBe(2);
  });
  it("saves a report and consumes atomically, idempotent per reservation", async () => {
    const r = await reserve(B, "research_report", k(200), 0, 3, true);
    const args = [B, r.id, "M".repeat(43), '{"x":1}', "a".repeat(64)];
    const s1 = (await q("select access_save_report($1,$2,$3,$4::jsonb,$5) j", args))[0].j;
    const s2 = (await q("select access_save_report($1,$2,$3,$4::jsonb,$5) j", args))[0].j;
    expect(s1.created).toBe(true); expect(s2).toEqual({ id: s1.id, created: false });
    expect((await q("select status from access_reservations where id=$1", [r.id]))[0].status).toBe("consumed");
    await expect(q("select access_save_report($1,$2,$3,$4::jsonb,$5)", [A, r.id, "M".repeat(43), "{}", "a".repeat(64)])).rejects.toThrow("not found");
  });
  it("rejects invalid limits and unknown actions", async () => {
    await expect(reserve(A, "owner_cycle", k(300), -1, 0, true)).rejects.toThrow("invalid limits");
    await expect(reserve(A, "free_money", k(301), 1, 0, true)).rejects.toThrow();
  });
});

describe("access permissions", () => {
  it("owners read only their own rows; anon reads nothing; nobody but service_role can write or call", async () => {
    await as("authenticated", A);
    const mine = await q("select owner_id from access_reservations");
    expect(mine.length).toBeGreaterThan(0); expect(mine.every((x) => x.owner_id === A)).toBe(true);
    expect((await q("select * from access_reports")).length).toBe(0); // B's report is invisible to A
    await expect(q("insert into access_reservations(owner_id,action,request_key,day,tier) values($1,'owner_cycle','key-999999',current_date,'base')", [A])).rejects.toThrow();
    await expect(q("update access_reservations set status='refunded'")).rejects.toThrow();
    await expect(reserve(A, "owner_cycle", k(400), 100, 100, true)).rejects.toThrow(/permission/);
    await expect(q("select access_set_eligibility($1,'w',true,'1',1,'mainnet-beta','[]'::jsonb)", [A])).rejects.toThrow(/permission/);
    await as("anon");
    await expect(q("select * from access_reservations")).rejects.toThrow(/permission/);
    await expect(q("select access_finish($1,$1,true)", [A])).rejects.toThrow(/permission/);
    await as("service_role");
    expect((await reserve(A, "owner_cycle", k(401), 100, 0, false)).tier).toBe("base");
    await db.exec("reset role");
  });
});
