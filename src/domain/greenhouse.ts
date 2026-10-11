// Greenhouse Trials: deterministic vSOL sandbox stress tests of the CURRENT rules engine.
// Pure and isomorphic. Every participant runs in its own clone of one frozen public market,
// with an external shock tape that is independent of agent randomness and selection order.
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { quoteSell } from "./curve";
import { buy as engineBuy, runCycle, MIN_TRADE, type Decision } from "./engine";
import { DomainError, type Agent, type Archetype, type Coin, type GardenEvent, type GardenState } from "./types";

export const ENGINE_VERSION = "greenhouse-rules-1";
export const SCENARIO_VERSION = "greenhouse-scenarios-1";
export const BUNDLE_FORMAT = "fleuri.greenhouse.bundle.v1";
export const SUPPORTED_ENGINES = [ENGINE_VERSION] as const;
export const START_CAPITAL = 10; // vSOL given to every participant and the baseline
export const BASELINE_COINS = 3;
export const CYCLE_MS = 300_000;
export const SYNTHETIC_T0 = 1_700_000_000_000; // fixed synthetic clock, never Date.now()
export const LIMITS = { agents: 4, reps: 5, cyclesMin: 5, cyclesMax: 60, coins: 40, posts: 30, bundleBytes: 2_000_000 } as const;
export const SCENARIOS = ["control", "liquidity_shock", "sell_pressure", "execution_failures"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_INFO: Record<Scenario, { label: string; detail: string }> = {
  control: { label: "Control", detail: "No external shocks. Same frozen market, fees and price impact." },
  liquidity_shock: { label: "Liquidity shock", detail: "Each cycle has a 15% chance that 20–50% of one frozen coin's virtual reserves are withdrawn (price unchanged, depth reduced)." },
  sell_pressure: { label: "Sell pressure", detail: "Each cycle has a 30% chance an outside seller dumps tokens into one frozen coin, removing 3–10% of its vSOL reserve." },
  execution_failures: { label: "Execution failures", detail: "Each cycle has a 35% chance any buy/sell/launch attempt is rejected by an injected fault and fully rolled back." },
};
const ECON: Decision[] = ["buy", "sell", "launch"];

// ---------- hashing (stable JSON; numbers use the JS spec's deterministic formatting) ----------
export function stableJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite number"); return JSON.stringify(v); }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(",")}}`;
  throw new Error(`unsupported ${typeof v}`);
}
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const hashOf = (domain: string, v: unknown) => hexOf(sha256(new TextEncoder().encode(`${domain}\n${stableJson(v)}`)));
export function seed32(...parts: (string | number)[]) {
  const h = sha256(new TextEncoder().encode(parts.join("|")));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}
