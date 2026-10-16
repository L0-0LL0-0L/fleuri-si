// Fleuri Graft v1 — Research Steward. Pure and browser-safe: mandate schema, version digests, the
// fail-closed run gate, deterministic regression cases, and the strict offline evidence-bundle verifier.
// Nothing here can move funds; purchases are proposals only.
import { parseStrictJson } from "@/pq/strict-json";
import { sha256Hex, utf8 } from "@/pq/canonical";
import { b58decode } from "@/pq/memo-reader";

export const MANDATE_SCHEMA = "fleuri.graft.mandate/1";
export const AGENT_VERSION_SCHEMA = "fleuri.graft.agent-version/1";
export const REPORT_SCHEMA = "fleuri.graft.report/1";
export const BUNDLE_FORMAT = "fleuri.graft.bundle/2";
export const BUNDLE_FORMAT_V1 = "fleuri.graft.bundle/1"; // pre-evidence exports: no "evidence" field
export const PROPOSAL_SCHEMA = "fleuri.graft.purchase-proposal/1";
export const PROMPT_TEMPLATE_VERSION = "garden-cycle-prompt/1";
export const STEWARD_VERSION = "research-steward/1";

/** The only tools a v1 mandate may approve. Each is a read-only server adapter. */
export const TOOLS = {
  "watchtower.dbc_pool": { label: "Graduation Watchtower read of a DBC pool (lifecycle, config, derived DAMM v2)", adapter: "watchtower/1", kinds: ["dbc"] },
  "damm_v2.pool_account": { label: "DAMM v2 pool account read (owner program, decoded mints, liquidity)", adapter: "damm-v2-read/1", kinds: ["damm_v2"] },
} as const;
export type ToolId = keyof typeof TOOLS;
export const SERVICES = { "botanist.report": { label: "Botanist x402 report (paid separately through the wallet checkout)", currency: "USDC", maxAtomic: 5_000_000 } } as const;
export type ServiceId = keyof typeof SERVICES;

export const LIMITS = { ownerDailyJobs: 6, maxInflight: 2, maxRunsPerDay: 3, minTtl: 60, maxTtl: 3600, maxDays: 30, leaseSecs: 60, maxJsonBytes: 256_000 } as const;
export type PoolKind = "dbc" | "damm_v2";
export type MandateStatus = "draft" | "review" | "active" | "expired" | "suspended" | "revoked" | "completed";
export const TRANSITIONS: Record<MandateStatus, MandateStatus[]> = {
  draft: ["review", "revoked", "suspended"], review: ["active", "revoked", "suspended", "expired"], active: ["expired", "suspended", "revoked", "completed"],
  suspended: ["revoked"], expired: [], revoked: [], completed: [],
};

export class GraftError extends Error { constructor(public code: DenyCode | "invalid", m: string) { super(m); this.name = "GraftError"; } }
export type DenyCode = "expired_mandate" | "stale_proof" | "changed_config" | "service_unavailable" | "request_mismatch" | "unsupported_pool" | "quota_exceeded" | "lease_lost" | "not_active";

/** Stable JSON: sorted keys, finite numbers only, plain objects only. */
export function stable(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new GraftError("invalid", "non-finite number"); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object") {
    const p = Object.getPrototypeOf(v); if (p !== Object.prototype && p !== null) throw new GraftError("invalid", "non-plain object");
    return `{${Object.keys(v as object).sort().map((k) => { const x = (v as any)[k]; if (x === undefined) throw new GraftError("invalid", `undefined field ${k}`); return `${JSON.stringify(k)}:${stable(x)}`; }).join(",")}}`;
  }
  throw new GraftError("invalid", `unsupported ${typeof v}`);
}
export const digest = (s: string) => sha256Hex(utf8(s));
export const hashOf = (domain: string, v: unknown) => digest(`${domain}\n${stable(v)}`);
export const draftHash = (d: MandateDraft) => hashOf(MANDATE_SCHEMA, d);
export const agentVersionHash = (v: AgentVersion) => hashOf(AGENT_VERSION_SCHEMA, v);
export const reportHash = (r: unknown) => hashOf(REPORT_SCHEMA, r);
export const proposalHash = (p: unknown) => hashOf(PROPOSAL_SCHEMA, p);

