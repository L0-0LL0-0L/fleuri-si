import { describe, expect, it } from "vitest";
import { buildSeed } from "./seed";
import { createAgent, buy, sell, startSession } from "./engine";
import {
  ENGINE_VERSION, START_CAPITAL, boundedJson, bundleFromStored, buildWorld, contentHash, freezeMarket, inputHash, makeInput, netLiquidationValue,
  normalizeConfig, outputHash, restoreInput, runBaseline, runTrial, sameConfig, snapshotPolicy, verifyBundle, type TrialConfig,
} from "./greenhouse";
import type { Agent } from "./types";

const NOW = 1_800_000_000_000;
function setup(over: Partial<TrialConfig> = {}) {
  const s = buildSeed(NOW);
  startSession(s, "owner1", NOW);
  createAgent(s, "owner1", { name: "Rosehip", handle: "rosehip", persona: "p", strategy: "s", archetype: "weed", risk: 5, avatar: 1, funding: 40 }, NOW);
  const agents = Object.values(s.agents).slice(0, 2);
  const cfg: TrialConfig = { agentIds: agents.map((a) => a.id), seed: 7, repetitions: 1, cycles: 10, scenarios: ["control", "sell_pressure"], ...over };
  return { s, agents, cfg, input: makeInput(cfg, freezeMarket(s, NOW), agents.map(snapshotPolicy)) };
}
const market = { coins: [{ symbol: "BLOOM", name: "Bloom", vSol: 30, vTok: 1_073_000_000, raised: 0, graduated: false }], posts: [], frozenAt: 1 };
function own(creator: string) {
  const a = { id: "me", handle: "me", name: "me", bio: "", persona: "", strategy: "", archetype: "gardener", risk: 1, avatar: 0, ownerId: "x", status: "active", cash: 100, fundedTotal: 100, holdings: {}, followers: 0, following: [], createdAt: 0, lastActionAt: 0, thoughts: [], realizedPnl: 0 } as Agent;
  const w = buildWorld(market, a, 1);
  w.coins.BLOOM.creatorId = creator;
  buy(w, "me", "BLOOM", 10, 1);
  return w;
}

describe("greenhouse hardening", () => {
  it("NLV equals the engine's actual full-sell cash for the participant's own coin (creator rebate)", () => {
    const w = own("me");
    const nlv = netLiquidationValue(w, "me");
    const clone = structuredClone(w); sell(clone, "me", "BLOOM", 1, 2);
    expect(nlv).toBeCloseTo(clone.agents.me.cash, 5);
    expect(nlv).toBeCloseTo(99.9005, 3);
    expect(Number.isFinite(nlv)).toBe(true);
  });
  it("NLV for an external-creator coin matches the 99.801 oracle (no rebate)", () => {
    const w = own("market");
    const nlv = netLiquidationValue(w, "me");
    const clone = structuredClone(w); sell(clone, "me", "BLOOM", 1, 2);
    expect(nlv).toBeCloseTo(clone.agents.me.cash, 5);
    expect(nlv).toBeCloseTo(99.801, 3);
  });
  it("engine version is bumped and baseline still starts from the normalized capital", () => {
    expect(ENGINE_VERSION).toBe("greenhouse-rules-2");
    expect(runBaseline(setup().input.market, setup().input.config, "control", 0).startValue).toBe(START_CAPITAL);
  });
  it("normalizes config before equality; a different seed is a conflict", () => {
    const { cfg } = setup();
    const swapped = { ...cfg, agentIds: [...cfg.agentIds].reverse(), scenarios: [...cfg.scenarios].reverse() as any };
    expect(normalizeConfig(swapped)).toEqual(normalizeConfig(cfg));
    expect(sameConfig(swapped, normalizeConfig(cfg))).toBe(true);
    expect(sameConfig({ ...cfg, seed: 8 }, normalizeConfig(cfg))).toBe(false);
    expect(sameConfig(cfg, { garbage: true })).toBe(false);
  });
  it("restoreInput never relabels an old version and checks the stored checksum", () => {
    const { input } = setup();
    const ih = inputHash(input);
    expect(restoreInput(structuredClone(input), ih)).toEqual(input);
    expect(() => restoreInput({ ...input, engineVersion: "greenhouse-rules-1" }, ih)).toThrow(/unsupported engine greenhouse-rules-1/);
    expect(() => restoreInput({ ...input, scenarioVersion: "x" }, ih)).toThrow(/unsupported/);
    expect(() => restoreInput(input, "0".repeat(64))).toThrow(/checksum/);
    expect(() => restoreInput({ ...input, config: { ...input.config, agentIds: [...input.config.agentIds].reverse() } }, ih)).toThrow(/canonical/);
  });
  it("export carries the ORIGINAL stored claims and replay flags stored tampering", () => {
    const { input } = setup();
    const out = runTrial(input), ih = inputHash(input), oh = outputHash(out);
    const row = { id: "r1", created_at: "2026-10-11T00:00:00Z", input, output: out, input_hash: ih, output_hash: oh, content_hash: contentHash(ih, oh) };
    expect(verifyBundle(bundleFromStored(row)).status).toBe("verified");
    // stored output edited (claims left alone): flagged, not regenerated
    const t1 = structuredClone(row); t1.output.runs[0].returnPct += 1;
    expect(verifyBundle(bundleFromStored(t1))).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/output checksum/) });
    // stored output hash edited to match edited output: content checksum catches it
    const t2 = structuredClone(t1); t2.output_hash = outputHash(t2.output);
    expect(verifyBundle(bundleFromStored(t2))).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/content checksum/) });
    // everything re-hashed consistently: replay itself catches it
    const t3 = structuredClone(t2); t3.content_hash = contentHash(ih, t3.output_hash);
    expect(verifyBundle(bundleFromStored(t3))).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/Re-running/) });
    const t4 = structuredClone(row); t4.input_hash = "f".repeat(64);
    expect(verifyBundle(bundleFromStored(t4)).status).toBe("mismatch");
    const t5 = structuredClone(row); t5.content_hash = null as any;
    expect(verifyBundle(bundleFromStored(t5)).status).toBe("invalid");
  });
  it("unsupported engines export originals and refuse replay", () => {
    const { input } = setup();
    const out = runTrial(input);
    const old = { id: "r", created_at: "x", input: { ...input, engineVersion: "greenhouse-rules-1" }, output: out, input_hash: "a".repeat(64), output_hash: "b".repeat(64), content_hash: "c".repeat(64) };
    const b = bundleFromStored(old);
    expect(b.input).toBe(old.input); expect(b.outputHash).toBe("b".repeat(64));
    expect(verifyBundle(b).status).toBe("unsupported");
  });
  it("malformed, deep or non-finite inputs fail cleanly without throwing", () => {
    let deep: any = 1; for (let i = 0; i < 5000; i++) deep = [deep];
    expect(boundedJson(deep)).toMatch(/deep/);
    expect(verifyBundle(deep).status).toBe("invalid");
    expect(verifyBundle({ format: "fleuri.greenhouse.bundle.v1", x: NaN }).status).toBe("invalid");
    expect(verifyBundle(null).status).toBe("invalid");
    expect(verifyBundle("[".repeat(100000)).status).toBe("invalid");
    expect(() => verifyBundle({ get format() { throw new Error("boom"); } })).not.toThrow();
  });
});