function mulberry(seed: number) {
  let s = seed | 0;
  return () => { let t = (s = (s + 0x6d2b79f5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r9 = (n: number) => Math.round(n * 1e9) / 1e9;

// ---------- schemas (shared strict parser) ----------
const fin = z.number().finite();
const sym = z.string().regex(/^[A-Z]{3,6}$/);
export const ConfigSchema = z.object({
  agentIds: z.array(z.string().min(1).max(40)).min(1).max(LIMITS.agents).refine((a) => new Set(a).size === a.length, "duplicate agents"),
  seed: z.number().int().min(0).max(0xffffffff),
  repetitions: z.number().int().min(1).max(LIMITS.reps),
  cycles: z.number().int().min(LIMITS.cyclesMin).max(LIMITS.cyclesMax),
  scenarios: z.array(z.enum(SCENARIOS)).min(1).max(4).refine((a) => new Set(a).size === a.length, "duplicate scenarios"),
}).strict();
export type TrialConfig = z.infer<typeof ConfigSchema>;
export const MarketCoinSchema = z.object({ symbol: sym, name: z.string().max(40), vSol: fin.positive().max(1e9), vTok: fin.positive().max(1e15), raised: fin.min(0).max(1e9), graduated: z.boolean() }).strict();
export const MarketSchema = z.object({ coins: z.array(MarketCoinSchema).min(1).max(LIMITS.coins), posts: z.array(z.object({ symbol: sym.nullable() }).strict()).max(LIMITS.posts), frozenAt: z.number().int().positive() }).strict()
  .refine((m) => new Set(m.coins.map((c) => c.symbol)).size === m.coins.length, "duplicate coins");
export type FrozenMarket = z.infer<typeof MarketSchema>;
export const PolicySchema = z.object({
  agentId: z.string().min(1).max(40), handle: z.string().max(20), name: z.string().max(32),
  archetype: z.enum(["pollinator", "gardener", "weed", "botanist", "compost"]), risk: z.number().int().min(1).max(5),
  strategy: z.string().max(300), persona: z.string().max(400), policyHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type PolicySnapshot = z.infer<typeof PolicySchema>;

/** Hash over every owner-editable field that defines the agent's policy; any edit changes it. */
export function policyHash(a: Pick<Agent, "archetype" | "risk" | "strategy" | "persona">) {
  return hashOf("fleuri.greenhouse.policy.v1", { archetype: a.archetype, risk: a.risk, strategy: a.strategy, persona: a.persona });
}
export function snapshotPolicy(a: Agent): PolicySnapshot {
  return { agentId: a.id, handle: a.handle, name: a.name, archetype: a.archetype, risk: a.risk, strategy: a.strategy, persona: a.persona, policyHash: policyHash(a) };
}
/** Sanitized, bounded public market: reserves only. No owners, wallets, ledgers or holders. */
export function freezeMarket(s: Pick<GardenState, "coins" | "events">, frozenAt: number): FrozenMarket {
  const coins = Object.values(s.coins).filter((c) => /^[A-Z]{3,6}$/.test(c.symbol) && c.vSol > 0 && c.vTok > 0 && Number.isFinite(c.vSol) && Number.isFinite(c.vTok))
    .sort((a, b) => b.vSol - a.vSol || a.symbol.localeCompare(b.symbol)).slice(0, LIMITS.coins)
    .map((c) => ({ symbol: c.symbol, name: c.name.slice(0, 40), vSol: c.vSol, vTok: c.vTok, raised: Math.max(0, c.raised), graduated: !!c.graduated }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const posts = s.events.filter((e) => e.kind === "post" || e.kind === "launch").slice(0, LIMITS.posts).map((e) => ({ symbol: e.symbol && coins.some((c) => c.symbol === e.symbol) ? e.symbol : null }));
  if (!coins.length) throw new DomainError("The garden has no coins to trial against.");
  return { coins, posts, frozenAt: Math.floor(frozenAt) };
}

// ---------- simulation ----------
type Outcome = "ok" | "rejected" | "fault" | "idle";
export type TraceRow = [cycle: number, intended: string, outcome: Outcome, symbol: string | null, sol: number | null, note: string];
export interface Shock { cycle: number; kind: "liquidity" | "sell" | "fault"; symbol: string | null; magnitude: number }
export interface RunResult { agentId: string; scenario: Scenario; rep: number; startValue: number; endValue: number; returnPct: number; maxDrawdownPct: number; attempts: number; successes: number; rejections: number; faults: number; successRate: number | null; nlv: number[]; trace: TraceRow[] }

/** External tape: depends only on seed/scenario/rep and frozen symbols — never on agents. */
export function buildTape(cfg: Pick<TrialConfig, "seed" | "cycles">, scenario: Scenario, rep: number, symbols: string[]): Shock[] {
  const rnd = mulberry(seed32("tape", SCENARIO_VERSION, cfg.seed, scenario, rep));
  const out: Shock[] = [];
  for (let c = 0; c < cfg.cycles; c++) {
    const a = rnd(), b = rnd(), m = rnd(); // always consume 3 draws per cycle
    const symbol = symbols[Math.floor(b * symbols.length)] ?? null;
    if (scenario === "liquidity_shock" && a < 0.15) out.push({ cycle: c, kind: "liquidity", symbol, magnitude: r9(0.2 + m * 0.3) });
    if (scenario === "sell_pressure" && a < 0.3) out.push({ cycle: c, kind: "sell", symbol, magnitude: r9(0.03 + m * 0.07) });
    if (scenario === "execution_failures" && a < 0.35) out.push({ cycle: c, kind: "fault", symbol: null, magnitude: 1 });
  }
  return out;
}

const PEERS = ["peer_a", "peer_b", "peer_c"];
function stubAgent(id: string, p: Partial<Agent>): Agent {
  return { id, handle: id, name: id, bio: "", persona: "", strategy: "", archetype: "gardener", risk: 1, avatar: 0, ownerId: "greenhouse", status: "active", cash: 0, fundedTotal: 0, holdings: {}, followers: 0, following: [], createdAt: SYNTHETIC_T0, lastActionAt: SYNTHETIC_T0, thoughts: [], realizedPnl: 0, ...p };
}
/** Fresh world for one participant: normalized capital, no holdings, own market clone. */
export function buildWorld(market: FrozenMarket, participant: Agent, rng: number): GardenState {
  const coins: Record<string, Coin> = {};
  for (const c of market.coins) coins[c.symbol] = { symbol: c.symbol, name: c.name, tagline: "", creatorId: "market", createdAt: SYNTHETIC_T0, vSol: c.vSol, vTok: c.vTok, raised: c.raised, graduated: c.graduated, history: [], holders: {}, buys: 0, sells: 0, volume: 0, fees: 0, avatar: 0 };
  const agents: Record<string, Agent> = { [participant.id]: participant };
  for (const p of PEERS) agents[p] = stubAgent(p, {});
  const events: GardenEvent[] = market.posts.map((p, i) => ({ id: `m_${i}`, t: SYNTHETIC_T0 - i, kind: "post", agentId: PEERS[i % PEERS.length], symbol: p.symbol ?? undefined, text: "", botLikes: 0, replyCount: 0 }));
  return { version: 1, rng, seq: 0, agents, coins, events, ledger: [], treasury: 0, owner: null, alerts: [], prefs: { agents: [], coins: [], kinds: [], ownedAgents: false }, observer: { likes: [], bookmarks: [] } };
}
export function applyShock(s: GardenState, sh: Shock) {
  const c = sh.symbol ? s.coins[sh.symbol] : undefined;
  if (!c) return;
  if (sh.kind === "liquidity") { const keep = 1 - sh.magnitude; c.vSol = Math.max(1, c.vSol * keep); c.vTok = c.vSol / (c.vSol / keep / c.vTok * keep); /* price preserved */ c.vTok = Math.max(1, c.vTok); }
  if (sh.kind === "sell") { const newSol = Math.max(1, c.vSol * (1 - sh.magnitude)); const k = c.vSol * c.vTok; c.vTok = k / newSol; c.vSol = newSol; c.raised = Math.max(0, c.raised - sh.magnitude * c.raised); }
}
/** Net liquidation value: cash plus what selling every position into the current curve would return after fees and price impact. */
export function netLiquidationValue(s: GardenState, agentId: string) {
  const a = s.agents[agentId];
  let v = a.cash;
  for (const [sy, h] of Object.entries(a.holdings)) { const c = s.coins[sy]; if (c && h.amount > 0) v += quoteSell(c.vSol, c.vTok, h.amount).solOut; }
  return v;
}

function finish(agentId: string, scenario: Scenario, rep: number, nlv: number[], trace: TraceRow[]): RunResult {
  let peak = START_CAPITAL, dd = 0;
  for (const v of nlv) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  const econ = trace.filter((t) => ECON.includes(t[1] as Decision));
  const attempts = econ.length, successes = econ.filter((t) => t[2] === "ok").length;
  const end = nlv[nlv.length - 1] ?? START_CAPITAL;
  return { agentId, scenario, rep, startValue: START_CAPITAL, endValue: r9(end), returnPct: r9((end - START_CAPITAL) / START_CAPITAL * 100), maxDrawdownPct: r9(dd * 100), attempts, successes,
    rejections: econ.filter((t) => t[2] === "rejected").length, faults: econ.filter((t) => t[2] === "fault").length, successRate: attempts ? r9(successes / attempts * 100) : null, nlv: nlv.map(r9), trace };
}

export function runParticipant(market: FrozenMarket, pol: PolicySnapshot, cfg: TrialConfig, scenario: Scenario, rep: number): RunResult {
  const agent = stubAgent(pol.agentId, { handle: pol.handle, name: pol.name, archetype: pol.archetype as Archetype, risk: pol.risk, strategy: pol.strategy, persona: pol.persona, cash: START_CAPITAL, fundedTotal: START_CAPITAL });
  let s = buildWorld(market, agent, seed32("agent", ENGINE_VERSION, cfg.seed, rep, pol.agentId));
  const tape = buildTape(cfg, scenario, rep, market.coins.map((c) => c.symbol));
  const nlv: number[] = [], trace: TraceRow[] = [];
  for (let c = 0; c < cfg.cycles; c++) {
    const now = SYNTHETIC_T0 + (c + 1) * CYCLE_MS;
    for (const sh of tape) if (sh.cycle === c && sh.kind !== "fault") applyShock(s, sh);
    const fault = tape.some((sh) => sh.cycle === c && sh.kind === "fault");
    const draft = structuredClone(s);
    const r = runCycle(draft, pol.agentId, now);
    const ev = r.event;
    const econ = ECON.includes(r.intended);
    if (econ && !r.error && fault) {
      s.rng = draft.rng; s.seq = draft.seq; // keep agent RNG stream; economic effects discarded
      trace.push([c, r.intended, "fault", ev?.symbol ?? null, null, "injected execution failure; rolled back"]);
    } else {
      s = draft;
      trace.push([c, r.intended, r.error ? "rejected" : econ ? "ok" : "idle", ev?.symbol ?? null, ev?.sol != null ? r9(ev.sol) : null, r.error ? r.error.slice(0, 120) : ""]);
    }
    nlv.push(netLiquidationValue(s, pol.agentId));
  }
  return finish(pol.agentId, scenario, rep, nlv, trace);
}

/** Buy-and-hold: equal split of START_CAPITAL across the BASELINE_COINS deepest frozen coins, bought through the same engine at the first cycle whose execution is not faulted, then held. */
export function runBaseline(market: FrozenMarket, cfg: TrialConfig, scenario: Scenario, rep: number): RunResult {
  const id = "baseline";
  let s = buildWorld(market, stubAgent(id, { cash: START_CAPITAL }), 1);
  const targets = [...market.coins].sort((a, b) => b.vSol - a.vSol || a.symbol.localeCompare(b.symbol)).slice(0, BASELINE_COINS).map((c) => c.symbol);
  const tape = buildTape(cfg, scenario, rep, market.coins.map((c) => c.symbol));
  const nlv: number[] = [], trace: TraceRow[] = [];
  let entered = false;
  for (let c = 0; c < cfg.cycles; c++) {
    const now = SYNTHETIC_T0 + (c + 1) * CYCLE_MS;
    for (const sh of tape) if (sh.cycle === c && sh.kind !== "fault") applyShock(s, sh);
    if (!entered) {
      const fault = tape.some((sh) => sh.cycle === c && sh.kind === "fault");
      const each = Math.floor((START_CAPITAL / targets.length) * 1e4) / 1e4;
      if (fault) for (const t of targets) trace.push([c, "buy", "fault", t, null, "injected execution failure; retry next cycle"]);
      else {
        entered = true;
        for (const t of targets) {
          const draft = structuredClone(s);
          try { engineBuy(draft, id, t, each, now); s = draft; trace.push([c, "buy", "ok", t, each, "baseline entry"]); }
          catch (e) { if (!(e instanceof DomainError)) throw e; trace.push([c, "buy", "rejected", t, null, e.message]); }
        }
      }
    } else trace.push([c, "hold", "idle", null, null, ""]);
    nlv.push(netLiquidationValue(s, id));
  }
  return finish(id, scenario, rep, nlv, trace);
}

// ---------- aggregation ----------
export interface Stat { mean: number; min: number; max: number; sd: number; n: number }
export function stat(xs: number[]): Stat {
  if (!xs.length) return { mean: 0, min: 0, max: 0, sd: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { mean: r9(mean), min: r9(Math.min(...xs)), max: r9(Math.max(...xs)), sd: r9(sd), n: xs.length };
}
export interface Scorecard { agentId: string; scenario: Scenario; returnPct: Stat; maxDrawdownPct: Stat; vsBaselinePct: Stat; attempts: number; successes: number; rejections: number; faults: number; successRate: number | null }
export function scorecards(runs: RunResult[], baselines: RunResult[]): Scorecard[] {
  const keys = [...new Set(runs.map((r) => `${r.agentId}\u0000${r.scenario}`))];
  return keys.map((k) => {
    const [agentId, scenario] = k.split("\u0000") as [string, Scenario];
    const rs = runs.filter((r) => r.agentId === agentId && r.scenario === scenario);
    const diffs = rs.map((r) => r.returnPct - (baselines.find((b) => b.scenario === scenario && b.rep === r.rep)?.returnPct ?? NaN)).filter(Number.isFinite);
    const sum = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0);
    const attempts = sum((r) => r.attempts), successes = sum((r) => r.successes);
    return { agentId, scenario, returnPct: stat(rs.map((r) => r.returnPct)), maxDrawdownPct: stat(rs.map((r) => r.maxDrawdownPct)), vsBaselinePct: stat(diffs), attempts, successes, rejections: sum((r) => r.rejections), faults: sum((r) => r.faults), successRate: attempts ? r9(successes / attempts * 100) : null };
  });
}

export interface TrialInput { engineVersion: string; scenarioVersion: string; config: TrialConfig; market: FrozenMarket; policies: PolicySnapshot[] }
export interface TrialOutput { runs: RunResult[]; baselines: RunResult[]; scorecards: Scorecard[]; tapes: Record<string, Shock[]> }

export function makeInput(config: TrialConfig, market: FrozenMarket, policies: PolicySnapshot[]): TrialInput {
  const cfg = ConfigSchema.parse(config);
  const m = MarketSchema.parse(market);
  const pols = policies.map((p) => PolicySchema.parse(p)).sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const p of pols) if (p.policyHash !== policyHash(p)) throw new DomainError(`Policy snapshot for @${p.handle} does not match its hash.`);
  const ids = [...cfg.agentIds].sort();
  if (stableJson(ids) !== stableJson(pols.map((p) => p.agentId))) throw new DomainError("Policies must match the selected agents.");
  return { engineVersion: ENGINE_VERSION, scenarioVersion: SCENARIO_VERSION, config: { ...cfg, agentIds: ids, scenarios: SCENARIOS.filter((x) => cfg.scenarios.includes(x)) }, market: m, policies: pols };
}
export const inputHash = (i: TrialInput) => hashOf("fleuri.greenhouse.input.v1", i);
export const outputHash = (o: TrialOutput) => hashOf("fleuri.greenhouse.output.v1", o);

export function runTrial(input: TrialInput): TrialOutput {
  if (!SUPPORTED_ENGINES.includes(input.engineVersion as any) || input.scenarioVersion !== SCENARIO_VERSION) throw new DomainError(`Unsupported engine ${input.engineVersion}/${input.scenarioVersion}.`);
  const { config: cfg, market } = input;
  const runs: RunResult[] = [], baselines: RunResult[] = [], tapes: Record<string, Shock[]> = {};
  const symbols = market.coins.map((c) => c.symbol);
  for (const sc of cfg.scenarios) for (let rep = 0; rep < cfg.repetitions; rep++) {
    tapes[`${sc}:${rep}`] = buildTape(cfg, sc, rep, symbols);
    baselines.push(runBaseline(market, cfg, sc, rep));
    for (const p of input.policies) runs.push(runParticipant(market, p, cfg, sc, rep));
  }
  return { runs, baselines, scorecards: scorecards(runs, baselines), tapes };
}

// ---------- portable bundle ----------
export interface Bundle { format: typeof BUNDLE_FORMAT; runId: string | null; createdAt: string | null; input: TrialInput; inputHash: string; output: TrialOutput; outputHash: string; contentHash: string; note: string }
export const contentHash = (inH: string, outH: string) => hashOf("fleuri.greenhouse.content.v1", { inputHash: inH, outputHash: outH });
export function makeBundle(input: TrialInput, output: TrialOutput, runId: string | null = null, createdAt: string | null = null): Bundle {
  const ih = inputHash(input), oh = outputHash(output);
  return { format: BUNDLE_FORMAT, runId, createdAt, input, inputHash: ih, output, outputHash: oh, contentHash: contentHash(ih, oh), note: "vSOL sandbox stress model. SHA-256 checksums detect changes; they are not signatures and nothing here is on chain." };
}
export type ReplayStatus = { status: "verified" | "mismatch" | "unsupported" | "invalid"; detail: string; recomputed?: { inputHash: string; outputHash: string } };
const BundleShape = z.object({ format: z.literal(BUNDLE_FORMAT), runId: z.string().max(64).nullable(), createdAt: z.string().max(40).nullable(), input: z.object({ engineVersion: z.string().max(40), scenarioVersion: z.string().max(40), config: z.unknown(), market: z.unknown(), policies: z.array(z.unknown()).max(LIMITS.agents) }).strict(), inputHash: z.string(), output: z.unknown(), outputHash: z.string(), contentHash: z.string(), note: z.string().max(400) }).strict();

/** Strict, bounded parse + exact deterministic re-execution. Accepts raw JSON text or an object. */
export function verifyBundle(raw: string | unknown): ReplayStatus {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > LIMITS.bundleBytes) return { status: "invalid", detail: "Bundle is larger than the 2 MB limit." };
    try { obj = JSON.parse(raw); } catch { return { status: "invalid", detail: "Not valid JSON." }; }
  }
  const b = BundleShape.safeParse(obj);
  if (!b.success) return { status: "invalid", detail: `Bundle shape rejected: ${b.error.issues[0]?.path.join(".")} ${b.error.issues[0]?.message}` };
  const bd = b.data;
  if (!SUPPORTED_ENGINES.includes(bd.input.engineVersion as any) || bd.input.scenarioVersion !== SCENARIO_VERSION) return { status: "unsupported", detail: `Engine ${bd.input.engineVersion} / ${bd.input.scenarioVersion} is not supported by this build (supports ${ENGINE_VERSION}). It cannot be replayed here.` };
  let input: TrialInput;
  try { input = makeInput(bd.input.config as TrialConfig, bd.input.market as FrozenMarket, bd.input.policies as PolicySnapshot[]); }
  catch (e) { return { status: "invalid", detail: `Inputs rejected: ${(e as Error).message.slice(0, 200)}` }; }
  if (stableJson(input) !== stableJson(bd.input)) return { status: "invalid", detail: "Inputs are not in canonical form (reordered or normalized fields)." };
  const ih = inputHash(input);
  if (ih !== bd.inputHash) return { status: "mismatch", detail: "Input hash does not match the inputs — config, market or policies were changed." };
  const out = runTrial(input);
  const oh = outputHash(out);
  if (oh !== bd.outputHash) return { status: "mismatch", detail: "Re-running the frozen inputs gives a different output hash than the bundle claims.", recomputed: { inputHash: ih, outputHash: oh } };
  let claimed: string;
  try { claimed = outputHash(bd.output as TrialOutput); } catch { return { status: "mismatch", detail: "Bundled results are malformed." }; }
  if (claimed !== oh) return { status: "mismatch", detail: "Bundled results were edited: they don't hash to the replayed output.", recomputed: { inputHash: ih, outputHash: oh } };
  if (contentHash(ih, oh) !== bd.contentHash) return { status: "mismatch", detail: "Content hash does not match." };
  return { status: "verified", detail: "Exact replay: recomputed input and output hashes match the bundle.", recomputed: { inputHash: ih, outputHash: oh } };
}

// ---------- proposal evidence status ----------
export type EvidenceLabel = { policy: "match" | "mismatch" | "unknown"; currency: "current" | "stale" | "unavailable"; engine: "supported" | "unsupported" };
export function evidenceStatus(e: { runPolicyHash: string; proposalPolicyHash: string | null; engineVersion: string }, currentPolicyHash: string | null): EvidenceLabel {
  return {
    policy: e.proposalPolicyHash == null ? "unknown" : e.proposalPolicyHash === e.runPolicyHash ? "match" : "mismatch",
    currency: currentPolicyHash == null ? "unavailable" : currentPolicyHash === e.runPolicyHash ? "current" : "stale",
    engine: SUPPORTED_ENGINES.includes(e.engineVersion as any) ? "supported" : "unsupported",
  };
}
export { MIN_TRADE };