export interface AgentVersion {
  schema: typeof AGENT_VERSION_SCHEMA; agentId: string; modelId: string; promptTemplate: string; steward: string;
  policy: "rules-engine"; tools: { id: ToolId; adapter: string }[];
  db: { archetype: string; risk: number; handle: string; personaDigest: string; strategyDigest: string };
}
export function agentVersion(a: { id: string; archetype: string; risk: number; handle: string; persona: string; strategy: string }, modelId: string): AgentVersion {
  return {
    schema: AGENT_VERSION_SCHEMA, agentId: a.id, modelId, promptTemplate: PROMPT_TEMPLATE_VERSION, steward: STEWARD_VERSION, policy: "rules-engine",
    tools: (Object.keys(TOOLS) as ToolId[]).map((id) => ({ id, adapter: TOOLS[id].adapter })),
    db: { archetype: a.archetype, risk: a.risk, handle: a.handle, personaDigest: digest(a.persona), strategyDigest: digest(a.strategy) },
  };
}

export interface MandateDraft {
  schema: typeof MANDATE_SCHEMA; agentId: string; agentVersionHash: string; cluster: "mainnet-beta";
  pool: { kind: PoolKind; address: string }; tools: ToolId[]; expiresAt: string;
  budgets: { runsPerDay: number; maxInflight: number }; evidenceTtlSecs: number;
  requirements: { maxObservationAgeSecs: number; requireSlot: true };
  purchases: { services: ServiceId[]; currency: "USDC"; maxAtomic: string };
  note: string;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Strict Solana address: base58 alphabet AND decodes to exactly 32 bytes. */
export function isAddress(s: unknown): s is string {
  if (typeof s !== "string" || !B58.test(s)) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const HEX = /^[0-9a-f]{64}$/;
const keysExact = (o: any, keys: string[], where: string) => {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new GraftError("invalid", `${where} must be an object`);
  const k = Object.keys(o); const extra = k.filter((x) => !keys.includes(x)); const miss = keys.filter((x) => !k.includes(x));
  if (extra.length) throw new GraftError("invalid", `${where}: unsupported field ${extra[0]}`);
  if (miss.length) throw new GraftError("invalid", `${where}: missing ${miss[0]}`);
};
const int = (v: any, lo: number, hi: number, w: string) => { if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new GraftError("invalid", `${w} must be an integer ${lo}–${hi}`); return v as number; };

/** Strict validation; unsupported capabilities, tools, services or fields are rejected. */
export function validateDraft(d: any, now: number): MandateDraft {
  keysExact(d, ["schema", "agentId", "agentVersionHash", "cluster", "pool", "tools", "expiresAt", "budgets", "evidenceTtlSecs", "requirements", "purchases", "note"], "mandate");
  if (d.schema !== MANDATE_SCHEMA) throw new GraftError("invalid", "unsupported mandate schema");
  if (typeof d.agentId !== "string" || !/^[\w-]{1,40}$/.test(d.agentId)) throw new GraftError("invalid", "bad agent id");
  if (typeof d.agentVersionHash !== "string" || !HEX.test(d.agentVersionHash)) throw new GraftError("invalid", "bad agent version hash");
  if (d.cluster !== "mainnet-beta") throw new GraftError("invalid", "only mainnet-beta read-only inspection is supported");
  keysExact(d.pool, ["kind", "address"], "pool");
  if (d.pool.kind !== "dbc" && d.pool.kind !== "damm_v2") throw new GraftError("unsupported_pool", "pool kind must be dbc or damm_v2");
  if (!isAddress(d.pool.address)) throw new GraftError("unsupported_pool", "pool address is not a Solana address");
  if (!Array.isArray(d.tools) || d.tools.length < 1 || d.tools.length > 2 || new Set(d.tools).size !== d.tools.length) throw new GraftError("invalid", "choose one or two distinct tools");
  for (const t of d.tools) { if (!(t in TOOLS)) throw new GraftError("invalid", `unsupported tool ${String(t).slice(0, 40)}`); if (!(TOOLS[t as ToolId].kinds as readonly string[]).includes(d.pool.kind)) throw new GraftError("invalid", `${t} does not apply to a ${d.pool.kind} pool`); }
  if (typeof d.expiresAt !== "string" || !ISO.test(d.expiresAt)) throw new GraftError("invalid", "expiry must be an ISO UTC time");
  const exp = Date.parse(d.expiresAt);
  if (!(exp > now)) throw new GraftError("expired_mandate", "expiry must be in the future");
  if (exp > now + LIMITS.maxDays * 86400_000) throw new GraftError("invalid", `expiry is limited to ${LIMITS.maxDays} days`);
  keysExact(d.budgets, ["runsPerDay", "maxInflight"], "budgets");
  int(d.budgets.runsPerDay, 1, LIMITS.maxRunsPerDay, "runs per day"); int(d.budgets.maxInflight, 1, 1, "max inflight per mandate");
  int(d.evidenceTtlSecs, LIMITS.minTtl, LIMITS.maxTtl, "evidence TTL");
  keysExact(d.requirements, ["maxObservationAgeSecs", "requireSlot"], "requirements");
  int(d.requirements.maxObservationAgeSecs, 10, d.evidenceTtlSecs, "max observation age");
  if (d.requirements.requireSlot !== true) throw new GraftError("invalid", "slot provenance is required");
  keysExact(d.purchases, ["services", "currency", "maxAtomic"], "purchases");
  if (!Array.isArray(d.purchases.services) || d.purchases.services.length > 1 || d.purchases.services.some((s: any) => !(s in SERVICES))) throw new GraftError("invalid", "unsupported purchase service");
  if (d.purchases.currency !== "USDC") throw new GraftError("invalid", "only USDC proposals are supported");
  if (typeof d.purchases.maxAtomic !== "string" || !/^(0|[1-9]\d{0,9})$/.test(d.purchases.maxAtomic)) throw new GraftError("invalid", "max amount must be an integer string");
  const cap = d.purchases.services.length ? SERVICES[d.purchases.services[0] as ServiceId].maxAtomic : 0;
  if (Number(d.purchases.maxAtomic) > cap) throw new GraftError("invalid", `max amount exceeds the ${cap} atomic cap`);
  if (typeof d.note !== "string" || d.note.length > 280) throw new GraftError("invalid", "note is limited to 280 characters");
  return d as MandateDraft;
}

// ---------- the run gate (used by the server before and after each observation) ----------
export interface GateInput {
  mandate: { status: MandateStatus; expiresAt: string; draftHash: string; agentVersionHash: string; draft: MandateDraft };
  currentAgentVersionHash: string | null; // null = agent missing / not owned
  now: number;
  request?: { mandateDraftHash: string; inputHash: string; storedInputHash?: string };
  observation?: { ok: true; fetchedAt: string; slot: number | null } | { ok: false; reason: "unavailable" | "unsupported_pool" };
}
export type GateResult = { allow: true } | { allow: false; code: DenyCode; detail: string };
const deny = (code: DenyCode, detail: string): GateResult => ({ allow: false, code, detail });

/** Unknown fails closed. Order matters: authority checks precede evidence checks. */
export function gate(g: GateInput): GateResult {
  const m = g.mandate;
  if (!(Date.parse(m.expiresAt) > g.now)) return deny("expired_mandate", "The mandate expired; nothing was run.");
  if (m.status !== "active") return deny("not_active", `The mandate is ${m.status}.`);
  if (!g.currentAgentVersionHash || g.currentAgentVersionHash !== m.agentVersionHash) return deny("changed_config", "The agent configuration no longer matches the approved version.");
  if (g.request) {
    if (g.request.mandateDraftHash !== m.draftHash) return deny("request_mismatch", "The request names a different mandate version.");
    if (g.request.storedInputHash && g.request.storedInputHash !== g.request.inputHash) return deny("request_mismatch", "This request id was used with different inputs.");
  }
  if (g.observation) {
    if (!g.observation.ok) return g.observation.reason === "unsupported_pool" ? deny("unsupported_pool", "The address is not a supported pool for this mandate.") : deny("service_unavailable", "The read-only chain service was unavailable.");
    const t = Date.parse(g.observation.fetchedAt);
    if (!Number.isFinite(t) || (m.draft.requirements.requireSlot && !(Number.isSafeInteger(g.observation.slot) && (g.observation.slot as number) > 0))) return deny("stale_proof", "The observation has no verifiable slot or time.");
    if (g.now - t > m.draft.requirements.maxObservationAgeSecs * 1000 || t - g.now > 30_000) return deny("stale_proof", "The observation is older than the mandate allows.");
  }
  return { allow: true };
}

// ---------- deterministic regression cases from typed failures ----------
export interface RegressionCase { id: string; code: DenyCode | "allow"; label: string; input: GateInput }
export function regressionCases(base: { draft: MandateDraft; draftHash: string; agentVersionHash: string; now: number }): RegressionCase[] {
  const m = { status: "active" as MandateStatus, expiresAt: base.draft.expiresAt, draftHash: base.draftHash, agentVersionHash: base.agentVersionHash, draft: base.draft };
  const fresh = { ok: true as const, fetchedAt: new Date(base.now - 1000).toISOString(), slot: 300_000_000 };
  const now = Math.min(base.now, Date.parse(base.draft.expiresAt) - 1000);
  return [
    { id: "baseline", code: "allow", label: "Fresh, slot-stamped observation under an active mandate", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now, observation: { ...fresh, fetchedAt: new Date(now - 1000).toISOString() } } },
    { id: "expired", code: "expired_mandate", label: "Mandate past its expiry", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now: Date.parse(base.draft.expiresAt) + 1, observation: fresh } },
    { id: "stale", code: "stale_proof", label: "Observation older than the allowed age", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now, observation: { ok: true, fetchedAt: new Date(now - (base.draft.requirements.maxObservationAgeSecs + 5) * 1000).toISOString(), slot: 1 } } },
    { id: "no-slot", code: "stale_proof", label: "Observation without slot provenance", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now, observation: { ok: true, fetchedAt: new Date(now).toISOString(), slot: null } } },
    { id: "changed", code: "changed_config", label: "Agent prompt/model/settings changed after approval", input: { mandate: m, currentAgentVersionHash: "0".repeat(64), now, observation: fresh } },
    { id: "unavailable", code: "service_unavailable", label: "Read-only chain service unavailable", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now, observation: { ok: false, reason: "unavailable" } } },
    { id: "mismatch", code: "request_mismatch", label: "Retry with a changed request body", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now, request: { mandateDraftHash: base.draftHash, inputHash: "a".repeat(64), storedInputHash: "b".repeat(64) } } },
    { id: "unsupported", code: "unsupported_pool", label: "Address is not a supported pool", input: { mandate: m, currentAgentVersionHash: base.agentVersionHash, now, observation: { ok: false, reason: "unsupported_pool" } } },
  ];
}
export function runRegressions(cases: RegressionCase[]) {
  return cases.map((c) => { const r = gate(c.input); const got = r.allow ? "allow" : r.code; return { id: c.id, label: c.label, expected: c.code, got, pass: got === c.code }; });
}

