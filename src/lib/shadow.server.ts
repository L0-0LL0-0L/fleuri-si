import { ENGINE, FORMAT, freeze, versionOf, termsSchema, frozenSchema, makeTape, evaluateTape, inputHash, commitHash, resultHash, bundleRoot, verifyBundle, type Terms, type Bundle } from '@/domain/shadow';
import { domainHash } from '@/pq/canonical';
const COLS = 'id,owner_id,agent_id,status,frozen,input_hash,seed_commit,committed_at,commitment,result,result_hash,tape,shared,generation,created_at';
const must = (r: any) => { if (r.error) throw new Error(r.error.message); return r.data; };
const rpc = async (db: any, owner: string, request: string, action: string, id: string | null, payload: unknown) => must(await db.rpc('shadow_write', { _owner: owner, _request: request, _action: action, _id: id, _payload: payload }));
export async function agentVersion(db: any, owner: string, id: string) {
  const a = must(await db.from('agents').select('id,handle,archetype,risk,persona,strategy,owner_id,status').eq('id', id).maybeSingle());
  if (!a || a.owner_id !== owner || a.status === 'archived') throw new Error('not_owner');
  const { AI_MODEL } = await import('./ai.server'); return versionOf(a, AI_MODEL);
}
export async function mine(db: any, owner: string) { return must(await db.from('shadow_seasons').select(COLS).eq('owner_id', owner).order('created_at', { ascending: false }).limit(100)); }
export async function detail(db: any, id: string, owner: string | null) {
  const s = must(await db.from('shadow_seasons').select(COLS).eq('id', id).maybeSingle());
  if (!s || (s.owner_id !== owner && !s.shared)) return null;
  const events = must(await db.from('shadow_events').select('event').eq('season_id', id).order('seq', { ascending: true }).limit(200)).map((r: any) => r.event);
  let versionMatches: boolean | null = null;
  if (owner === s.owner_id) try { versionMatches = domainHash('shadow.version/1', await agentVersion(db, owner, s.agent_id)) === domainHash('shadow.version/1', s.frozen.version); } catch { versionMatches = false; }
  // No owner identifier, private agent text, lease token or preimage in any DTO.
  const { owner_id, ...season } = s;
  let seed: string | null = null;
  if (s.status === 'completed') seed = must(await db.from('shadow_seasons').select('seed_hex').eq('id', id).maybeSingle()).seed_hex;
  return { season, events, seed, isOwner: owner === owner_id, versionMatches };
}
export async function save(db: any, owner: string, request: string, terms: Terms, id: string | null, reviewedHash: string | null) {
  const normalized = termsSchema.parse(terms);
  // Retry BEFORE current-agent read, using durable normalized body hash, independent of clock/code edits.
  const bodyHash = domainHash('shadow.save/1', { terms: normalized, id, reviewedHash });
  const prior = must(await db.from('shadow_requests').select('response').eq('owner_id', owner).eq('request_id', request).maybeSingle());
  if (prior) { if (prior.response.saveBodyHash !== bodyHash) throw new Error('request_mismatch'); return prior.response; }
  const version = await agentVersion(db, owner, normalized.agentId);
  const frozen = freeze(normalized, version, '0'.repeat(64));
  // SQL request identity includes the original normalized body hash; stored version is part of same-body concurrent creation.
  const result = await rpc(db, owner, request, id ? 'edit' : 'create', id, { frozen, versionHash: domainHash('shadow.version/1', version), reviewedHash, saveBodyHash: bodyHash });
  return result;
}
export async function commit(db: any, owner: string, id: string, request: string, reviewedHash: string) {
  const d = await detail(db, id, owner); if (!d?.isOwner) throw new Error('not_owner');
  const version = await agentVersion(db, owner, d.season.agent_id);
  return rpc(db, owner, request, 'commit', id, { reviewedHash, versionHash: domainHash('shadow.version/1', version) });
}
export async function run(db: any, owner: string, id: string) {
  const claim = await rpc(db, owner, crypto.randomUUID(), 'claim', id, {});
  if (claim.status !== 'claimed') return { id, status: claim.status };
  const frozen = frozenSchema.parse(claim.frozen);
  if (frozen.engine !== ENGINE) throw new Error('unsupported_engine');
  const tape = makeTape(frozen, claim.seed); const result = evaluateTape(frozen, tape);
  return rpc(db, owner, crypto.randomUUID(), 'finish', id, { token: claim.token, generation: claim.generation, inputHash: inputHash(frozen), result, resultHash: resultHash(result), tape });
}
export async function share(db: any, owner: string, id: string, request: string, shared: boolean) { return rpc(db, owner, request, 'share', id, { shared }); }
export async function annotate(db: any, owner: string, id: string, request: string, text: string) { return rpc(db, owner, request, 'annotate', id, { text }); }
export function toBundle(d: NonNullable<Awaited<ReturnType<typeof detail>>>): Bundle {
  const s = d.season;
  if (!s.result || !d.seed || !s.tape || !s.committed_at) throw new Error('not_completed');
  const b: Omit<Bundle, 'root'> = { format: FORMAT, id: s.id, frozen: frozenSchema.parse(s.frozen), committedAt: new Date(s.committed_at).toISOString(), commitment: s.commitment, seed: d.seed, tape: s.tape, result: s.result, resultHash: s.result_hash, events: d.events, exportedAt: new Date().toISOString() };
  if (commitHash(b.frozen, b.committedAt) !== b.commitment) throw new Error('commitment_mismatch');
  const bundle = { ...b, root: bundleRoot(b) }; if (!verifyBundle(JSON.stringify(bundle)).ok) throw new Error('export_inconsistent'); return bundle;
}
