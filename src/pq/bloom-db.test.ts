// @vitest-environment node
// Real Blind Bloom SQL (0020) on PGlite with a controllable clock: deadlines, confidentiality before reveal,
// ownership, immutable retries, duplicates, concurrency, fenced/expired leases, crash recovery and evidence linking.
import { beforeEach, describe, expect, it } from "vitest";
import { bloomDb } from "@/test/pglite-bloom";
import * as S from "@/lib/bloom.server";
import * as B from "@/domain/bloom";
import { policyHash } from "@/domain/greenhouse";

const A = "11111111-1111-4111-8111-111111111111", O2 = "22222222-2222-4222-8222-222222222222";
const req = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const market = { coins: [{ symbol: "AAA", name: "a", vSol: 40, vTok: 8e8, raised: 10, graduated: false }, { symbol: "BBB", name: "b", vSol: 32, vTok: 1e9, raised: 2, graduated: false }, { symbol: "CCC", name: "c", vSol: 55, vTok: 6e8, raised: 25, graduated: false }], posts: [], frozenAt: 1 };
const rules: B.BloomRules = { ...B.PRESET_RULES, repetitions: 1, cycles: 10, scenarios: ["control", "execution_failures"] };
let db: Awaited<ReturnType<typeof bloomDb>>;
let round: string;
const q = async (sql: string, p: unknown[] = []) => (await db.pg.query<any>(sql, p)).rows;
const baseHash = (id: string, archetype = "pollinator", risk = 3) => policyHash({ archetype: archetype as any, risk, strategy: "s", persona: "p" });
const manifest = (agentId: string, risk = 5, bp = baseHash(agentId)): B.Manifest => ({ format: B.MANIFEST_FORMAT, agentId, basePolicyHash: bp, settings: { archetype: "weed", risk }, predictions: { beats_baseline: 40, beats_base_policy: 50, ends_in_profit: 30, drawdown_over_15: 60 } });
const asRole = async <T>(role: string, f: () => Promise<T>) => { await q(`set role ${role}`); try { return await f(); } finally { await q("reset role"); } };

beforeEach(async () => {
  db = await bloomDb();
  for (const [id, o] of [["ag_a", A], ["ag_b", A], ["ag_c", O2]]) await q("insert into agents(id,handle,name,archetype,risk,strategy,persona,owner_id) values($1,$1,$1,'pollinator',3,'s','p',$2)", [id, o]);
  const r = await db.rpc("bloom_ensure_round", { _title: "Launch resilience", _rules: rules, _rules_hash: B.rulesHash(rules), _market: market, _market_hash: B.marketHash(market), _commit_secs: 3600 });
  round = r.data.id;
}, 30_000);

describe("round creation", () => {
  it("one open round at a time; seed is random, committed, and its commitment matches the TS formula", async () => {
    const again = await db.rpc("bloom_ensure_round", { _title: "x", _rules: rules, _rules_hash: B.rulesHash(rules), _market: market, _market_hash: B.marketHash(market), _commit_secs: 3600 });
    expect(again.data).toEqual({ id: round, created: false });
    const [r] = await q("select seed_hex, seed_commit from bloom_rounds where id=$1", [round]);
    expect(r.seed_hex).toMatch(/^[0-9a-f]{64}$/); expect(B.seedCommit(r.seed_hex)).toBe(r.seed_commit);
    await db.advance(3601);
    const next = await db.rpc("bloom_ensure_round", { _title: "x", _rules: rules, _rules_hash: B.rulesHash(rules), _market: market, _market_hash: B.marketHash(market), _commit_secs: 3600 });
    expect(next.data.created).toBe(true);
    const seeds = await q("select seed_hex from bloom_rounds"); expect(new Set(seeds.map((s) => s.seed_hex)).size).toBe(2);
  });
});