// ---------- qualifications from hard observations (no profit claims) ----------
export interface Qualification { id: string; label: string; status: "met" | "not_met" | "unknown"; detail: string }

// ---------- evidence bundle ----------
export const DISCLOSURE = "Hashes show internal consistency of this export. They do not prove when events happened, that the server ran honestly, or that any observation is still current. Purchase approvals are consent records only; no payment is authorized or made by Graft.";
export const PROPOSAL_STATUSES = ["proposed", "approved_awaiting_wallet_payment", "rejected", "expired"] as const;
export const DENY_CODES: DenyCode[] = ["expired_mandate", "stale_proof", "changed_config", "service_unavailable", "request_mismatch", "unsupported_pool", "quota_exceeded", "lease_lost", "not_active"];
export const OBS_INPUT = "fleuri.graft.observation-input/1";
export const OBS_RESULT = "fleuri.graft.observation-result/1";
export const JOB_INPUT = "fleuri.graft.job-input/1";
export const PROOF_SCHEMA = "fleuri.graft.approval-proof/1";
export const DRAFT_REQUEST = "fleuri.graft.draft-request/1";
export const PROPOSAL_REQUEST = "fleuri.graft.proposal-request/1";
export const EVIDENCE_LINK = "fleuri.graft.evidence-link/1";
export const EVIDENCE_MANIFEST = "fleuri.graft.evidence-manifest/1";
export type EvidenceKind = "bloom_entry" | "research_receipt";
export interface EvidenceLinkOut { kind: EvidenceKind; refId: string; agentId: string; policyHash: string; manifest: any; manifestHash: string; attachedAt: string }
/** Order-independent hash of the attached supporting evidence, frozen into the approval proof. */
export const evidenceManifestHash = (links: { kind: string; refId: string; manifestHash: string }[]) =>
  hashOf(EVIDENCE_MANIFEST, links.map((l) => ({ kind: l.kind, refId: l.refId, manifestHash: l.manifestHash })).sort((a, b) => (a.kind + a.refId < b.kind + b.refId ? -1 : 1)));

