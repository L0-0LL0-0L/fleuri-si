// Server-only Graft Research Steward orchestration. Every write goes through service-role graft_* RPCs that
// recheck ownership, status, expiry and the agent configuration in the same transaction. Chain reads are
// read-only, fixed-adapter and bounded; no client-supplied RPC URL is ever used.
import {
  BUNDLE_FORMAT, DISCLOSURE, GraftError, LIMITS, SERVICES, TOOLS, agentVersion, agentVersionHash, draftHash, gate, hashOf, proposalHash,
  regressionCases, reportHash, runRegressions, validateDraft, contentRoot, isAddress, REPORT_SCHEMA, MANDATE_SCHEMA, OBS_INPUT, OBS_RESULT, JOB_INPUT, PROOF_SCHEMA,
  type DenyCode, type MandateDraft, type Qualification, type ServiceId, type ToolId,
} from "@/domain/graft";

const MCOLS = "id,owner_id,request_id,agent_id,status,draft,draft_hash,agent_version,agent_version_hash,expires_at,approved_at,approved_hash,approval_proof,approval_proof_hash,shared,created_at,updated_at";
const must = (r: { data: any; error: any }) => { if (r.error) throw new Error(clean(r.error.message)); return r.data; };
/** Sanitized: strips SQL prefixes and anything that looks like a URL or key. */
export function clean(m: string) { return String(m).replace(/^.*?ERROR:\s*/, "").replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9_-]{48,}/g, "[redacted]").slice(0, 240); }
const modelId = async () => (await import("./ai.server")).AI_MODEL;

async function loadAgent(db: any, owner: string, id: string) {
  const a = must(await db.from("agents").select("id,handle,archetype,risk,persona,strategy,owner_id,status").eq("id", id).maybeSingle());
  if (!a || a.owner_id !== owner) throw new GraftError("not_active", "Choose one of your own agents.");
  return a;
}
async function currentVersion(db: any, owner: string, id: string) {
  try { const a = await loadAgent(db, owner, id); if (a.status === "archived") return null; return agentVersion(a, await modelId()); } catch { return null; }
}

export interface Terms { agentId: string; poolKind: "dbc" | "damm_v2"; pool: string; tools: ToolId[]; hours: number; runsPerDay: number; evidenceTtlSecs: number; maxObservationAgeSecs: number; purchaseService: ServiceId | null; purchaseMaxAtomic: string; note: string }

export function buildDraft(t: Terms, versionHash: string, now: number, fixedExpiry?: string): MandateDraft {
  const expiresAt = fixedExpiry ?? new Date(Math.floor((now + t.hours * 3600_000) / 1000) * 1000).toISOString();
  return validateDraft({
    schema: MANDATE_SCHEMA, agentId: t.agentId, agentVersionHash: versionHash, cluster: "mainnet-beta", pool: { kind: t.poolKind, address: t.pool }, tools: t.tools,
    expiresAt, budgets: { runsPerDay: t.runsPerDay, maxInflight: 1 }, evidenceTtlSecs: t.evidenceTtlSecs,
    requirements: { maxObservationAgeSecs: t.maxObservationAgeSecs, requireSlot: true },
    purchases: { services: t.purchaseService ? [t.purchaseService] : [], currency: "USDC", maxAtomic: t.purchaseService ? t.purchaseMaxAtomic : "0" }, note: t.note,
  }, now);
}

export type Observer = (tool: ToolId, pool: string) => Promise<{ ok: true; fetchedAt: string; slot: number; cluster: string; genesisHash: string; result: any; qualifications: Qualification[] } | { ok: false; reason: "unavailable" | "unsupported_pool"; detail: string }>;

