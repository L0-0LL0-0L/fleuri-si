// Synthetic range-triggered inventory research. No liquidity pool, fills, fees earned or model execution.
import { z } from 'zod';
import { canonicalize, domainHash } from '@/pq/canonical';
import { parseStrictJson } from '@/pq/strict-json';
export const ENGINE = 'shadow-range-inventory/1';
export const FORMAT = 'fleuri.shadow.bundle/1';
export const LIMITS = { rounds: 96, daily: 6, leaseSeconds: 60, maxBytes: 500_000 } as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const atomic = z.string().regex(/^(0|[1-9]\d{0,12})$/).refine(v => BigInt(v) <= 1_000_000_000_000n);
const date = z.string().datetime();
export const termsSchema = z.object({
  agentId: z.string().regex(/^[\w-]{1,40}$/), name: z.string().trim().min(1).max(80),
  strategy: z.enum(['hold', 'range-rebalance']), scenario: z.enum(['mixed', 'rising', 'falling', 'flat', 'breach']),
  rounds: z.number().int().min(8).max(96), stepMinutes: z.literal(60),
  initialQuote: atomic, initialTokens: atomic,
  lowerBps: z.number().int().min(1000).max(9999), upperBps: z.number().int().min(10001).max(30000),
  feeBps: z.number().int().min(0).max(100), slippageBps: z.number().int().min(0).max(200),
  targetBps: z.literal(5000), rationale: z.string().trim().min(1).max(280),
  expectedExcessQuote: z.string().regex(/^-?(0|[1-9]\d{0,12})$/), expectedInRangeBps: z.number().int().min(0).max(10000),
  evidenceRef: z.string().max(120),
}).strict().refine(t => BigInt(t.initialQuote) + BigInt(t.initialTokens) > 0n, 'Inventory must be positive');
export type Terms = z.infer<typeof termsSchema>;
export const DEFAULT_TERMS: Terms = { agentId: '', name: 'First shadow', strategy: 'range-rebalance', scenario: 'mixed', rounds: 24, stepMinutes: 60, initialQuote: '100000000', initialTokens: '100000000', lowerBps: 8500, upperBps: 11500, feeBps: 30, slippageBps: 20, targetBps: 5000, rationale: 'Rebalance to equal value when price leaves the fixed range.', expectedExcessQuote: '0', expectedInRangeBps: 7000, evidenceRef: '' };
export const versionSchema = z.object({ agentId: z.string(), modelId: z.string().max(100), promptVersion: z.literal('garden-cycle-prompt/1'), engine: z.literal(ENGINE), policyHash: hash, db: z.object({ handle: z.string().max(20), archetype: z.string().max(20), risk: z.number().int().min(1).max(5), personaDigest: hash, strategyDigest: hash }).strict() }).strict();
export type Version = z.infer<typeof versionSchema>;
export function versionOf(a: { id: string; handle: string; archetype: string; risk: number; persona: string; strategy: string }, modelId: string): Version {
  const db = { handle: a.handle, archetype: a.archetype, risk: a.risk, personaDigest: domainHash('shadow.persona/1', a.persona), strategyDigest: domainHash('shadow.strategy/1', a.strategy) };
  return versionSchema.parse({ agentId: a.id, modelId, promptVersion: 'garden-cycle-prompt/1', engine: ENGINE, db, policyHash: domainHash('shadow.policy/1', db) });
}
export const frozenSchema = z.object({ engine: z.literal(ENGINE), mode: z.literal('sealed-synthetic'), terms: termsSchema, version: versionSchema, seedCommit: hash, initialPrice: z.literal('1000000'), assumptions: z.literal('fixed-range-trigger;50%-target;quote-costs;zero-earned-fees;no-LP;hourly-synthetic;floor-atomic') }).strict().refine(v => v.terms.agentId === v.version.agentId);
export type Frozen = z.infer<typeof frozenSchema>;
export const inputHash = (f: Frozen) => domainHash('shadow.input/1', f);
export const seedHash = (s: string) => domainHash('shadow.seed/1', s);
export const commitHash = (f: Frozen, at: string) => domainHash('shadow.commit/1', { inputHash: inputHash(f), committedAt: at });
export function freeze(terms: Terms, version: Version, seedCommit: string): Frozen { return frozenSchema.parse({ engine: ENGINE, mode: 'sealed-synthetic', terms, version, seedCommit, initialPrice: '1000000', assumptions: 'fixed-range-trigger;50%-target;quote-costs;zero-earned-fees;no-LP;hourly-synthetic;floor-atomic' }); }
// Six decimal token and quote units. Price = quote atomic units per whole token.
const SCALE = 1_000_000n;
const BPS = 10_000n;
const value = (tokens: bigint, p: bigint) => tokens * p / SCALE;
export function makeTape(f: Frozen, seed: string): (string | null)[] {
  if (!/^[a-f0-9]{64}$/.test(seed) || seedHash(seed) !== f.seedCommit) throw new Error('Seed commitment mismatch');
  const t = f.terms; let p = SCALE;
  const tape: string[] = [p.toString()];
  for (let i = 1; i <= t.rounds; i++) {
    const n = parseInt(domainHash('shadow.shock/1', { seed, i }).slice(0, 8), 16);
    const step = t.scenario === 'flat' ? 0 : t.scenario === 'rising' ? 100 + n % 200 : t.scenario === 'falling' ? -100 - n % 200 : t.scenario === 'breach' ? (i % 4 < 2 ? 1600 : -1400) : n % 1401 - 700;
    p = p * BigInt(10000 + step) / BPS;
    if (p < 100n) p = 100n;
    tape.push(p.toString());
  }
  return tape;
}
export interface Step { round: number; price: string; action: 'hold' | 'buy' | 'sell'; tokens: string; grossQuote: string; cost: string; quoteBalance: string; tokenBalance: string; equity: string; hold: string; benchmark: string; inRange: boolean }
export interface Result { status: 'complete' | 'incomplete'; reason: string | null; steps: Step[]; finalValue: string | null; holdValue: string | null; benchmarkValue: string | null; excess: string | null; costs: string; tradingContribution: string | null; roundingResidual: string | null; maxDrawdownBps: number | null; inRangeBps: number | null; earnedFees: '0'; autopsy: { tags: string[]; expectedExcess: string; expectedInRangeBps: number; excessMet: boolean | null; rangeMet: boolean | null; limits: string } }
const CAUSAL = 'Accounting attribution, not a causal market explanation. Synthetic hourly marks; no LP, liquidity, volume, real fills, MEV or AI execution. No fees earned. Evidence references are owner notes, not verified provenance.';
export function evaluateTape(f: Frozen, tape: (string | null)[]): Result {
  frozenSchema.parse(f);
  if (tape.length !== f.terms.rounds + 1 || tape.some(p => p === null)) return { status: 'incomplete', reason: 'Missing synthetic marks; no completed score.', steps: [], finalValue: null, holdValue: null, benchmarkValue: null, excess: null, costs: '0', tradingContribution: null, roundingResidual: null, maxDrawdownBps: null, inRangeBps: null, earnedFees: '0', autopsy: { tags: [], expectedExcess: f.terms.expectedExcessQuote, expectedInRangeBps: f.terms.expectedInRangeBps, excessMet: null, rangeMet: null, limits: CAUSAL } };
  if (tape[0] !== f.initialPrice || tape.some(p => typeof p !== 'string' || !/^[1-9]\d{0,17}$/.test(p))) throw new Error('Invalid price marks');
  const prices = tape.map(p => BigInt(p ?? '0')); const t = f.terms;
  let q = BigInt(t.initialQuote), tokens = BigInt(t.initialTokens), costs = 0n;
  const initialValue = q + value(tokens, prices[0]); const benchmarkTokens = initialValue * SCALE / prices[0];
  let peak = initialValue, dd = 0, inside = 0; const steps: Step[] = [];
  const trades: { delta: bigint; gross: bigint }[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i]; const inRange = p * BPS >= prices[0] * BigInt(t.lowerBps) && p * BPS <= prices[0] * BigInt(t.upperBps);
    let action: Step['action'] = 'hold', amount = 0n, gross = 0n, cost = 0n;
    if (i > 0 && !inRange && t.strategy === 'range-rebalance') {
      const equity = q + value(tokens, p); const target = equity / 2n; const tv = value(tokens, p);
      if (tv > target) {
        amount = (tv - target) * SCALE / p; if (amount > tokens) amount = tokens;
        gross = value(amount, p); cost = gross * BigInt(t.feeBps + t.slippageBps) / BPS;
        if (amount > 0n && gross > cost) { action = 'sell'; tokens -= amount; q += gross - cost; trades.push({ delta: -amount, gross: -gross }); }
      } else {
        const spend = target - tv; const cap = q * BPS / (BPS + BigInt(t.feeBps + t.slippageBps));
        const allowed = spend < cap ? spend : cap; amount = allowed * SCALE / p; gross = value(amount, p); cost = gross * BigInt(t.feeBps + t.slippageBps) / BPS;
        if (amount > 0n && gross + cost <= q) { action = 'buy'; tokens += amount; q -= gross + cost; trades.push({ delta: amount, gross }); }
      }
    }
    if (action === 'hold') { amount = 0n; gross = 0n; cost = 0n; }
    costs += cost; const equity = q + value(tokens, p);
    if (equity > peak) peak = equity; if (peak > 0n) dd = Math.max(dd, Number((peak - equity) * BPS / peak));
    if (i > 0 && inRange) inside++;
    steps.push({ round: i, price: p.toString(), action, tokens: amount.toString(), grossQuote: gross.toString(), cost: cost.toString(), quoteBalance: q.toString(), tokenBalance: tokens.toString(), equity: equity.toString(), hold: (BigInt(t.initialQuote) + value(BigInt(t.initialTokens), p)).toString(), benchmark: value(benchmarkTokens, p).toString(), inRange });
  }
  const last = steps[steps.length - 1]; if (!last) throw new Error('No marks');
  const final = BigInt(last.equity), hold = BigInt(last.hold), excess = final - hold;
  const contribution = trades.reduce((s, x) => s + x.delta * prices[prices.length - 1] / SCALE - x.gross, 0n);
  const inRangeBps = Math.floor(inside * 10000 / t.rounds); const tags: string[] = [];
  if (inside < t.rounds) tags.push('range-breach');
  if (costs > 0n && excess < 0n) tags.push('cost-drag');
  if (contribution < 0n) tags.push('inventory-timing-loss');
  if (excess < BigInt(t.expectedExcessQuote)) tags.push('excess-expectation-missed');
  if (inRangeBps < t.expectedInRangeBps) tags.push('range-expectation-missed');
  return { status: 'complete', reason: null, steps, finalValue: final.toString(), holdValue: hold.toString(), benchmarkValue: last.benchmark, excess: excess.toString(), costs: costs.toString(), tradingContribution: contribution.toString(), roundingResidual: (excess + costs - contribution).toString(), maxDrawdownBps: dd, inRangeBps, earnedFees: '0', autopsy: { tags, expectedExcess: t.expectedExcessQuote, expectedInRangeBps: t.expectedInRangeBps, excessMet: excess >= BigInt(t.expectedExcessQuote), rangeMet: inRangeBps >= t.expectedInRangeBps, limits: CAUSAL } };
}
export type Event = { seq: number; kind: 'created' | 'edited' | 'committed' | 'evaluating' | 'completed' | 'shared' | 'annotation'; at: string; body: Record<string, unknown>; previous: string; hash: string };
export const eventHash = (e: Omit<Event, 'hash'>) => domainHash('shadow.event/1', e);
const eventSchema = z.object({ seq: z.number().int().min(1).max(200), kind: z.enum(['created', 'edited', 'committed', 'evaluating', 'completed', 'shared', 'annotation']), at: date, body: z.record(z.string(), z.unknown()), previous: hash, hash }).strict();
const bundleSchema = z.object({ format: z.literal(FORMAT), id: z.string().uuid(), frozen: frozenSchema, committedAt: date, commitment: hash, seed: hash, tape: z.array(z.string().regex(/^[1-9]\d{0,17}$/)).min(9).max(97), result: z.unknown(), resultHash: hash, events: z.array(eventSchema).min(3).max(200), exportedAt: date, root: hash }).strict();
export interface Bundle { format: typeof FORMAT; id: string; frozen: Frozen; committedAt: string; commitment: string; seed: string; tape: string[]; result: Result; resultHash: string; events: Event[]; exportedAt: string; root: string }
export const resultHash = (r: Result) => domainHash('shadow.result/1', r);
export function bundleRoot(b: Omit<Bundle, 'root'>) { return domainHash('shadow.bundle/1', b); }
export function verifyBundle(text: string): { ok: boolean; message: string } {
  try {
    const b = bundleSchema.parse(parseStrictJson(text, { maxBytes: LIMITS.maxBytes, maxDepth: 20 })) as Bundle;
    if (commitHash(b.frozen, b.committedAt) !== b.commitment) throw new Error('Commitment mismatch');
    if (canonicalize(makeTape(b.frozen, b.seed)) !== canonicalize(b.tape)) throw new Error('Tape mismatch');
    const replay = evaluateTape(b.frozen, b.tape);
    if (canonicalize(replay) !== canonicalize(b.result) || resultHash(replay) !== b.resultHash) throw new Error('Result/autopsy mismatch');
    let previous = '0'.repeat(64), at = 0; let commits = 0, completes = 0;
    for (const [i, e] of b.events.entries()) {
      const { hash: h, ...rest } = e;
      if (e.seq !== i + 1 || e.previous !== previous || eventHash(rest) !== h || Date.parse(e.at) < at || Date.parse(e.at) > Date.parse(b.exportedAt)) throw new Error('History mismatch');
      const bodies: Record<Event['kind'], z.ZodType> = { created: z.object({ inputHash: hash }).strict(), edited: z.object({ inputHash: hash }).strict(), committed: z.object({ inputHash: hash, commitment: hash }).strict(), evaluating: z.object({ generation: z.number().int().positive() }).strict(), completed: z.object({ resultHash: hash }).strict(), shared: z.object({ shared: z.boolean() }).strict(), annotation: z.object({ text: z.string().min(1).max(500), requestId: z.string().uuid() }).strict() };
      bodies[e.kind].parse(e.body);
      if (i === 0 && e.kind !== 'created') throw new Error('Missing initial event');
      if (e.kind === 'committed') { if (++commits !== 1 || e.at !== b.committedAt || e.body.commitment !== b.commitment || e.body.inputHash !== inputHash(b.frozen)) throw new Error('Commit event mismatch'); }
      if (e.kind === 'edited' && commits) throw new Error('Post-commit edit');
      if (e.kind === 'completed') { if (!commits || ++completes !== 1 || e.body.resultHash !== b.resultHash) throw new Error('Completion mismatch'); }
      if (e.kind === 'evaluating' && (!commits || completes)) throw new Error('Evaluation order');
      previous = h; at = Date.parse(e.at);
    }
    if (commits !== 1 || completes !== 1) throw new Error('Missing completed history');
    const { root, ...rest } = b; if (bundleRoot(rest) !== root) throw new Error('Content root mismatch');
    return { ok: true, message: 'Commitment, tape, accounting, autopsy and history replay match. Internal consistency only; not historical authenticity or chain execution.' };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message.slice(0, 180) : 'Invalid evidence' }; }
}
