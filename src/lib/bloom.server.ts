// Blind Bloom orchestration. Pure apart from the injected Supabase-like client so it runs against real SQL in tests.
import * as B from "@/domain/bloom";
import { freezeMarket, snapshotPolicy, type FrozenMarket } from "@/domain/greenhouse";
import type { GardenState } from "@/domain/types";

type Db = any;
const ROUND_COLS = "id,seq,slug,title,rules,rules_hash,market,market_hash,seed_commit,seed_reveal,commit_closes_at,status,revealed_at,attempts,output,output_hash,content_hash,error,finished_at,created_at";
const ENTRY_COLS = "id,seq,round_id,agent_id,base_policy_hash,commit,status,salt_reveal,manifest_reveal,base_policy_reveal,created_at";
export class BloomError extends Error {}
const clean = (m: string) => m.replace(/^.*?(bloom[_a-z]*:)/, "$1").replace(/^bloom[_a-z]*:\s*/, "").slice(0, 200);
const rpc = async (db: Db, fn: string, args: Record<string, unknown>) => {
  const r = await db.rpc(fn, args);
  if (r.error) throw new BloomError(clean(String(r.error.message)));
  return r.data;
};
const randomHex = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); };

/** Make sure one open round exists; a new one freezes the current public market. The seed is chosen in SQL. */
export async function ensureRound(db: Db, live: () => Promise<Pick<GardenState, "coins" | "events">>) {
  const open = await db.from("bloom_rounds").select("id,commit_closes_at,status").eq("status", "open");
  if (open.error) throw new BloomError("Rounds could not be read.");
  if ((open.data as any[]).some((r) => Date.parse(r.commit_closes_at) > Date.now())) return;
  const market: FrozenMarket = freezeMarket(await live(), Date.now());
  await rpc(db, "bloom_ensure_round", { _title: `${B.PRESET_RULES.challenge}`, _rules: B.PRESET_RULES, _rules_hash: B.rulesHash(B.PRESET_RULES), _market: market, _market_hash: B.marketHash(market), _commit_secs: B.PRESET_RULES.commitSeconds });
}

export async function listRounds(db: Db) {
  const r = await db.from("bloom_rounds").select("id,seq,slug,title,rules,seed_commit,commit_closes_at,status,revealed_at,error,created_at");
  if (r.error) throw new BloomError("Rounds could not be read.");
  const rows = (r.data as any[]).sort((a, b) => b.seq - a.seq);
  const counts = await db.from("bloom_entries").select("round_id");
  const n: Record<string, number> = {};
  for (const e of (counts.data ?? []) as any[]) n[e.round_id] = (n[e.round_id] ?? 0) + 1;
  return rows.map((x) => ({ ...x, entries: n[x.id] ?? 0 }));
}

/** Public view of one round: only granted public columns are ever selected. */
export async function getRound(db: Db, id: string) {
  const r = await db.from("bloom_rounds").select(ROUND_COLS).eq("id", id).maybeSingle();
  if (r.error) throw new BloomError("Round could not be read.");
  if (!r.data) return null;
  const e = await db.from("bloom_entries").select(ENTRY_COLS).eq("round_id", id);
  if (e.error) throw new BloomError("Entries could not be read.");
  return { round: r.data, entries: (e.data as any[]).sort((a, b) => Number(a.seq) - Number(b.seq)) };
}