/** Default observer: the existing Watchtower reader for DBC pools; an SDK-coder read for DAMM v2 pools. */
export const chainObserver: Observer = async (tool, pool) => {
  const { PublicError } = await import("./observatory.server");
  const W = await import("@/pq/watchtower");
  try {
    if (tool === "watchtower.dbc_pool") {
      const { watch } = await import("./watchtower.server");
      const { input, summary } = await watch(pool);
      const dv = W.dammVerified(input);
      const result = JSON.parse(JSON.stringify({ stage: summary.stage, progressBps: summary.progressBps, damm: dv, checks: summary.checks.map((c: any) => ({ id: c.id, status: c.status })), slots: input.slots, baseMint: input.pool.baseMint, config: input.pool.config, isMigrated: input.pool.isMigrated, migrationProgress: input.pool.migrationProgress }));
      return { ok: true, fetchedAt: input.fetchedAt, slot: input.slots.pool, cluster: input.cluster, genesisHash: input.genesisHash, result, qualifications: [
        { id: "dbc_owner", label: "Account is a DBC virtual pool", status: "met", detail: "Owned by the DBC program and decoded with the installed SDK coder." },
        { id: "config", label: "Pool config decoded", status: input.config ? "met" : "unknown", detail: input.config ? "Config account read and decoded." : "Config could not be decoded." },
        { id: "stage", label: "Lifecycle stage observed", status: summary.stage.stage === "unsupported" ? "unknown" : "met", detail: `${summary.stage.stage}: ${summary.stage.reason}`.slice(0, 200) },
        { id: "damm", label: "Graduated to a verified DAMM v2 pool", status: dv.ok ? "met" : "not_met", detail: dv.reason.slice(0, 200) },
      ] };
    }
    const sol = await import("./solana.server");
    const e = sol.solEnv(); if (e.cluster !== "mainnet-beta" || !e.rpcUrl) return { ok: false, reason: "unavailable", detail: "Mainnet reads are not configured." };
    const { bounded } = await import("./watchtower.server");
    const conn = sol.connection();
    const genesisHash = await bounded(sol.assertGenesis(conn, e.cluster));
    const { PublicKey } = await import("@solana/web3.js");
    const r = await bounded(conn.getAccountInfoAndContext(new PublicKey(pool), "confirmed"));
    if (!r.value || r.value.owner.toBase58() !== W.DAMM_V2_PROGRAM) return { ok: false, reason: "unsupported_pool", detail: "Not owned by the DAMM v2 program." };
    const { createDammV2Program } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    let p: any; try { p = (createDammV2Program(conn) as any).coder.accounts.decode("pool", r.value.data); } catch { return { ok: false, reason: "unsupported_pool", detail: "Does not decode as a DAMM v2 pool." }; }
    const s = (v: any) => (v == null ? "" : v.toBase58 ? v.toBase58() : v.toString());
    const result = { tokenAMint: s(p.tokenAMint), tokenBMint: s(p.tokenBMint), liquidity: s(p.liquidity), permanentLockLiquidity: s(p.permanentLockLiquidity), poolStatus: Number(s(p.poolStatus) || 0), slot: r.context.slot };
    return { ok: true, fetchedAt: new Date().toISOString(), slot: r.context.slot, cluster: e.cluster, genesisHash, result, qualifications: [
      { id: "damm_owner", label: "Account is a DAMM v2 pool", status: "met", detail: "Owned by the DAMM v2 program and decoded with the installed SDK coder." },
      { id: "liquidity", label: "Pool holds liquidity", status: BigInt(result.liquidity || "0") > 0n ? "met" : "not_met", detail: `liquidity ${result.liquidity}` },
      { id: "locked", label: "Some liquidity permanently locked", status: BigInt(result.permanentLockLiquidity || "0") > 0n ? "met" : "not_met", detail: `permanent lock ${result.permanentLockLiquidity}` },
    ] };
  } catch (e) {
    if (e instanceof PublicError && /not owned|not a virtual pool|No account/.test(e.message)) return { ok: false, reason: "unsupported_pool", detail: e.message };
    return { ok: false, reason: "unavailable", detail: e instanceof PublicError ? e.message : "The chain read failed." };
  }
};

