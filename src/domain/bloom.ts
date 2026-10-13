// Blind Bloom: sealed-strategy challenge rounds over the frozen Greenhouse engine (vSOL sandbox only).
// Pure and isomorphic. A round freezes rules + one public market + a committed hidden seed. Owners seal a
// bounded v1 strategy manifest (engine settings the rules engine actually uses, plus probability forecasts
// for fixed events). After the commit deadline the server reveals the seed and every sealed preimage, then
// everyone can recompute the same scenarios, paired comparisons and Brier scores from the bundle.
// Trust model: server-mediated. The server generates and stores the seed and the sealed preimages, so a
// dishonest operator could know the seed early; commitments only let anyone check nothing changed after
// they were published. Nothing here is on chain, trustless, or an attestation of model execution.
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { parseStrictJson } from "@/pq/strict-json";
import {
  ENGINE_VERSION, SCENARIO_VERSION, SCENARIOS, MarketSchema, PolicySchema, hashOf, policyHash, runBaseline, runParticipant, seed32, stableJson, stat, boundedJson,
  type FrozenMarket, type PolicySnapshot, type RunResult, type Scenario, type Stat, type TrialConfig,
} from "./greenhouse";

export const BLOOM_VERSION = "blind-bloom-1";
export const SCORING_VERSION = "bloom-scoring-1";
export const MANIFEST_FORMAT = "fleuri.bloom.strategy.v1";
export const BUNDLE_FORMAT = "fleuri.bloom.bundle.v1";
export const BLOOM_LIMITS = { entriesMax: 24, perOwnerPerRound: 3, perOwnerPerDay: 10, repsMax: 3, cyclesMin: 10, cyclesMax: 40, bundleBytes: 3_000_000 } as const;
const H64 = /^[0-9a-f]{64}$/;

// ---------- fixed prediction events ----------
export const EVENTS = ["beats_baseline", "beats_base_policy", "ends_in_profit", "drawdown_over_15"] as const;
export type BloomEvent = (typeof EVENTS)[number];
export const EVENT_INFO: Record<BloomEvent, { label: string; detail: string }> = {
  beats_baseline: { label: "Beats buy & hold", detail: "Sealed strategy's return is higher than the buy-and-hold baseline on the same tape." },
  beats_base_policy: { label: "Beats its own base policy", detail: "Sealed settings return more than the agent's unchanged saved policy on the same tape and agent randomness." },
  ends_in_profit: { label: "Ends in profit", detail: "Net liquidation value at the last cycle is above the 10 vSOL starting capital." },
  drawdown_over_15: { label: "Drawdown over 15%", detail: "Peak-to-trough drop in net liquidation value exceeds 15% at some point." },
};
function resolve(ev: BloomEvent, run: RunResult, base: RunResult, alt: RunResult): 0 | 1 {
  switch (ev) {
    case "beats_baseline": return run.returnPct > base.returnPct ? 1 : 0;
    case "beats_base_policy": return run.returnPct > alt.returnPct ? 1 : 0;
    case "ends_in_profit": return run.returnPct > 0 ? 1 : 0;
    case "drawdown_over_15": return run.maxDrawdownPct > 15 ? 1 : 0;
  }
}

// ---------- round rules (fixed before the round opens) ----------
export const RulesSchema = z.object({
  version: z.literal(BLOOM_VERSION), engineVersion: z.literal(ENGINE_VERSION), scenarioVersion: z.literal(SCENARIO_VERSION), scoringVersion: z.literal(SCORING_VERSION),
  challenge: z.string().min(1).max(60), summary: z.string().max(600),
  scenarios: z.array(z.enum(SCENARIOS)).min(1).max(4).refine((a) => new Set(a).size === a.length, "duplicate scenarios"),
  repetitions: z.number().int().min(1).max(BLOOM_LIMITS.repsMax),
  cycles: z.number().int().min(BLOOM_LIMITS.cyclesMin).max(BLOOM_LIMITS.cyclesMax),
  events: z.array(z.enum(EVENTS)).min(1).max(EVENTS.length).refine((a) => new Set(a).size === a.length, "duplicate events"),
  maxEntries: z.number().int().min(1).max(BLOOM_LIMITS.entriesMax),
  commitSeconds: z.number().int().min(600).max(14 * 86400),
}).strict();
export type BloomRules = z.infer<typeof RulesSchema>;
export const rulesHash = (r: BloomRules) => hashOf("fleuri.bloom.rules.v1", RulesSchema.parse(r));
export const marketHash = (m: FrozenMarket) => hashOf("fleuri.bloom.market.v1", MarketSchema.parse(m));

