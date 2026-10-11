import { describe, expect, it } from "vitest";
import { buildSeed } from "./seed";
import { createAgent, runCycle, startSession } from "./engine";
import { quoteBuy, quoteSell } from "./curve";
import {
  BUNDLE_FORMAT, START_CAPITAL, applyShock, buildTape, buildWorld, evidenceStatus, freezeMarket, makeBundle, makeInput, netLiquidationValue,
  policyHash, runBaseline, runTrial, scorecards, snapshotPolicy, stat, verifyBundle, type TrialConfig,
} from "./greenhouse";

const NOW = 1_800_000_000_000;
function garden() {
  const s = buildSeed(NOW);
  startSession(s, "owner1", NOW);
  createAgent(s, "owner1", { name: "Rosehip", handle: "rosehip", persona: "a thorny little test flower", strategy: "buy small, hold", archetype: "weed", risk: 5, avatar: 1, funding: 40 }, NOW);
  return s;
}
function setup(agentCount = 3, over: Partial<TrialConfig> = {}) {
  const s = garden();
  const agents = Object.values(s.agents).slice(0, agentCount);
  const cfg: TrialConfig = { agentIds: agents.map((a) => a.id), seed: 42, repetitions: 2, cycles: 20, scenarios: ["control", "liquidity_shock", "sell_pressure", "execution_failures"], ...over };
  return { s, agents, cfg, input: makeInput(cfg, freezeMarket(s, NOW), agents.map(snapshotPolicy)) };
}