export async function createDraft(db: any, owner: string, input: { requestId: string; terms: Terms }, observe: Observer = chainObserver, now = Date.now()) {
  if (!isAddress(input.terms.pool)) throw new GraftError("unsupported_pool", "The pool address is not a valid 32-byte Solana address.");
  // Retry recovery BEFORE reading the live agent or pool: rebuild with the stored expiry and version.
  const prior = must(await db.from("graft_mandates").select("id,draft,draft_hash").eq("owner_id", owner).eq("request_id", input.requestId).maybeSingle());
  if (prior) {
    let same = false;
    try { same = draftHash(buildDraft(input.terms, prior.draft.agentVersionHash, Date.parse(prior.draft.expiresAt) - 1000, prior.draft.expiresAt)) === prior.draft_hash; } catch { same = false; }
    if (!same) throw new GraftError("request_mismatch", "This request id was already used with different terms; start a new draft.");
    return { id: prior.id as string, created: false, draftHash: prior.draft_hash as string };
  }
  const a = await loadAgent(db, owner, input.terms.agentId);
  if (a.status === "archived") throw new GraftError("not_active", "Archived agents cannot receive mandates.");
  const v = agentVersion(a, await modelId());
  const vh = agentVersionHash(v);
  const draft = buildDraft(input.terms, vh, now);
  // Pool must be readable and of the declared kind before a draft exists (fails closed when unknown).
  const probe = await observe(draft.tools[0], draft.pool.address);
  if (!probe.ok) throw new GraftError(probe.reason === "unsupported_pool" ? "unsupported_pool" : "service_unavailable", probe.reason === "unsupported_pool" ? `That address is not a supported ${draft.pool.kind === "dbc" ? "DBC" : "DAMM v2"} pool: ${clean(probe.detail)}` : "The pool could not be checked right now; try again.");
  const h = draftHash(draft);
  const r = must(await db.rpc("graft_create_draft", { _owner: owner, _request: input.requestId, _agent: a.id, _draft: draft, _draft_hash: h, _agent_version: v, _agent_version_hash: vh, _expires: draft.expiresAt }));
  return { id: r.id as string, created: !!r.created, draftHash: h };
}

export async function getMandate(db: any, id: string) {
  return must(await db.from("graft_mandates").select(MCOLS).eq("id", id).maybeSingle());
}

/** Fresh, qualified, server-fetched pool evidence for approval. Unknown / stale / unqualified fails closed. */
export async function approvalProof(draft: MandateDraft, dh: string, observe: Observer, clock: () => number) {
  const observations: any[] = [];
  for (const tool of draft.tools) {
    const o = await observe(tool, draft.pool.address);
    if (!o.ok) throw new GraftError(o.reason === "unsupported_pool" ? "unsupported_pool" : "service_unavailable", o.reason === "unsupported_pool" ? "The pool no longer qualifies for this mandate." : "Pool evidence could not be fetched; approval needs fresh evidence.");
    const age = clock() - Date.parse(o.fetchedAt);
    if (!(o.slot > 0) || !Number.isFinite(age) || age > draft.evidenceTtlSecs * 1000 || age < -30_000) throw new GraftError("stale_proof", "Pool evidence is stale or lacks a slot.");
    const owner = o.qualifications.find((q) => q.id === "dbc_owner" || q.id === "damm_owner");
    if (owner?.status !== "met") throw new GraftError("unsupported_pool", "The pool program check did not pass.");
    observations.push({ tool, fetchedAt: o.fetchedAt, slot: o.slot, genesisHash: o.genesisHash, inputHash: hashOf(OBS_INPUT, { tool, pool: draft.pool }), resultHash: hashOf(OBS_RESULT, o.result), qualifications: o.qualifications.map((q) => ({ id: q.id, status: q.status })) });
  }
  const proof = { schema: PROOF_SCHEMA, draftHash: dh, observations };
  const fetchedAt = observations.map((o) => o.fetchedAt).sort()[0];
  return { proof, hash: hashOf(PROOF_SCHEMA, proof), fetchedAt };
}

export async function approve(db: any, owner: string, id: string, reviewedHash: string, observe: Observer = chainObserver, clock: () => number = Date.now) {
  const m = await getMandate(db, id);
  if (!m || m.owner_id !== owner) throw new GraftError("not_active", "Mandate not found.");
  if (reviewedHash !== m.draft_hash) throw new GraftError("request_mismatch", "You reviewed a different draft; reload and review again.");
  const cur = await currentVersion(db, owner, m.agent_id);
  const p = m.status === "review" ? await approvalProof(m.draft, m.draft_hash, observe, clock) : { proof: null, hash: null, fetchedAt: null };
  // Pass the CURRENT server-computed version: SQL compares it with the frozen one under row locks.
  const r = must(await db.rpc("graft_approve_v2", { _owner: owner, _id: id, _draft_hash: m.draft_hash, _agent_version_hash: cur ? agentVersionHash(cur) : "0".repeat(64), _expires: m.expires_at, _agent_version: cur ?? {}, _proof: p.proof, _proof_hash: p.hash, _proof_fetched_at: p.fetchedAt }));
  return r as { status: string; applied: boolean; denied?: DenyCode };
}