/** Preset first challenge: can an agent's sealed settings stay resilient through a fragile launch window? */
export const PRESET_RULES: BloomRules = {
  version: BLOOM_VERSION, engineVersion: ENGINE_VERSION, scenarioVersion: SCENARIO_VERSION, scoringVersion: SCORING_VERSION,
  challenge: "Launch resilience",
  summary: "A fragile pre-bonding window: liquidity is pulled, outside sellers dump and orders fail, alongside a calm control. Seal settings that survive it, and say how likely you think each outcome is. Scored on the frozen sandbox market only — the virtual curve is not a model of Meteora DBC or DLMM pools.",
  scenarios: ["control", "liquidity_shock", "sell_pressure", "execution_failures"], repetitions: 3, cycles: 30,
  events: [...EVENTS], maxEntries: 16, commitSeconds: 72 * 3600,
};

// ---------- strategy manifest (sealed) ----------
const pct = z.number().int().min(0).max(100);
export const ManifestSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  agentId: z.string().min(1).max(40),
  basePolicyHash: z.string().regex(H64),
  settings: z.object({ archetype: z.enum(["pollinator", "gardener", "weed", "botanist", "compost"]), risk: z.number().int().min(1).max(5) }).strict(),
  predictions: z.record(z.enum(EVENTS), pct),
}).strict();
export type Manifest = z.infer<typeof ManifestSchema>;
/** Validates a manifest against a round's fixed event set: exactly one integer-percent forecast per event. */
export function parseManifest(raw: unknown, rules: BloomRules): Manifest {
  const m = ManifestSchema.parse(raw);
  const keys = Object.keys(m.predictions).sort();
  if (stableJson(keys) !== stableJson([...rules.events].sort())) throw new Error("Give exactly one forecast for each of this round's events.");
  return m;
}
/** The executable policy that runs: the frozen base policy with the sealed engine settings applied. */
export function sealedPolicy(base: PolicySnapshot, m: Manifest): PolicySnapshot {
  const p = { ...PolicySchema.parse(base), archetype: m.settings.archetype, risk: m.settings.risk };
  return { ...p, policyHash: policyHash(p) };
}

// ---------- commitments ----------
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** Must match SQL: encode(sha256(convert_to('fleuri.bloom.seed.v1' || chr(10) || seed,'UTF8')),'hex'). */
export const seedCommit = (seedHex: string) => hex(sha256(new TextEncoder().encode(`fleuri.bloom.seed.v1\n${seedHex}`)));
export const submissionCommit = (p: { roundId: string; agentId: string; basePolicyHash: string; manifest: Manifest; salt: string }) =>
  hashOf("fleuri.bloom.commit.v1", { roundId: p.roundId, agentId: p.agentId, basePolicyHash: p.basePolicyHash, manifest: p.manifest, salt: p.salt });
/** Retry identity: the same request id must carry this same body. Salt is excluded (server-generated). */
export const bodyHash = (roundId: string, manifest: Manifest) => hashOf("fleuri.bloom.body.v1", { roundId, manifest });
export const tapeSeed = (seedHex: string, roundId: string) => seed32("fleuri.bloom.tape.v1", seedHex, roundId);