/** Seal one strategy for an owner's own agent. The base policy is frozen from the stored agent row, never the client. */
export async function submit(db: Db, owner: string, data: { roundId: string; requestId: string; manifest: unknown }) {
  const r = await db.from("bloom_rounds").select("id,rules,status,commit_closes_at").eq("id", data.roundId).maybeSingle();
  if (r.error || !r.data) throw new BloomError("Unknown round.");
  const rules = B.RulesSchema.parse(r.data.rules);
  let m: B.Manifest;
  try { m = B.parseManifest(data.manifest, rules); } catch (e) { throw new BloomError(`Strategy is not valid: ${(e as Error).message.slice(0, 160)}`); }
  const a = await db.from("agents").select("id,handle,name,archetype,risk,strategy,persona,owner_id,status").eq("id", m.agentId).maybeSingle();
  if (a.error || !a.data || a.data.owner_id !== owner || a.data.status === "archived") throw new BloomError("You can only enter your own active agents.");
  const base = snapshotPolicy({ id: a.data.id, handle: a.data.handle, name: a.data.name, archetype: a.data.archetype, risk: Number(a.data.risk), strategy: a.data.strategy, persona: a.data.persona } as any);
  if (base.policyHash !== m.basePolicyHash) throw new BloomError("Your agent's policy changed since you opened the editor. Reload and seal again.");
  const salt = randomHex();
  const commit = B.submissionCommit({ roundId: data.roundId, agentId: m.agentId, basePolicyHash: base.policyHash, manifest: m, salt });
  return rpc(db, "bloom_submit", { _owner: owner, _round: data.roundId, _request: data.requestId, _agent: m.agentId, _base_policy: base, _base_policy_hash: base.policyHash, _manifest: m, _body_hash: B.bodyHash(data.roundId, m), _salt: salt, _commit: commit }) as Promise<{ id: string; commit: string; created: boolean }>;
}

/** Advance a round past its deadline. Only SQL decides whether the deadline has passed (server time). */
export async function advance(db: Db, roundId: string) {
  const c = await rpc(db, "bloom_claim_eval", { _round: roundId });
  if (c.state !== "acquired") return c.state as string;
  try {
    const entries: B.RevealedEntry[] = (c.entries as any[]).map((e) => ({ entryId: e.id, seq: Number(e.seq), agentId: e.agent_id, commit: e.commit, createdAt: String(e.created_at), salt: e.salt, manifest: e.manifest, basePolicy: e.base_policy }));
    if (B.seedCommit(c.seed) !== c.round.seed_commit) throw new Error("Stored seed does not match its commitment.");
    const out = B.evaluateRound(roundId, c.round.rules, c.round.market, c.seed, entries);
    const oh = B.outputHash(out);
    const ch = B.contentHash({ rulesHash: c.round.rules_hash, marketHash: c.round.market_hash, seedCommit: c.round.seed_commit, commits: entries.map((e) => e.commit), outputHash: oh });
    await rpc(db, "bloom_finalize", { _round: roundId, _lease: c.lease, _output: out, _output_hash: oh, _content_hash: ch });
    return "scored";
  } catch (e) {
    if (e instanceof BloomError && /no longer current/.test(e.message)) return "busy";
    await db.rpc("bloom_fail", { _round: roundId, _lease: c.lease, _reason: (e as Error).message.slice(0, 200) });
    return "failed";
  }
}

/** Evidence bundle built only from public columns (so it can never contain unrevealed secrets). */
export async function bundle(db: Db, roundId: string): Promise<B.Bundle | null> {
  const g = await getRound(db, roundId);
  if (!g) return null;
  const r = g.round;
  return {
    format: B.BUNDLE_FORMAT,
    round: { id: r.id, slug: r.slug, title: r.title, status: r.status, createdAt: r.created_at, commitClosesAt: r.commit_closes_at, rules: r.rules, rulesHash: r.rules_hash, market: r.market, marketHash: r.market_hash, seedCommit: r.seed_commit },
    reveal: { seedHex: r.seed_reveal ?? null, revealedAt: r.revealed_at ?? null },
    entries: g.entries.map((e) => ({ entryId: e.id, seq: Number(e.seq), agentId: e.agent_id, commit: e.commit, createdAt: e.created_at, status: e.status, salt: e.salt_reveal ?? null, manifest: e.manifest_reveal ?? null, basePolicy: e.base_policy_reveal ?? null })),
    output: r.output ?? null, outputHash: r.output_hash ?? null, contentHash: r.content_hash ?? null, error: r.error ?? null, note: B.BUNDLE_NOTE,
  };
}

/** The caller's own entries, including their sealed manifests (owner-only, via service role filtered by owner). */
export async function mine(db: Db, owner: string) {
  const r = await db.from("bloom_entries").select("id,round_id,agent_id,base_policy_hash,commit,status,manifest,created_at").eq("owner_id", owner);
  if (r.error) throw new BloomError("Your entries could not be read.");
  return (r.data as any[]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export const attach = (db: Db, owner: string, proposalId: string, entryId: string) => rpc(db, "bloom_attach_evidence", { _owner: owner, _proposal: proposalId, _entry: entryId });