export async function transition(db: any, owner: string, id: string, to: "review" | "revoked" | "completed") {
  return must(await db.rpc("graft_transition", { _owner: owner, _id: id, _to: to }));
}
export async function setShared(db: any, owner: string, id: string, shared: boolean) {
  return must(await db.rpc("graft_set_shared", { _owner: owner, _id: id, _shared: shared }));
}

/** One bounded research job: claim (lease) → observe → gate → commit or immutable incident. */
export async function run(db: any, owner: string, input: { mandateId: string; requestId: string }, observe: Observer = chainObserver, clock: () => number = Date.now) {
  const m = await getMandate(db, input.mandateId);
  if (!m || m.owner_id !== owner) throw new GraftError("not_active", "Mandate not found.");
  const draft = m.draft as MandateDraft;
  const jobInput = { schema: JOB_INPUT, mandateId: m.id, draftHash: m.draft_hash, pool: draft.pool, tools: draft.tools, requestId: input.requestId };
  const inputHash = hashOf(JOB_INPUT, jobInput);
  const cur = await currentVersion(db, owner, m.agent_id);
  const c = must(await db.rpc("graft_claim_job_v2", { _owner: owner, _mandate: m.id, _request: input.requestId, _input: jobInput, _input_hash: inputHash, _agent_version_hash: cur ? agentVersionHash(cur) : "0".repeat(64), _owner_limit: LIMITS.ownerDailyJobs, _max_inflight: LIMITS.maxInflight, _lease_secs: LIMITS.leaseSecs }));
  if (c.denied) return { status: "denied" as const, code: c.denied as DenyCode };
  if (c.status !== "claimed") return { status: c.status as "done" | "busy" | "failed", job: c.job as string };
  const stored = c.input; // retries always use the stored frozen input
  const fail = async (code: DenyCode, detail: string, gateCase: any = null) => {
    const r = await db.rpc("graft_fail_job_v2", { _owner: owner, _job: c.job, _lease: c.lease, _code: code, _detail: clean(detail), _case: gateCase });
    if (r.error) { if (/lease_lost/.test(r.error.message)) return { status: "denied" as const, code: "lease_lost" as DenyCode, job: c.job as string }; throw new Error(clean(r.error.message)); }
    return { status: "denied" as const, code, job: c.job as string };
  };
  const fresh = await getMandate(db, m.id); // reload current policy after claim
  const gateBase = { mandate: { status: fresh.status, expiresAt: fresh.expires_at, draftHash: fresh.draft_hash, agentVersionHash: fresh.agent_version_hash, draft }, currentAgentVersionHash: cur ? agentVersionHash(cur) : null };
  const preIn = { ...gateBase, now: clock(), request: { mandateDraftHash: stored.draftHash, inputHash: hashOf(JOB_INPUT, stored), storedInputHash: inputHash } };
  const pre = gate(preIn);
  if (!pre.allow) return fail(pre.code, pre.detail, preIn);
  const observations: any[] = []; const qualifications: Qualification[] = [];
  for (const tool of stored.tools as ToolId[]) {
    if (!(tool in TOOLS)) return fail("unsupported_pool", "Unsupported tool.");
    const o = await observe(tool, stored.pool.address);
    const gIn = { ...gateBase, now: clock(), observation: o.ok ? { ok: true as const, fetchedAt: o.fetchedAt, slot: o.slot } : { ok: false as const, reason: o.reason } };
    const g = gate(gIn);
    if (!g.allow) return fail(g.code, o.ok ? g.detail : `${g.detail} ${clean(o.detail)}`, gIn); // captured typed snapshot (no prompts, no raw errors)
    if (!o.ok) return fail("service_unavailable", "Unknown observation state.");
    observations.push({ tool, adapter: TOOLS[tool].adapter, cluster: o.cluster, genesisHash: o.genesisHash, fetchedAt: o.fetchedAt, slot: o.slot,
      inputHash: hashOf(OBS_INPUT, { tool, pool: stored.pool }), result: o.result, resultHash: hashOf(OBS_RESULT, o.result) });
    qualifications.push(...o.qualifications);
  }
  const report = {
    schema: REPORT_SCHEMA, mandateId: m.id, draftHash: m.draft_hash, agentVersionHash: m.agent_version_hash, jobId: c.job, requestId: stored.requestId, inputHash,
    generation: c.generation, observations, qualifications,
    note: "Read-only observations of on-chain accounts at the slots shown. Qualifications are hard facts, not performance or profit predictions.",
  };
  const rh = reportHash(report);
  try {
    const oldest = observations.map((o) => o.fetchedAt).sort()[0];
    const latest = await currentVersion(db, owner, m.agent_id); // recheck code+DB version at commit time
    const r = must(await db.rpc("graft_commit_report_v2", { _owner: owner, _job: c.job, _lease: c.lease, _report: report, _report_hash: rh, _agent_version_hash: latest ? agentVersionHash(latest) : "0".repeat(64), _observed_at: oldest }));
    if (r.denied) return { status: "denied" as const, code: r.denied as DenyCode, job: c.job as string };
    return { status: "done" as const, job: c.job as string, reportHash: rh };
  } catch (e) {
    if (/lease_lost/.test((e as Error).message)) return { status: "denied" as const, code: "lease_lost" as DenyCode, job: c.job as string };
    throw e;
  }
}