// ---------- evaluation ----------
export interface RevealedEntry { entryId: string; seq: number; agentId: string; commit: string; createdAt: string; salt: string; manifest: Manifest; basePolicy: PolicySnapshot }
export interface EventScore { event: BloomEvent; forecast: number; hits: number; n: number; brier: number }
export interface ScenarioResult { scenario: Scenario; n: number; sealedReturn: Stat; baseReturn: Stat; baselineReturn: Stat; vsBaseline: Stat; vsBasePolicy: Stat; winsVsBaseline: number; winsVsBasePolicy: number; maxDrawdown: Stat; attempts: number; rejections: number; faults: number }
export interface EntryResult { entryId: string; agentId: string; status: "scored" | "invalid"; reason: string | null; sealedPolicyHash: string | null; basePolicyHash: string; scenarios: ScenarioResult[]; events: EventScore[]; brier: number | null; referenceBrier: number | null; overallVsBaseline: Stat | null; n: number }
export interface RoundOutput { version: typeof SCORING_VERSION; tapeSeed: number; baselines: { scenario: Scenario; rep: number; returnPct: number }[]; entries: EntryResult[]; ranking: string[] }
const r9 = (n: number) => Math.round(n * 1e9) / 1e9;

/** Deterministic and bounded by the round rules. Invalid entries are kept and reported, never dropped. */
export function evaluateRound(roundId: string, rulesRaw: BloomRules, marketRaw: FrozenMarket, seedHex: string, entries: RevealedEntry[]): RoundOutput {
  const rules = RulesSchema.parse(rulesRaw); const market = MarketSchema.parse(marketRaw);
  if (!H64.test(seedHex)) throw new Error("Seed must be 64 hex characters.");
  if (entries.length > rules.maxEntries) throw new Error("Too many entries for this round.");
  const seed = tapeSeed(seedHex, roundId);
  const cfg = { agentIds: ["x"], seed, repetitions: rules.repetitions, cycles: rules.cycles, scenarios: rules.scenarios } as TrialConfig;
  const base = new Map<string, RunResult>();
  for (const sc of rules.scenarios) for (let rep = 0; rep < rules.repetitions; rep++) base.set(`${sc}:${rep}`, runBaseline(market, cfg, sc, rep));
  const results: EntryResult[] = [...entries].sort((a, b) => a.seq - b.seq).map((e) => {
    const empty = { entryId: e.entryId, agentId: e.agentId, sealedPolicyHash: null, basePolicyHash: String((e.basePolicy as any)?.policyHash ?? ""), scenarios: [], events: [], brier: null, referenceBrier: null, overallVsBaseline: null, n: 0 };
    let m: Manifest, bp: PolicySnapshot;
    try {
      m = parseManifest(e.manifest, rules); bp = PolicySchema.parse(e.basePolicy);
      if (bp.policyHash !== policyHash(bp) || m.basePolicyHash !== bp.policyHash || m.agentId !== e.agentId || bp.agentId !== e.agentId) throw new Error("Sealed manifest does not match its frozen base policy.");
      if (submissionCommit({ roundId, agentId: e.agentId, basePolicyHash: bp.policyHash, manifest: m, salt: e.salt }) !== e.commit) throw new Error("Revealed preimage does not match the published commitment.");
    } catch (err) { return { ...empty, status: "invalid" as const, reason: (err as Error).message.slice(0, 200) }; }
    const sealed = sealedPolicy(bp, m);
    const scen: ScenarioResult[] = []; const counts = new Map<BloomEvent, { hits: number; n: number; sq: number; refSq: number }>();
    const allDiffs: number[] = [];
    for (const sc of rules.scenarios) {
      const rs: RunResult[] = [], alts: RunResult[] = [], bs: RunResult[] = [];
      for (let rep = 0; rep < rules.repetitions; rep++) {
        const run = runParticipant(market, sealed, cfg, sc, rep), alt = runParticipant(market, bp, cfg, sc, rep), b = base.get(`${sc}:${rep}`)!;
        rs.push(run); alts.push(alt); bs.push(b);
        for (const ev of rules.events) {
          const o = resolve(ev, run, b, alt), p = m.predictions[ev]! / 100;
          const c = counts.get(ev) ?? { hits: 0, n: 0, sq: 0, refSq: 0 };
          c.hits += o; c.n++; c.sq += (p - o) ** 2; c.refSq += (0.5 - o) ** 2; counts.set(ev, c);
        }
      }
      const dB = rs.map((r, i) => r.returnPct - bs[i].returnPct), dA = rs.map((r, i) => r.returnPct - alts[i].returnPct);
      allDiffs.push(...dB);
      const sum = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0);
      scen.push({ scenario: sc, n: rs.length, sealedReturn: stat(rs.map((r) => r.returnPct)), baseReturn: stat(alts.map((r) => r.returnPct)), baselineReturn: stat(bs.map((r) => r.returnPct)),
        vsBaseline: stat(dB), vsBasePolicy: stat(dA), winsVsBaseline: dB.filter((x) => x > 0).length, winsVsBasePolicy: dA.filter((x) => x > 0).length,
        maxDrawdown: stat(rs.map((r) => r.maxDrawdownPct)), attempts: sum((r) => r.attempts), rejections: sum((r) => r.rejections), faults: sum((r) => r.faults) });
    }
    const events: EventScore[] = rules.events.map((ev) => { const c = counts.get(ev)!; return { event: ev, forecast: m.predictions[ev]!, hits: c.hits, n: c.n, brier: r9(c.sq / c.n) }; });
    const tot = [...counts.values()].reduce((a, c) => ({ n: a.n + c.n, sq: a.sq + c.sq, ref: a.ref + c.refSq }), { n: 0, sq: 0, ref: 0 });
    return { ...empty, status: "scored" as const, reason: null, sealedPolicyHash: sealed.policyHash, scenarios: scen, events, brier: r9(tot.sq / tot.n), referenceBrier: r9(tot.ref / tot.n), overallVsBaseline: stat(allDiffs), n: allDiffs.length };
  });
  // Fixed rule: rank scored entries by mean paired return vs buy & hold, then lower Brier, then earlier entry.
  const ranking = results.filter((r) => r.status === "scored").sort((a, b) => b.overallVsBaseline!.mean - a.overallVsBaseline!.mean || a.brier! - b.brier!).map((r) => r.entryId);
  const baselines = [...base.entries()].map(([k, r]) => ({ scenario: k.split(":")[0] as Scenario, rep: Number(k.split(":")[1]), returnPct: r.returnPct }));
  return { version: SCORING_VERSION, tapeSeed: seed, baselines, entries: results, ranking };
}
export const outputHash = (o: RoundOutput) => hashOf("fleuri.bloom.output.v1", o);
export const contentHash = (p: { rulesHash: string; marketHash: string; seedCommit: string; commits: string[]; outputHash: string | null }) => hashOf("fleuri.bloom.content.v1", p);