describe("greenhouse trials", () => {
  it("is deterministic: the same frozen input replays to identical output", () => {
    const { input } = setup();
    expect(JSON.stringify(runTrial(input))).toBe(JSON.stringify(runTrial(structuredClone(input))));
  });

  it("selection order and co-participants cannot change an agent's result", () => {
    const { s, agents, cfg } = setup();
    const m = freezeMarket(s, NOW);
    const a = runTrial(makeInput(cfg, m, agents.map(snapshotPolicy)));
    const rev = runTrial(makeInput({ ...cfg, agentIds: [...cfg.agentIds].reverse() }, m, [...agents].reverse().map(snapshotPolicy)));
    const solo = runTrial(makeInput({ ...cfg, agentIds: [agents[1].id] }, m, [snapshotPolicy(agents[1])]));
    const pick = (o: ReturnType<typeof runTrial>, id: string) => JSON.stringify(o.runs.filter((r) => r.agentId === id));
    expect(pick(a, agents[1].id)).toBe(pick(rev, agents[1].id));
    expect(pick(a, agents[1].id)).toBe(pick(solo, agents[1].id));
    expect(JSON.stringify(a.baselines)).toBe(JSON.stringify(solo.baselines));
  });

  it("every participant and the baseline see the same external tape", () => {
    const { input } = setup();
    const out = runTrial(input);
    const t = out.tapes["sell_pressure:0"];
    expect(t.length).toBeGreaterThan(0);
    expect(buildTape(input.config, "sell_pressure", 0, input.market.coins.map((c) => c.symbol))).toEqual(t);
    expect(buildTape(input.config, "sell_pressure", 1, input.market.coins.map((c) => c.symbol))).not.toEqual(t);
    expect(out.tapes["control:0"]).toEqual([]);
  });

  it("does not mutate the live garden or the frozen snapshot", () => {
    const { s, input } = setup();
    const before = JSON.stringify(s), frozen = JSON.stringify(input);
    runTrial(input);
    expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("freezes only sanitized public market data", () => {
    const s = garden();
    s.owner!.wallet = { provider: "phantom", address: "W".repeat(44), verified: true, signedAt: NOW };
    const txt = JSON.stringify(setup().input) + JSON.stringify(freezeMarket(s, NOW));
    expect(txt).not.toMatch(/owner1|WWWW|vsol"|ledger|holders/);
  });

  it("uses the shared runCycle exactly: same world + same RNG gives the same decision stream as the engine", () => {
    const { agents, input } = setup(1);
    const pol = input.policies[0];
    const w1 = buildWorld(input.market, { ...structuredClone(agents[0]), cash: START_CAPITAL, holdings: {}, thoughts: [] }, 7);
    const w2 = structuredClone(w1);
    for (let i = 0; i < 10; i++) expect(runCycle(w1, pol.agentId, NOW + i).intended).toBe(runCycle(w2, pol.agentId, NOW + i).intended);
    const g = garden(), g2 = structuredClone(g);
    const id = Object.keys(g.agents)[0];
    const r1 = runCycle(g, id, NOW), r2 = runCycle(g2, id, NOW);
    expect(r1).toEqual(r2);
    if (!r1.error) expect(r1.intended).toBe(r1.decision);
  });

  it("net liquidation value includes price impact and fees, never inventing cash", () => {
    const { input } = setup(1);
    const w = buildWorld(input.market, { ...structuredClone(Object.values(garden().agents)[0]), id: "x", cash: 10, holdings: {} }, 1);
    const c = Object.values(w.coins)[0];
    const q = quoteBuy(c.vSol, c.vTok, 5);
    w.agents.x.cash = 5; w.agents.x.holdings[c.symbol] = { amount: q.tokensOut, cost: 5 };
    c.vSol = q.newSol; c.vTok = q.newTok;
    const nlv = netLiquidationValue(w, "x");
    expect(nlv).toBeCloseTo(5 + quoteSell(q.newSol, q.newTok, q.tokensOut).solOut, 9);
    expect(nlv).toBeLessThan(10); // a round trip loses two 1% fees
  });

  it("liquidity shocks keep price and remove depth; sell pressure lowers price", () => {
    const { input } = setup(1);
    const w = buildWorld(input.market, { ...structuredClone(Object.values(garden().agents)[0]), id: "x" }, 1);
    const c = Object.values(w.coins)[0]; const p0 = c.vSol / c.vTok, d0 = c.vSol;
    applyShock(w, { cycle: 0, kind: "liquidity", symbol: c.symbol, magnitude: 0.4 });
    expect(c.vSol / c.vTok).toBeCloseTo(p0, 12); expect(c.vSol).toBeCloseTo(d0 * 0.6, 9);
    applyShock(w, { cycle: 0, kind: "sell", symbol: c.symbol, magnitude: 0.1 });
    expect(c.vSol / c.vTok).toBeLessThan(p0);
  });

  it("baseline is an equal-weight buy-and-hold of the 3 deepest coins through the same engine", () => {
    const { input } = setup(1);
    const b = runBaseline(input.market, input.config, "control", 0);
    expect(b.trace.filter((t) => t[2] === "ok")).toHaveLength(3);
    expect(b.attempts).toBe(3); expect(b.successRate).toBe(100);
    expect(b.endValue).toBeLessThan(START_CAPITAL); // fees + impact on a static control market
    const f = runBaseline(input.market, { ...input.config, seed: 1 }, "execution_failures", 0);
    expect(f.trace.filter((t) => t[1] === "buy" && t[2] === "ok")).toHaveLength(3);
  });

  it("failure denominators count only attempted buy/sell/launch; zero attempts is unavailable", () => {
    const { input } = setup();
    const out = runTrial(input);
    for (const r of out.runs) {
      const econ = r.trace.filter((t) => ["buy", "sell", "launch"].includes(t[1]));
      expect(r.attempts).toBe(econ.length);
      expect(r.successes + r.rejections + r.faults).toBe(r.attempts);
      expect(r.successRate).toBe(r.attempts ? Math.round((r.successes / r.attempts) * 100 * 1e9) / 1e9 : null);
    }
    const fake = { ...out.runs[0], attempts: 0, successes: 0, rejections: 0, faults: 0, trace: [] };
    expect(scorecards([fake], out.baselines)[0].successRate).toBeNull();
  });

  it("injected faults roll back economic effects completely", () => {
    const { input } = setup(4, { cycles: 40 });
    const out = runTrial(input);
    const fr = out.runs.filter((r) => r.scenario === "execution_failures");
    expect(fr.reduce((a, r) => a + r.faults, 0)).toBeGreaterThan(0);
    for (const r of fr) r.trace.forEach((t, i) => { if (t[2] === "fault") expect(r.nlv[i]).toBeCloseTo(i ? r.nlv[i - 1] : START_CAPITAL, 9); });
    for (const r of out.runs.filter((x) => x.scenario !== "execution_failures")) expect(r.faults).toBe(0);
  });

  it("metric examples: drawdown, return and range", () => {
    expect(stat([1, 3])).toEqual({ mean: 2, min: 1, max: 3, sd: Math.round(Math.SQRT2 * 1e9) / 1e9, n: 2 });
    const { input } = setup(1);
    const r = runTrial(input).runs[0];
    let peak = START_CAPITAL, dd = 0;
    for (const v of r.nlv) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
    expect(r.maxDrawdownPct).toBeCloseTo(dd * 100, 6);
    expect(r.returnPct).toBeCloseTo(((r.endValue - 10) / 10) * 100, 6);
    const sc = runTrial(input).scorecards[0];
    expect(sc.returnPct.n).toBe(2); expect(sc.vsBaselinePct.n).toBe(2);
  });

  it("verifies exact replays and rejects tampering", () => {
    const { input } = setup(2, { repetitions: 1, cycles: 10 });
    const b = makeBundle(input, runTrial(input), "run1", "2026-10-11T00:00:00Z");
    expect(verifyBundle(JSON.stringify(b)).status).toBe("verified");
    const t1 = structuredClone(b); t1.output.runs[0].returnPct += 1;
    expect(verifyBundle(t1).status).toBe("mismatch");
    const t2 = structuredClone(b); t2.input.config.seed = 43;
    expect(verifyBundle(t2).status).toBe("mismatch");
    const t3 = structuredClone(b); t3.input.market.coins[0].vSol = 99;
    expect(verifyBundle(t3).status).toBe("mismatch");
    const t4 = structuredClone(b); t4.input.policies[0].risk = t4.input.policies[0].risk === 5 ? 4 : 5;
    expect(verifyBundle(t4).status).toBe("invalid"); // policy hash no longer matches
    const t5 = structuredClone(b) as any; t5.input.engineVersion = "greenhouse-rules-0";
    expect(verifyBundle(t5).status).toBe("unsupported");
    const t6 = structuredClone(b) as any; t6.format = "other";
    expect(verifyBundle(t6).status).toBe("invalid");
  });

  it("rejects bounded/pathological inputs", () => {
    const { s, agents, cfg } = setup(1);
    const m = freezeMarket(s, NOW), p = agents.map(snapshotPolicy);
    expect(() => makeInput({ ...cfg, cycles: 1000 }, m, p)).toThrow();
    expect(() => makeInput({ ...cfg, repetitions: 9 }, m, p)).toThrow();
    expect(() => makeInput({ ...cfg, agentIds: ["a", "b", "c", "d", "e"] }, m, p)).toThrow();
    expect(() => makeInput(cfg, { ...m, coins: [{ ...m.coins[0], vSol: -1 }] }, p)).toThrow();
    expect(() => makeInput(cfg, { ...m, coins: [{ ...m.coins[0], vTok: Infinity }] }, p)).toThrow();
    expect(() => makeInput(cfg, { ...m, coins: [{ ...m.coins[0], vSol: NaN }] }, p)).toThrow();
    expect(verifyBundle("x".repeat(2_000_001)).status).toBe("invalid");
    expect(verifyBundle("{").status).toBe("invalid");
    expect(BUNDLE_FORMAT).toMatch(/v1$/);
  });

  it("policy hash changes on any edit; evidence status reports stale/mismatch/legacy honestly", () => {
    const a = Object.values(garden().agents)[0];
    const h = policyHash(a);
    expect(policyHash({ ...a, strategy: a.strategy + "!" })).not.toBe(h);
    expect(evidenceStatus({ runPolicyHash: h, proposalPolicyHash: h, engineVersion: "greenhouse-rules-1" }, h)).toEqual({ policy: "match", currency: "current", engine: "supported" });
    expect(evidenceStatus({ runPolicyHash: h, proposalPolicyHash: null, engineVersion: "greenhouse-rules-1" }, "x").policy).toBe("unknown");
    expect(evidenceStatus({ runPolicyHash: h, proposalPolicyHash: "y", engineVersion: "old" }, "x")).toEqual({ policy: "mismatch", currency: "stale", engine: "unsupported" });
    expect(evidenceStatus({ runPolicyHash: h, proposalPolicyHash: h, engineVersion: "greenhouse-rules-1" }, null).currency).toBe("unavailable");
  });
});