export function buildProposal(m: any, input: { service: ServiceId; mint: string; maxAtomic: string; purpose: string }, expiresAt: string) {
  return { schema: "fleuri.graft.purchase-proposal/1", mandateId: m.id, mandateDraftHash: m.draft_hash, agentVersionHash: m.agent_version_hash, service: input.service, mint: input.mint, currency: "USDC", maxAtomic: input.maxAtomic, quote: "fetched at payment time via the Botanist x402 checkout", expiresAt, purpose: input.purpose, payment: "proposed_only" };
}
export async function propose(db: any, owner: string, input: { mandateId: string; requestId: string; service: ServiceId; mint: string; maxAtomic: string; minutes: number; purpose: string }, now = Date.now()) {
  if (!isAddress(input.mint)) throw new GraftError("invalid", "The mint is not a valid 32-byte Solana address.");
  if (!(input.service in SERVICES)) throw new GraftError("invalid", "Unsupported service.");
  const m = await getMandate(db, input.mandateId);
  if (!m || m.owner_id !== owner) throw new GraftError("not_active", "Mandate not found.");
  const prior = must(await db.from("graft_proposals").select("id,status,proposal,proposal_hash").eq("owner_id", owner).eq("request_id", input.requestId).maybeSingle());
  if (prior) {
    if (proposalHash(buildProposal(m, input, prior.proposal.expiresAt)) !== prior.proposal_hash) throw new GraftError("request_mismatch", "This request id was already used for a different proposal.");
    return { id: prior.id, created: false, status: prior.status };
  }
  const expiresAt = new Date(Math.min(Date.parse(m.expires_at), Math.floor((now + input.minutes * 60_000) / 1000) * 1000)).toISOString();
  const proposal = buildProposal(m, input, expiresAt);
  const cur = await currentVersion(db, owner, m.agent_id);
  const r = must(await db.rpc("graft_propose_v2", { _owner: owner, _mandate: m.id, _request: input.requestId, _proposal: proposal, _hash: proposalHash(proposal), _expires: expiresAt, _agent_version_hash: cur ? agentVersionHash(cur) : "0".repeat(64) }));
  if (r.denied) throw new GraftError(r.denied, r.denied === "changed_config" ? "The agent or server version changed; the mandate was suspended." : "The mandate expired.");
  return r;
}
export async function decide(db: any, owner: string, id: string, hash: string, approve: boolean) {
  const p = must(await db.from("graft_proposals").select("mandate_id").eq("id", id).eq("owner_id", owner).maybeSingle());
  if (!p) throw new GraftError("not_active", "Proposal not found.");
  const m = await getMandate(db, p.mandate_id);
  const cur = await currentVersion(db, owner, m.agent_id);
  return must(await db.rpc("graft_decide_v2", { _owner: owner, _id: id, _hash: hash, _approve: approve, _agent_version_hash: cur ? agentVersionHash(cur) : "0".repeat(64) }));
}

/** Displayed status: an active mandate past expiry is reported as expired even before a write records it. */
export const effectiveStatus = (m: { status: string; expires_at: string }, now = Date.now()) => (m.status === "active" && Date.parse(m.expires_at) <= now ? "expired" : m.status);

export async function listMine(db: any, owner: string) {
  return must(await db.from("graft_mandates").select("id,agent_id,status,draft,draft_hash,expires_at,shared,created_at").eq("owner_id", owner).order("created_at", { ascending: false }).limit(50));
}