describe("sealing", () => {
  it("only the agent's owner can enter; retries are idempotent and changed bodies are refused", async () => {
    await expect(S.submit(db, O2, { roundId: round, requestId: req(1), manifest: manifest("ag_a") })).rejects.toThrow(/own active agents/);
    const a = await S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") });
    expect(a.created).toBe(true);
    const again = await S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") });
    expect(again).toEqual({ id: a.id, commit: a.commit, created: false }); // same commit even though a fresh salt was generated
    await expect(S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a", 4) })).rejects.toThrow(/different strategy/);
    await expect(S.submit(db, A, { roundId: round, requestId: req(2), manifest: manifest("ag_a", 4) })).rejects.toThrow(/already entered/);
  });
  it("a stale base policy hash or a forged manifest for another agent is refused", async () => {
    await expect(S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a", 5, "0".repeat(64)) })).rejects.toThrow(/policy changed/);
    await expect(db.rpc("bloom_submit", { _owner: A, _round: round, _request: req(3), _agent: "ag_c", _base_policy: { policyHash: baseHash("ag_c") }, _base_policy_hash: baseHash("ag_c"), _manifest: manifest("ag_c"), _body_hash: "a".repeat(64), _salt: "b".repeat(64), _commit: "c".repeat(64) }).then((r) => { if (r.error) throw new Error(r.error.message); })).rejects.toThrow(/own active agents/);
  });
  it("concurrent identical submissions create exactly one entry", async () => {
    const both = await Promise.allSettled([S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") }), S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") })]);
    expect(both.every((x) => x.status === "fulfilled")).toBe(true);
    expect((await q("select count(*)::int n from bloom_entries"))[0].n).toBe(1);
  });
  it("the deadline is enforced on server time, atomically", async () => {
    await db.advance(3599);
    await S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") });
    await db.advance(1);
    await expect(S.submit(db, A, { roundId: round, requestId: req(2), manifest: manifest("ag_b") })).rejects.toThrow(/commit phase/);
  });
  it("per-owner round limit", async () => {
    for (const [i, r] of [5, 4, 3].entries()) await S.submit(db, A, { roundId: round, requestId: req(10 + i), manifest: { ...manifest("ag_a", r) } }).catch((e) => e);
    // ag_a can only enter once per policy version, so use distinct agents to hit the per-round cap
    await q("insert into agents(id,handle,name,archetype,risk,strategy,persona,owner_id) values('ag_d','ag_d','ag_d','pollinator',3,'s','p',$1),('ag_e','ag_e','ag_e','pollinator',3,'s','p',$1)", [A]);
    await S.submit(db, A, { roundId: round, requestId: req(20), manifest: manifest("ag_b") });
    await S.submit(db, A, { roundId: round, requestId: req(21), manifest: manifest("ag_d") });
    await expect(S.submit(db, A, { roundId: round, requestId: req(22), manifest: manifest("ag_e") })).rejects.toThrow(/3 entries per owner/);
  });
});

describe("confidentiality before reveal", () => {
  it("anon/authenticated cannot read the seed, salts, manifests or owners, and reveal columns stay empty", async () => {
    await S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") });
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, () => q("select seed_hex from bloom_rounds"))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => q("select salt from bloom_entries"))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => q("select manifest from bloom_entries"))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => q("select owner_id from bloom_entries"))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => q("select lease_token from bloom_rounds"))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => q("select public.bloom_claim_eval($1)", [round]))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => q("insert into bloom_entries(round_id) values($1)", [round]))).rejects.toThrow(/permission denied/);
      const [r] = await asRole(role, () => q("select seed_commit, seed_reveal from bloom_rounds"));
      expect(r.seed_reveal).toBeNull(); expect(r.seed_commit).toMatch(/^[0-9a-f]{64}$/);
      const [e] = await asRole(role, () => q("select commit, salt_reveal, manifest_reveal, base_policy_reveal from bloom_entries"));
      expect(e.salt_reveal).toBeNull(); expect(e.manifest_reveal).toBeNull(); expect(e.base_policy_reveal).toBeNull();
    }
    const b = await S.bundle(db, round);
    expect(b!.reveal.seedHex).toBeNull(); expect(b!.entries[0].manifest).toBeNull(); expect(JSON.stringify(b)).not.toMatch(/"salt":"[0-9a-f]/);
  });
  it("evaluation cannot start before the deadline, whoever calls", async () => {
    expect(await S.advance(db, round)).toBe("open");
    expect((await q("select status, seed_reveal from bloom_rounds"))[0]).toEqual({ status: "open", seed_reveal: null });
  });
});

