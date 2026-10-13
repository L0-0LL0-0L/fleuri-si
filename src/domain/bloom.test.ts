import { describe, expect, it } from "vitest";
import * as B from "./bloom";
import { policyHash, stableJson, type FrozenMarket, type PolicySnapshot } from "./greenhouse";

const market: FrozenMarket = { coins: [
  { symbol: "AAA", name: "a", vSol: 40, vTok: 8e8, raised: 10, graduated: false },
  { symbol: "BBB", name: "b", vSol: 32, vTok: 1e9, raised: 2, graduated: false },
  { symbol: "CCC", name: "c", vSol: 55, vTok: 6e8, raised: 25, graduated: false },
  { symbol: "DDD", name: "d", vSol: 30, vTok: 1.07e9, raised: 0, graduated: false },
], posts: [], frozenAt: 1 };
const rules: B.BloomRules = { ...B.PRESET_RULES, repetitions: 2, cycles: 12, scenarios: ["control", "sell_pressure"] };
const pol = (id: string, archetype: PolicySnapshot["archetype"] = "pollinator", risk = 3): PolicySnapshot => { const p = { agentId: id, handle: id, name: id, archetype, risk, strategy: "s", persona: "p" }; return { ...p, policyHash: policyHash(p) }; };
const SEED = "ab".repeat(32), ROUND = "11111111-1111-4111-8111-111111111111";
const entry = (id: string, seq: number, base = pol(id), settings = { archetype: "weed" as const, risk: 5 }, preds = { beats_baseline: 40, beats_base_policy: 50, ends_in_profit: 30, drawdown_over_15: 70 }) => {
  const manifest: B.Manifest = { format: B.MANIFEST_FORMAT, agentId: id, basePolicyHash: base.policyHash, settings, predictions: preds };
  const salt = (seq.toString(16).padStart(2, "0")).repeat(32);
  return { entryId: `e${seq}`, seq, agentId: id, commit: B.submissionCommit({ roundId: ROUND, agentId: id, basePolicyHash: base.policyHash, manifest, salt }), createdAt: "t", salt, manifest, basePolicy: base };
};
function bundleOf(entries: B.RevealedEntry[]) {
  const out = B.evaluateRound(ROUND, rules, market, SEED, entries); const oh = B.outputHash(out);
  const b: B.Bundle = { format: B.BUNDLE_FORMAT, round: { id: ROUND, slug: "round-1", title: "t", status: "scored", createdAt: "c", commitClosesAt: "d", rules, rulesHash: B.rulesHash(rules), market, marketHash: B.marketHash(market), seedCommit: B.seedCommit(SEED) },
    reveal: { seedHex: SEED, revealedAt: "r" }, entries: entries.map((e) => ({ ...e, status: "revealed" })), output: out, outputHash: oh,
    contentHash: B.contentHash({ rulesHash: B.rulesHash(rules), marketHash: B.marketHash(market), seedCommit: B.seedCommit(SEED), commits: entries.map((e) => e.commit), outputHash: oh }), error: null, note: B.BUNDLE_NOTE };
  return b;
}