/** Full detail for the owner, or the shareable subset when shared. Never returns owner id, prompts or persona text. */
export async function detail(db: any, id: string, viewer: string | null) {
  const m = await getMandate(db, id);
  if (!m) return null;
  const isOwner = !!viewer && m.owner_id === viewer;
  if (!isOwner && !m.shared) return null;
  const [events, reports, incidents, proposals, jobs] = await Promise.all([
    db.from("graft_events").select("kind,from_status,to_status,detail,at").eq("mandate_id", id).order("id", { ascending: true }).limit(500),
    db.from("graft_reports").select("job_id,report,report_hash,created_at").eq("mandate_id", id).order("created_at", { ascending: true }).limit(100),
    db.from("graft_incidents").select("code,detail,at,job_id,gate_case").eq("mandate_id", id).order("at", { ascending: true }).limit(200),
    db.from("graft_proposals").select("id,status,proposal,proposal_hash,expires_at,decided_at").eq("mandate_id", id).order("created_at", { ascending: true }).limit(50),
    isOwner ? db.from("graft_jobs").select("id,status,day,created_at,finished_at,lease_expires_at").eq("mandate_id", id).order("created_at", { ascending: false }).limit(20) : Promise.resolve({ data: [], error: null }),
  ]).then((rs) => rs.map(must));
  const { owner_id: _o, request_id: _r, ...pub } = m;
  (pub as any).effective_status = effectiveStatus(m);
  for (const p of proposals as any[]) if (p.status === "approved_awaiting_wallet_payment" || p.status === "proposed") { if (Date.parse(p.expires_at) <= Date.now() || (pub as any).effective_status !== "active") p.effective_status = "expired"; }
  const cur = isOwner ? await currentVersion(db, viewer!, m.agent_id) : null;
  const builtIn = runRegressions(regressionCases({ draft: m.draft, draftHash: m.draft_hash, agentVersionHash: m.agent_version_hash, now: Date.now() })).map((r) => ({ ...r, source: "built-in fixture" as const }));
  const captured = (incidents as any[]).filter((i) => i.gate_case).map((i, k) => { const g = gate(i.gate_case); const got = g.allow ? "allow" : g.code; return { id: `incident-${k + 1}`, label: `Captured at ${new Date(i.at).toISOString()}: ${i.code}`, expected: i.code, got, pass: got === i.code, source: "incident snapshot" as const }; });
  const regressions = [...captured, ...builtIn];
  return { mandate: pub, isOwner, events, reports, incidents, proposals, jobs, currentVersionMatches: isOwner ? !!cur && agentVersionHash(cur) === m.agent_version_hash : null, regressions };
}

export function toBundle(d: NonNullable<Awaited<ReturnType<typeof detail>>>) {
  const m = d.mandate as any;
  const b: any = {
    format: BUNDLE_FORMAT,
    mandate: { id: m.id, status: m.status, draft: m.draft, draftHash: m.draft_hash, agentVersion: m.agent_version, agentVersionHash: m.agent_version_hash, expiresAt: iso(m.expires_at), approvedAt: m.approved_at ? iso(m.approved_at) : null, approvedHash: m.approved_hash, approvalProof: m.approval_proof ?? null, approvalProofHash: m.approval_proof_hash ?? null, createdAt: iso(m.created_at) },
    events: d.events.map((e: any) => ({ kind: e.kind, from: e.from_status, to: e.to_status, at: iso(e.at), detail: e.detail ?? {} })),
    reports: d.reports.map((r: any) => ({ jobId: r.job_id, reportHash: r.report_hash, createdAt: iso(r.created_at), report: r.report })),
    incidents: d.incidents.map((i: any) => ({ code: i.code, detail: i.detail, at: iso(i.at), jobId: i.job_id, gateCase: i.gate_case ?? null })),
    proposals: d.proposals.map((p: any) => ({ id: p.id, status: p.status, proposalHash: p.proposal_hash, proposal: p.proposal, expiresAt: iso(p.expires_at), decidedAt: p.decided_at ? iso(p.decided_at) : null })),
    exportedAt: new Date().toISOString(), disclosure: DISCLOSURE,
  };
  b.contentRoot = contentRoot(b);
  return b;
}
const iso = (t: string) => new Date(t).toISOString();