// ---------- portable evidence bundle + strict local verifier ----------
export interface BundleEntry { entryId: string; seq: number; agentId: string; commit: string; createdAt: string; status: string; salt: string | null; manifest: unknown; basePolicy: unknown }
export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  round: { id: string; slug: string; title: string; status: string; createdAt: string; commitClosesAt: string; rules: BloomRules; rulesHash: string; market: FrozenMarket; marketHash: string; seedCommit: string };
  reveal: { seedHex: string | null; revealedAt: string | null };
  entries: BundleEntry[]; output: RoundOutput | null; outputHash: string | null; contentHash: string | null; error: string | null; note: string;
}
export const BUNDLE_NOTE = "Blind Bloom vSOL sandbox round, exported as stored by a server-mediated prototype. The server generated the seed and held sealed strategies, so it could have known them early; commitments only prove nothing changed after they were published. Database timestamps are not on-chain timestamps. Not trustless, not a model-execution attestation, not a prediction of real markets or Meteora DBC/DLMM behaviour.";

export type BloomCheck = { id: string; ok: boolean; detail: string };
/** verified: everything recomputed. pending: seed not yet revealed (commitments only). partial: revealed but no scores (failed round). */
export type BloomVerify = { status: "verified" | "pending" | "partial" | "mismatch" | "unsupported" | "invalid"; detail: string; checks: BloomCheck[]; bundle?: Bundle };

