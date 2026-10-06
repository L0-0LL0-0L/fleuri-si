import { describe, expect, it } from "vitest";
import { buildSeed } from "./seed";
import { buy, createAgent, fundAgent, launch, runCycle, sell, setStatus, startSession, tick, updateAgent, withdrawAgent } from "./engine";
import { DomainError, type CreateAgentInput } from "./types";
import { LocalGardenRepository, MemoryKeyValue } from "@/services/repository";

const NOW = 1_800_000_000_000;
const input: CreateAgentInput = { name: "Rosehip", handle: "rosehip", persona: "a thorny little test flower", strategy: "buy small, hold", archetype: "gardener", risk: 3, avatar: 2, funding: 10 };

function setup() {
  const s = buildSeed(NOW);
  startSession(s, "owner1", NOW);
  return s;
}

describe("engine", () => {
  it("seeds a populated garden", () => {
    const s = buildSeed(NOW);
    expect(Object.keys(s.agents).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(s.coins).length).toBeGreaterThanOrEqual(8);
    expect(s.events.length).toBeGreaterThan(50);
  });

  it("creates and funds an agent from the owner wallet", () => {
    const s = setup();
    const a = createAgent(s, "owner1", input, NOW);
    expect(a.cash).toBe(10);
    expect(s.owner!.vsol).toBe(240);
    expect(s.events[0].agentId).toBe(a.id);
    expect(() => createAgent(s, "owner1", input, NOW)).toThrow(/handle/);
  });

  it("rejects zero, negative and excessive amounts", () => {
    const s = setup();
    const a = createAgent(s, "owner1", input, NOW);
    expect(() => fundAgent(s, "owner1", a.id, 0, NOW)).toThrow(DomainError);
    expect(() => fundAgent(s, "owner1", a.id, -1, NOW)).toThrow(DomainError);
    expect(() => withdrawAgent(s, "owner1", a.id, 11, NOW)).toThrow(DomainError);
    expect(() => fundAgent(s, "owner1", a.id, 1e6, NOW)).toThrow(DomainError);
    withdrawAgent(s, "owner1", a.id, 10, NOW);
    expect(a.cash).toBe(0);
    expect(s.owner!.vsol).toBe(250);
  });

  it("enforces ownership", () => {
    const s = setup();
    const a = createAgent(s, "owner1", input, NOW);
    expect(() => fundAgent(s, "intruder", a.id, 1, NOW)).toThrow(/owner/);
    expect(() => updateAgent(s, "intruder", a.id, { name: "Hax" }, NOW)).toThrow(/owner/);
    expect(() => setStatus(s, "owner1", "a_seed0", "paused", NOW)).toThrow(/owner/);
  });

  it("pause stops cycles, resume restores", () => {
    const s = setup();
    const a = createAgent(s, "owner1", input, NOW);
    setStatus(s, "owner1", a.id, "paused", NOW);
    expect(() => runCycle(s, a.id, NOW)).toThrow(/paused/);
    setStatus(s, "owner1", a.id, "active", NOW);
    expect(runCycle(s, a.id, NOW + 1).decision).toBeTruthy();
  });

  it("buy/sell keep holders, fees and cash consistent", () => {
    const s = setup();
    const a = createAgent(s, "owner1", input, NOW);
    buy(s, a.id, "BLOOM", 2, NOW);
    expect(a.cash).toBeCloseTo(8);
    expect(s.coins.BLOOM.holders[a.id]).toBeGreaterThan(0);
    sell(s, a.id, "BLOOM", 1, NOW + 1);
    expect(a.holdings.BLOOM).toBeUndefined();
    expect(a.cash).toBeLessThan(10); // fees paid
    expect(() => launch(s, a.id, { name: "x", symbol: "BLOOM", tagline: "" }, NOW)).toThrow(/exists/);
  });

  it("long simulation never produces negative balances", () => {
    const s = setup();
    for (let i = 0; i < 1000; i++) tick(s, NOW + i * 1000);
    for (const a of Object.values(s.agents)) expect(a.cash).toBeGreaterThanOrEqual(0);
    for (const c of Object.values(s.coins)) expect(c.raised).toBeGreaterThanOrEqual(0);
  });

  it("persists and reloads through the repository", async () => {
    const kv = new MemoryKeyValue();
    const repo = new LocalGardenRepository(kv);
    const s = setup();
    createAgent(s, "owner1", input, NOW);
    await repo.save(s);
    const back = await repo.load();
    expect(back?.owner?.id).toBe("owner1");
    expect(Object.values(back!.agents).some((a) => a.handle === "rosehip")).toBe(true);
    kv.setItem([...kv.map.keys()][0], "{corrupt");
    expect(await repo.load()).toBeNull();
  });
});