describe("reveal, evaluation and recovery", () => {
  const enter = async () => { await S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") }); await S.submit(db, O2, { roundId: round, requestId: req(2), manifest: manifest("ag_c", 2) }); };
  it("after the deadline it reveals once, scores from frozen inputs, and the bundle verifies independently", async () => {
    await enter(); await db.advance(3600);
    await q("update agents set risk=1"); await q("update test_clock set t=t"); // live agents changing after sealing must not matter
    expect(await S.advance(db, round)).toBe("scored");
    expect(await S.advance(db, round)).toBe("scored");
    const b = await S.bundle(db, round);
    const v = B.verifyBloomBundle(JSON.stringify(b));
    expect(v.status).toBe("verified");
    expect(b!.output!.entries.map((e) => e.status)).toEqual(["scored", "scored"]);
    expect(b!.output!.entries[0].n).toBe(2);
  });
  it("a crashed evaluator's expired lease is recovered with the same frozen inputs; a stale finalize is fenced", async () => {
    await enter(); await db.advance(3600);
    const c1 = (await db.rpc("bloom_claim_eval", { _round: round })).data;
    expect(c1.state).toBe("acquired");
    expect((await db.rpc("bloom_claim_eval", { _round: round })).data.state).toBe("busy");
    await db.advance(121); // first worker "crashed"
    const c2 = (await db.rpc("bloom_claim_eval", { _round: round })).data;
    expect(c2.state).toBe("acquired"); expect(c2.attempts).toBe(2);
    expect(JSON.stringify(c2.entries)).toBe(JSON.stringify(c1.entries)); expect(c2.seed).toBe(c1.seed);
    const late = await db.rpc("bloom_finalize", { _round: round, _lease: c1.lease, _output: {}, _output_hash: "a".repeat(64), _content_hash: "b".repeat(64) });
    expect(late.error?.message).toMatch(/no longer current/);
    await db.advance(121);
    expect(await S.advance(db, round)).toBe("scored");
    expect(B.verifyBloomBundle(JSON.stringify(await S.bundle(db, round))).status).toBe("verified");
  });
  it("three expired attempts make the round terminally failed and published as failed", async () => {
    await enter(); await db.advance(3600);
    for (let i = 0; i < 3; i++) { await db.rpc("bloom_claim_eval", { _round: round }); await db.advance(121); }
    expect((await db.rpc("bloom_claim_eval", { _round: round })).data.state).toBe("failed");
    const b = await S.bundle(db, round);
    expect(b!.round.status).toBe("failed"); expect(b!.error).toMatch(/3 attempts/);
    expect(b!.reveal.seedHex).toMatch(/^[0-9a-f]{64}$/); // failures still publish the seed and commitments
    expect(B.verifyBloomBundle(JSON.stringify(b)).status).toBe("verified");
  });
});

describe("evidence linking (never approval)", () => {
  it("links only the owner's scored entry to a proposal by the same agent and policy", async () => {
    const e = await S.submit(db, A, { roundId: round, requestId: req(1), manifest: manifest("ag_a") });
    const [p] = await q("insert into launch_proposals(agent_handle,origin_agent_id,origin_policy_hash) values('ag_a','ag_a',$1) returning id", [baseHash("ag_a")]);
    const [other] = await q("insert into launch_proposals(agent_handle,origin_agent_id,origin_policy_hash) values('ag_a','ag_a',$1) returning id", ["f".repeat(64)]);
    await expect(S.attach(db, A, p.id, e.id)).rejects.toThrow(/scored/);
    await db.advance(3600); await S.advance(db, round);
    await expect(S.attach(db, O2, p.id, e.id)).rejects.toThrow(/own entries/);
    await expect(S.attach(db, A, other.id, e.id)).rejects.toThrow(/policy/);
    await S.attach(db, A, p.id, e.id);
    expect((await q("select status from launch_proposals where id=$1", [p.id]))[0].status).toBe("proposed");
    expect((await q("select count(*)::int n from bloom_evidence"))[0].n).toBe(1);
  });
});