const iso = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), "not a timestamp");
const h64 = z.string().regex(H64);
const EnvelopeSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  round: z.object({ id: z.string().uuid(), slug: z.string().max(40), title: z.string().max(80), status: z.enum(["open", "evaluating", "scored", "failed"]), createdAt: iso, commitClosesAt: iso, rules: z.unknown(), rulesHash: h64, market: z.unknown(), marketHash: h64, seedCommit: h64 }).strict(),
  reveal: z.object({ seedHex: h64.nullable(), revealedAt: iso.nullable() }).strict(),
  entries: z.array(z.object({ entryId: z.string().uuid(), seq: z.number().int().positive(), agentId: z.string().min(1).max(40), commit: h64, createdAt: iso, status: z.enum(["sealed", "revealed"]), salt: h64.nullable(), manifest: z.unknown(), basePolicy: z.unknown() }).strict()).max(BLOOM_LIMITS.entriesMax),
  output: z.unknown(), outputHash: h64.nullable(), contentHash: h64.nullable(), error: z.string().max(300).nullable(), note: z.string().max(1000),
}).strict();

/**
 * Strict: size cap, duplicate-key and non-finite rejection, exact envelope schema, known versions only;
 * recomputes everything that is revealed. Signatures/hashes here never prove when something happened.
 */