/** Hash chain over the exported history and incidents (self-consistency, not authenticity). */
export function contentRoot(b: { events: unknown[]; incidents: unknown[]; reports: { reportHash: string }[]; proposals: { proposalHash: string }[]; evidence?: { manifestHash: string }[] }) {
  let h = "0".repeat(64);
  for (const e of b.events) h = digest(`fleuri.graft.event\n${h}\n${stable(e)}`);
  for (const i of b.incidents) h = digest(`fleuri.graft.incident\n${h}\n${stable(i)}`);
  for (const r of b.reports) h = digest(`fleuri.graft.report\n${h}\n${r.reportHash}`);
  for (const p of b.proposals) h = digest(`fleuri.graft.proposal\n${h}\n${p.proposalHash}`);
  for (const l of b.evidence ?? []) h = digest(`fleuri.graft.evidence\n${h}\n${l.manifestHash}`);
  return h;
}

export type CheckStatus = "pass" | "fail" | "unsupported";
export interface BundleCheck { id: string; label: string; status: CheckStatus; detail: string }
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

export function verifyBundle(text: string): { valid: boolean; checks: BundleCheck[]; bundle: any } {
  const checks: BundleCheck[] = [];
  const add = (id: string, label: string, ok: boolean | "unsupported", detail: string) => checks.push({ id, label, status: ok === "unsupported" ? "unsupported" : ok ? "pass" : "fail", detail });
  let b: any;
  try { b = parseStrictJson(text, { maxBytes: 2_000_000, maxDepth: 40 }); }
  catch (e) { add("parse", "Strict JSON", false, (e as Error).message); return { valid: false, checks, bundle: null }; }
  const m = b?.mandate;
  try {
    if (b?.format !== BUNDLE_FORMAT && b?.format !== BUNDLE_FORMAT_V1) { add("format", "Format version", "unsupported", `Unsupported format ${String(b?.format).slice(0, 40)}`); return { valid: false, checks, bundle: null }; }
    keysExact(b, ["format", "mandate", "events", "reports", "incidents", "proposals", "contentRoot", "exportedAt", "disclosure", ...(b.format === BUNDLE_FORMAT ? ["evidence"] : [])], "bundle");
    keysExact(m, ["id", "status", "draft", "draftHash", "agentVersion", "agentVersionHash", "expiresAt", "approvedAt", "approvedHash", "approvalProof", "approvalProofHash", "createdAt"], "mandate");
    if (!isUuid(m.id) || !(m.status in TRANSITIONS) || !isHex(m.draftHash) || !isHex(m.agentVersionHash) || !isIso(m.expiresAt) || !isIso(m.createdAt)) throw new GraftError("invalid", "mandate fields malformed");
    if ((m.approvedAt === null) !== (m.approvedHash === null) || (m.approvedAt !== null && !isIso(m.approvedAt))) throw new GraftError("invalid", "approval fields inconsistent");
    if ((m.approvalProof === null) !== (m.approvalProofHash === null)) throw new GraftError("invalid", "approval proof fields inconsistent");
    validateDraft(m.draft, Date.parse(m.createdAt));
    for (const k of ["events", "reports", "incidents", "proposals", ...(b.format === BUNDLE_FORMAT ? ["evidence"] : [])]) if (!Array.isArray(b[k]) || b[k].length > 500) throw new GraftError("invalid", `${k} must be a bounded list`);
    if (!isIso(b.exportedAt) || !isHex(b.contentRoot) || b.disclosure !== DISCLOSURE) throw new GraftError("invalid", "export envelope malformed");
  } catch (e) { add("schema", "Bundle schema", false, (e as Error).message); return { valid: false, checks, bundle: null }; }
  add("parse", "Strict JSON and schema", true, "No duplicate keys, finite numbers, known fields and versions, valid addresses, hashes and dates.");
  const d = m.draft as MandateDraft;
  add("draft", "Mandate draft hash", draftHash(d) === m.draftHash && d.expiresAt === m.expiresAt, "Recomputed draft hash and expiry.");
  let vOk = false;
  try { vOk = m.agentVersion?.schema === AGENT_VERSION_SCHEMA && agentVersionHash(m.agentVersion) === m.agentVersionHash && d.agentVersionHash === m.agentVersionHash && m.agentVersion.agentId === d.agentId; } catch { vOk = false; }
  add("version", "Agent version binding", vOk, vOk ? "Agent version recomputes and is the one the draft names." : "Agent version does not match the draft.");
  // approval: required for any status reached through active
  const wasActive = b.events.some((e: any) => e?.to === "active");
  let aOk = (m.approvedHash === null) === !wasActive && (m.approvedHash === null || m.approvedHash === m.draftHash);
  if (aOk && m.approvalProof) {
    try {
      const p = m.approvalProof;
      const ev = (b.evidence ?? []) as EvidenceLinkOut[];
      const pk = Object.keys(p).sort().join(",");
      const evOk = "evidenceManifestHash" in p ? b.format === BUNDLE_FORMAT && p.evidenceManifestHash === evidenceManifestHash(ev) : ev.length === 0;
      aOk = (pk === "draftHash,observations,schema" || pk === "draftHash,evidenceManifestHash,observations,schema") && evOk && p.schema === PROOF_SCHEMA && p.draftHash === m.draftHash && hashOf(PROOF_SCHEMA, p) === m.approvalProofHash && Array.isArray(p.observations) && p.observations.length > 0
        && p.observations.every((o: any) => (d.tools as string[]).includes(o.tool) && o.inputHash === hashOf(OBS_INPUT, { tool: o.tool, pool: d.pool }) && isHex(o.resultHash) && Number.isSafeInteger(o.slot) && o.slot > 0 && isIso(o.fetchedAt) && Date.parse(o.fetchedAt) <= Date.parse(m.approvedAt) + 30_000 && Date.parse(m.approvedAt) - Date.parse(o.fetchedAt) <= d.evidenceTtlSecs * 1000);
    } catch { aOk = false; }
  }
  if (aOk && wasActive && !m.approvalProof && (b.evidence ?? []).length) aOk = false;
  add("approval", "Approval binding and evidence", aOk, m.approvedHash ? (m.approvalProof ? "Approval names this draft and carries fresh pool evidence within the TTL." : "Approval names this draft (recorded before evidence proofs existed).") : "Never approved.");
  // history
  let st: string | null = null; let hOk = true; let prev = m.createdAt as string;
  for (const e of b.events) {
    try { keysExact(e, ["kind", "from", "to", "at", "detail"], "event"); } catch { hOk = false; break; }
    if (!isIso(e.at) || e.at < prev || e.at > b.exportedAt || typeof e.kind !== "string" || e.kind.length > 40) { hOk = false; break; }
    prev = e.at;
    if (st === null) { if (e.from !== null || e.to !== "draft" || e.kind !== "created") { hOk = false; break; } st = "draft"; continue; }
    if (e.from !== st) { hOk = false; break; }
    if (e.to !== e.from && !(TRANSITIONS[e.from as MandateStatus] ?? []).includes(e.to)) { hOk = false; break; }
    st = e.to;
  }
  hOk = hOk && st === m.status;
  add("history", "State history", hOk, hOk ? `Starts as a draft, transitions are allowed and in order, ends in "${m.status}".` : "History does not start with the draft, is out of order, skips states or does not end in the current status.");
  // reports
  let rOk = true; let rDetail = `${b.reports.length} report(s) recompute and bind to this mandate, pool, tools and version.`;
  const jobs = new Set<string>(); const reqs = new Set<string>();
  for (const r of b.reports) {
    try {
      keysExact(r, ["jobId", "reportHash", "createdAt", "report"], "report");
      const x = r.report;
      if (x?.schema !== REPORT_SCHEMA) throw new Error("Unsupported report schema.");
      if (reportHash(x) !== r.reportHash) throw new Error(`Report ${String(r.jobId).slice(0, 8)} hash mismatch.`);
      if (x.mandateId !== m.id || x.draftHash !== m.draftHash || x.agentVersionHash !== m.agentVersionHash || x.jobId !== r.jobId) throw new Error("A report is bound to another mandate, version or job.");
      if (jobs.has(r.jobId) || reqs.has(x.requestId)) throw new Error("Duplicate job or request.");
      jobs.add(r.jobId); reqs.add(x.requestId);
      if (x.inputHash !== hashOf(JOB_INPUT, { schema: JOB_INPUT, mandateId: m.id, draftHash: m.draftHash, pool: d.pool, tools: d.tools, requestId: x.requestId })) throw new Error("Job input hash does not recompute.");
      if (!Array.isArray(x.observations) || x.observations.length !== d.tools.length) throw new Error("Observations do not cover the approved tools.");
      for (const o of x.observations) {
        if (!(d.tools as string[]).includes(o.tool) || o.adapter !== TOOLS[o.tool as ToolId].adapter) throw new Error("Observation tool/adapter not approved.");
        if (o.inputHash !== hashOf(OBS_INPUT, { tool: o.tool, pool: d.pool })) throw new Error("Observation input hash does not bind the pool.");
        if (hashOf(OBS_RESULT, o.result) !== o.resultHash) throw new Error("An observation result hash does not recompute.");
        if (o.cluster !== "mainnet-beta" || typeof o.genesisHash !== "string" || !Number.isSafeInteger(o.slot) || o.slot <= 0 || !isIso(o.fetchedAt)) throw new Error("Observation provenance incomplete.");
        if (Date.parse(r.createdAt) - Date.parse(o.fetchedAt) > d.requirements.maxObservationAgeSecs * 1000) throw new Error("Observation was stale when the report was saved.");
      }
      if (!Array.isArray(x.qualifications) || x.qualifications.some((q: any) => !["met", "not_met", "unknown"].includes(q?.status))) throw new Error("Qualification statuses malformed.");
      if (!b.events.some((e: any) => e.kind === "report" && e.detail?.reportHash === r.reportHash)) throw new Error("A report is missing from the event history.");
    } catch (e) { rOk = false; rDetail = (e as Error).message; break; }
  }
  add("reports", "Reports and observations", rOk, rDetail);
  // incidents
  let iOk = true; let iDetail = "Incident codes are known; captured gate cases reproduce their codes.";
  for (const i of b.incidents) {
    try {
      keysExact(i, ["code", "detail", "at", "jobId", "gateCase"], "incident");
      if (!DENY_CODES.includes(i.code) || typeof i.detail !== "string" || i.detail.length > 240 || !isIso(i.at)) throw new Error("Malformed incident.");
      if (i.gateCase) { const g = gate(i.gateCase); if ((g.allow ? "allow" : g.code) !== i.code) throw new Error(`Captured case for ${i.code} does not reproduce.`); }
    } catch (e) { iOk = false; iDetail = (e as Error).message; break; }
  }
  add("incidents", "Incidents and captured cases", iOk, iDetail);
  // proposals
  let pOk = true; let pDetail = "Proposals recompute, stay within caps and are proposal-only; none claims payment.";
  const pids = new Set<string>();
  for (const p of b.proposals) {
    try {
      keysExact(p, ["id", "status", "proposalHash", "proposal", "expiresAt", "decidedAt"], "proposal");
      const x = p.proposal;
      if (!isUuid(p.id) || pids.has(p.id) || !(PROPOSAL_STATUSES as readonly string[]).includes(p.status) || !isIso(p.expiresAt) || (p.decidedAt !== null && !isIso(p.decidedAt))) throw new Error("Malformed proposal.");
      pids.add(p.id);
      if (proposalHash(x) !== p.proposalHash || x.schema !== PROPOSAL_SCHEMA || x.mandateDraftHash !== m.draftHash || x.agentVersionHash !== m.agentVersionHash || x.mandateId !== m.id) throw new Error("A proposal hash or binding does not match.");
      if (!(d.purchases.services as string[]).includes(x.service) || x.currency !== d.purchases.currency || !isAddress(x.mint) || !/^[1-9]\d{0,9}$/.test(x.maxAtomic) || Number(x.maxAtomic) > Number(d.purchases.maxAtomic)) throw new Error("A proposal exceeds the mandate's service, currency or cap.");
      if (x.payment !== "proposed_only" || x.expiresAt !== p.expiresAt || p.expiresAt > m.expiresAt) throw new Error("A proposal claims payment or outlives the mandate.");
    } catch (e) { pOk = false; pDetail = (e as Error).message; break; }
  }
  add("proposals", "Purchase proposals", pOk, pDetail);
  // supporting evidence: same agent + policy only; never a permission, never covers the model/prompt/tools
  let eOk = true; let eDetail = `${(b.evidence ?? []).length} supporting evidence link(s) recompute, bind this agent and were attached before review.`;
  const eKeys = new Set<string>();
  for (const l of (b.evidence ?? []) as any[]) {
    try {
      keysExact(l, ["kind", "refId", "agentId", "policyHash", "manifest", "manifestHash", "attachedAt"], "evidence");
      const x = l.manifest;
      if (!["bloom_entry", "research_receipt"].includes(l.kind) || !isUuid(l.refId) || !isHex(l.policyHash) || !isHex(l.manifestHash) || !isIso(l.attachedAt)) throw new Error("Malformed evidence link.");
      if (eKeys.has(l.kind + l.refId)) throw new Error("Duplicate evidence link."); eKeys.add(l.kind + l.refId);
      if (x?.schema !== EVIDENCE_LINK || hashOf(EVIDENCE_LINK, x) !== l.manifestHash) throw new Error("An evidence manifest hash does not recompute.");
      if (x.kind !== l.kind || x.refId !== l.refId || x.agentId !== d.agentId || l.agentId !== d.agentId || x.policyHash !== l.policyHash) throw new Error("Evidence is bound to another agent or policy.");
      if (x.coverage?.model !== "not_covered" || x.coverage?.promptTemplate !== "not_covered" || x.coverage?.tools !== "not_covered" || x.coverage?.policy !== "match") throw new Error("Evidence overstates what it covers.");
      if (l.attachedAt < m.createdAt || (m.approvedAt && l.attachedAt > m.approvedAt)) throw new Error("Evidence was attached outside the draft window.");
      if (!b.events.some((e: any) => e.kind === "evidence_attached" && e.detail?.manifestHash === l.manifestHash)) throw new Error("An evidence link is missing from the event history.");
    } catch (e) { eOk = false; eDetail = (e as Error).message; break; }
  }
  add("evidence", "Supporting evidence", eOk, eDetail);
  let cOk = false; try { cOk = contentRoot(b) === b.contentRoot; } catch { cOk = false; }
  add("root", "Content root", cOk, cOk ? "History, incidents, reports and proposals hash to the exported root (detects accidental edits; not proof of authenticity)." : "Content root does not recompute.");
  const valid = checks.every((c) => c.status === "pass");
  return { valid, checks, bundle: valid ? b : null };
}