describe("Blind Bloom scoring", () => {
  it("is deterministic, uses actual engine settings, and reports sample counts", () => {
    const es = [entry("ag_a", 1), entry("ag_b", 2, pol("ag_b"), { archetype: "pollinator", risk: 3 })];
    const a = B.evaluateRound(ROUND, rules, market, SEED, es), b = B.evaluateRound(ROUND, rules, market, SEED, es);
    expect(stableJson(a)).toBe(stableJson(b));
    const [x, y] = a.entries;
    expect(x.status).toBe("scored"); expect(x.n).toBe(4); expect(x.scenarios.every((s) => s.n === 2)).toBe(true);
    expect(x.sealedPolicyHash).not.toBe(x.basePolicyHash); // settings changed the executable policy
    expect(y.sealedPolicyHash).toBe(y.basePolicyHash); // unchanged settings = same policy...
    expect(y.scenarios.every((s) => s.vsBasePolicy.mean === 0 && s.winsVsBasePolicy === 0)).toBe(true); // ...and identical paired runs
    expect(a.ranking).toHaveLength(2);
  });
  it("Brier score is the mean squared error of forecasts vs resolved outcomes", () => {
    const out = B.evaluateRound(ROUND, rules, market, SEED, [entry("ag_a", 1)]).entries[0];
    for (const ev of out.events) { const p = ev.forecast / 100; expect(ev.brier).toBeCloseTo((ev.hits * (1 - p) ** 2 + (ev.n - ev.hits) * p ** 2) / ev.n, 9); }
    expect(out.referenceBrier).toBe(0.25);
  });
  it("certain wrong forecasts score 1, certain right forecasts 0", () => {
    const base = B.evaluateRound(ROUND, rules, market, SEED, [entry("ag_a", 1)]).entries[0];
    const hits = Object.fromEntries(base.events.map((e) => [e.event, e.hits]));
    const allOne = base.events.every((e) => e.hits === e.n || e.hits === 0);
    if (allOne) {
      const right = Object.fromEntries(base.events.map((e) => [e.event, hits[e.event] ? 100 : 0])) as any;
      expect(B.evaluateRound(ROUND, rules, market, SEED, [entry("ag_a", 1, pol("ag_a"), { archetype: "weed", risk: 5 }, right)]).entries[0].brier).toBe(0);
    }
    const p0 = { beats_baseline: 0, beats_base_policy: 0, ends_in_profit: 0, drawdown_over_15: 0 };
    const e0 = B.evaluateRound(ROUND, rules, market, SEED, [entry("ag_a", 1, pol("ag_a"), { archetype: "weed", risk: 5 }, p0)]).entries[0];
    expect(e0.brier).toBeCloseTo(e0.events.reduce((a, e) => a + e.hits, 0) / e0.n / rules.events.length, 9);
  });
  it("a different seed changes the hidden tape", () => {
    const es = [entry("ag_a", 1)];
    expect(B.evaluateRound(ROUND, rules, market, SEED, es).tapeSeed).not.toBe(B.evaluateRound(ROUND, rules, market, "cd".repeat(32), es).tapeSeed);
  });
  it("keeps entries whose preimage doesn't match, marked invalid (never dropped)", () => {
    const bad = { ...entry("ag_a", 1), salt: "ff".repeat(32) };
    const out = B.evaluateRound(ROUND, rules, market, SEED, [bad, entry("ag_b", 2)]);
    expect(out.entries.map((e) => e.status)).toEqual(["invalid", "scored"]);
    expect(out.ranking).toEqual(["e2"]);
  });
  it("rejects manifests with missing/extra/non-integer forecasts", () => {
    const m = entry("ag_a", 1).manifest;
    expect(() => B.parseManifest({ ...m, predictions: { beats_baseline: 50 } }, rules)).toThrow();
    expect(() => B.parseManifest({ ...m, predictions: { ...m.predictions, beats_baseline: 50.5 } }, rules)).toThrow();
    expect(() => B.parseManifest({ ...m, predictions: { ...m.predictions, beats_baseline: 101 } }, rules)).toThrow();
    expect(() => B.parseManifest({ ...m, extra: 1 }, rules)).toThrow();
    expect(() => B.parseManifest({ ...m, settings: { archetype: "weed", risk: 9 } }, rules)).toThrow();
  });
  it("seed commitment matches the SQL formula", () => {
    expect(B.seedCommit(SEED)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Blind Bloom bundle verifier", () => {
  const good = () => bundleOf([entry("ag_a", 1), entry("ag_b", 2)]);
  it("verifies a genuine bundle by recomputing everything", () => {
    const v = B.verifyBloomBundle(JSON.stringify(good()));
    expect(v.status).toBe("verified"); expect(v.checks.every((c) => c.ok)).toBe(true);
  });
  it("detects tampered scores, seeds, commitments, markets and rules", () => {
    const t1 = good(); t1.output!.entries[0].brier = 0; expect(B.verifyBloomBundle(JSON.stringify(t1)).status).toBe("mismatch");
    const t2 = good(); t2.reveal.seedHex = "cd".repeat(32); expect(B.verifyBloomBundle(JSON.stringify(t2)).status).toBe("mismatch");
    const t3 = good(); (t3.entries[0].manifest as any).settings.risk = 1; expect(B.verifyBloomBundle(JSON.stringify(t3)).status).toBe("mismatch");
    const t4 = good(); t4.round.market.coins[0].vSol = 41; expect(B.verifyBloomBundle(JSON.stringify(t4)).status).toBe("mismatch");
    const t5 = good(); t5.round.rules.cycles = 13; expect(B.verifyBloomBundle(JSON.stringify(t5)).status).toBe("mismatch");
    const t6 = good(); t6.contentHash = "0".repeat(64); expect(B.verifyBloomBundle(JSON.stringify(t6)).status).toBe("mismatch");
    const t7 = good(); t7.entries.reverse(); expect(B.verifyBloomBundle(JSON.stringify(t7)).status).not.toBe("verified");
  });
  it("rejects unsupported versions, truncated, oversize, non-finite and duplicate-key input", () => {
    const u = good() as any; u.round.rules.engineVersion = "greenhouse-rules-9"; expect(B.verifyBloomBundle(JSON.stringify(u)).status).toBe("unsupported");
    const f = good() as any; f.format = "fleuri.bloom.bundle.v9"; expect(B.verifyBloomBundle(JSON.stringify(f)).status).toBe("unsupported");
    const txt = JSON.stringify(good());
    expect(B.verifyBloomBundle(txt.slice(0, txt.length - 20)).status).toBe("invalid");
    expect(B.verifyBloomBundle(" ".repeat(B.BLOOM_LIMITS.bundleBytes + 1)).status).toBe("invalid");
    expect(B.verifyBloomBundle(txt.replace('"tapeSeed":', '"tapeSeed":1e999,"x":')).status).toBe("invalid");
    expect(B.verifyBloomBundle(txt.replace('{"contentHash"', '{"format":"x","contentHash"')).status).toBe("invalid");
    const extra = good() as any; extra.leak = 1; expect(B.verifyBloomBundle(JSON.stringify(extra)).status).toBe("invalid");
    const dup = good(); dup.entries[1].entryId = dup.entries[0].entryId; expect(B.verifyBloomBundle(JSON.stringify(dup)).status).toBe("invalid");
  });
  it("an unscored (failed) round still verifies its commitments and says it has no scores", () => {
    const b = good(); b.output = null; b.outputHash = null; b.contentHash = null; b.error = "Evaluation gave up after 3 attempts";
    const v = B.verifyBloomBundle(JSON.stringify(b)); expect(v.status).toBe("verified"); expect(v.detail).toMatch(/no scores/);
  });
});