export function verifyBloomBundle(text: string): BloomVerify {
  const checks: BloomCheck[] = [];
  let raw: any;
  try { raw = parseStrictJson(text, { maxBytes: BLOOM_LIMITS.bundleBytes, maxDepth: 40 }); }
  catch (e) { return { status: "invalid", detail: (e as Error).message, checks }; }
  const bad = boundedJson(raw, 40, 2_000_000); if (bad) return { status: "invalid", detail: bad, checks };
  if (!raw || typeof raw !== "object" || raw.format !== BUNDLE_FORMAT) return { status: "unsupported", detail: `Unsupported bundle format ${String(raw?.format)}.`, checks };
  const r0 = raw.round?.rules;
  if (r0?.version !== BLOOM_VERSION || r0?.engineVersion !== ENGINE_VERSION || r0?.scenarioVersion !== SCENARIO_VERSION || r0?.scoringVersion !== SCORING_VERSION)
    return { status: "unsupported", detail: `Unsupported round versions ${String(r0?.version)}/${String(r0?.engineVersion)}/${String(r0?.scoringVersion)}.`, checks };
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) return { status: "invalid", detail: `Bundle envelope invalid at ${env.error.issues[0]?.path.join(".")}: ${env.error.issues[0]?.message}`, checks };
  const r = raw.round;
  let rules: BloomRules, market: FrozenMarket;
  try { rules = RulesSchema.parse(r.rules); market = MarketSchema.parse(r.market); } catch (e) { return { status: "invalid", detail: `Round rules or market invalid: ${(e as Error).message.slice(0, 160)}`, checks }; }
  if (raw.entries.length > rules.maxEntries) return { status: "invalid", detail: "Entries above the round limit.", checks };
  const ids = new Set<string>(); let lastSeq = 0;
  for (const e of raw.entries) {
    if (ids.has(e.entryId)) return { status: "invalid", detail: "Duplicate entry id.", checks };
    if (e.seq <= lastSeq) return { status: "invalid", detail: "Entries must be listed in strictly increasing, unique submission order.", checks };
    ids.add(e.entryId); lastSeq = e.seq;
  }
  const seed: string | null = raw.reveal.seedHex, revealed = seed !== null;
  // Phase consistency: revealed fields appear together, only after the deadline, and never for open rounds.
  const closes = Date.parse(r.commitClosesAt);
  const phaseErr =
    (raw.reveal.revealedAt === null) !== !revealed ? "Seed and reveal time must appear together." :
    revealed && Date.parse(raw.reveal.revealedAt) < closes ? "Reveal time is before the commit deadline." :
    revealed && r.status === "open" ? "An open round cannot have a revealed seed." :
    !revealed && r.status !== "open" ? "A closed round must include its revealed seed." :
    raw.entries.some((e: any) => Date.parse(e.createdAt) >= closes) ? "An entry was created at or after the commit deadline." :
    raw.entries.some((e: any) => revealed ? e.status !== "revealed" || e.salt === null || e.manifest == null || e.basePolicy == null : e.status !== "sealed" || e.salt !== null || e.manifest != null || e.basePolicy != null) ? "Entry reveal fields do not match the round phase." :
    r.status === "scored" ? (raw.output == null || !raw.outputHash || !raw.contentHash ? "A scored round must include its output and hashes." : null) :
    raw.output != null || raw.outputHash !== null || raw.contentHash !== null ? "Only scored rounds carry outputs." :
    r.status === "failed" && !raw.error ? "A failed round must say why." : null;
  if (phaseErr) return { status: "invalid", detail: phaseErr, checks };
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  add("rules", rulesHash(rules) === r.rulesHash, "Rules hash recomputed.");
  add("market", marketHash(market) === r.marketHash, "Frozen market hash recomputed.");
  if (revealed) {
    add("seed", seedCommit(seed) === r.seedCommit, "Revealed seed matches the commitment published at round creation.");
    raw.entries.forEach((e: any, i: number) => {
      let ok = false;
      try { const m = parseManifest(e.manifest, rules); ok = m.agentId === e.agentId && submissionCommit({ roundId: r.id, agentId: e.agentId, basePolicyHash: m.basePolicyHash, manifest: m, salt: e.salt }) === e.commit; } catch { ok = false; }
      add(`commit${i + 1}`, ok, `Entry ${e.seq}: revealed strategy and salt reproduce its published commitment.`);
    });
  }
  const allOk = () => checks.every((c) => c.ok);
  if (!revealed) return { status: allOk() ? "pending" : "mismatch", detail: allOk() ? "Seed not revealed yet: rules and market hashes checked; strategies stay sealed, nothing can be scored." : "A rules or market hash did not match.", checks, bundle: raw };
  if (r.status !== "scored") return { status: allOk() ? "partial" : "mismatch", detail: allOk() ? `Revealed seed and every commitment checked; no scores (${r.status === "failed" ? String(raw.error).slice(0, 160) : "evaluation still running"}).` : "A revealed seed or commitment did not match.", checks, bundle: raw };
  if (!allOk()) return { status: "mismatch", detail: "A commitment or hash did not match.", checks, bundle: raw };
  let out: RoundOutput;
  try {
    const rev: RevealedEntry[] = raw.entries.map((e: any) => ({ entryId: e.entryId, seq: e.seq, agentId: e.agentId, commit: e.commit, createdAt: e.createdAt, salt: e.salt, manifest: e.manifest, basePolicy: e.basePolicy }));
    out = evaluateRound(r.id, rules, market, seed, rev);
  } catch (e) { return { status: "invalid", detail: `Recompute failed: ${(e as Error).message.slice(0, 160)}`, checks }; }
  add("output", stableJson(out) === stableJson(raw.output), "Scenarios, paired comparisons and Brier scores recomputed locally.");
  const oh = outputHash(out);
  add("outputHash", oh === raw.outputHash, "Output hash recomputed.");
  add("contentHash", contentHash({ rulesHash: r.rulesHash, marketHash: r.marketHash, seedCommit: r.seedCommit, commits: raw.entries.map((e: any) => e.commit), outputHash: oh }) === raw.contentHash, "Content hash binds rules, market, seed commitment, every commitment and the output.");
  const ok = allOk();
  return { status: ok ? "verified" : "mismatch", detail: ok ? "Every commitment, scenario, comparison and score recomputed and matched. Hashes prove consistency, not when anything happened." : "Recomputed results differ from the bundle.", checks, bundle: raw };
}
