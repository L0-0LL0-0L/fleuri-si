import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SUPPORTED_ENGINES, evidenceStatus, policyHash, type EvidenceLabel } from "@/domain/greenhouse";
import type { Agent } from "@/domain/types";
import { ghAttach } from "@/lib/greenhouse.functions";
import { cn } from "@/lib/utils";

/** A signed research receipt over the same run, scoped to the reviewing owner. */
/** Only server-verified receipts reach this type (signature, identity, integrity and run binding all passed). */
export interface ReceiptEvidence { id: string; run_id: string; manifest_hash: string; schema: string; legacy: boolean; published: boolean; signed_at: string; issuer_key: string; engine_version: string; policies: { agentId: string; policyHash: string }[];
  verified: { signature: true; integrity: true; identity: true; replay: "pass" | "unsupported" };
  anchor: { recorded: string; signature: string | null; chainVerified: false } }
export function receiptStatus(r: ReceiptEvidence, e: { origin_agent_id: string; run_policy_hash: string }) {
  const pol = r.policies.find((p) => p.agentId === e.origin_agent_id);
  return { includesAgent: !!pol, policyMatch: !!pol && pol.policyHash === e.run_policy_hash, engine: SUPPORTED_ENGINES.includes(r.engine_version as any) ? "supported" as const : "unsupported" as const };
}
export interface EvidenceRow { id: string; proposal_id: string; run_id: string; origin_agent_id: string; run_policy_hash: string; proposal_policy_hash: string | null; engine_version: string; content_hash: string; repetitions: number; scenarios: string[]; attached_at: string; receipts?: ReceiptEvidence[]; receiptsError?: string }
function deepFreeze<T>(v: T): T { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as object)) deepFreeze(x); } return v; }
const short = (h: string | null) => (h ? `${h.slice(0, 8)}…` : "unknown");

export function originAgentId(p: { origin_agent_id?: string | null; agent_handle: string }, agents: Record<string, Agent>) {
  return p.origin_agent_id ?? Object.values(agents).find((a) => a.handle === p.agent_handle)?.id ?? null;
}

export function EvidenceList({ rows, agents, frozen }: { rows: EvidenceRow[]; agents: Record<string, Agent>; frozen?: boolean }) {
  if (!rows.length) return <p className="text-xs text-ink-soft">No greenhouse evidence attached by you.</p>;
  return (
    <ul className="space-y-1">
      {rows.map((e) => {
        const cur = agents[e.origin_agent_id];
        const st = evidenceStatus({ runPolicyHash: e.run_policy_hash, proposalPolicyHash: e.proposal_policy_hash, engineVersion: e.engine_version }, cur ? policyHash(cur) : null);
        const tone = (ok: boolean) => cn("hair px-1 font-mono text-[0.6rem] uppercase", ok ? "bg-sprout text-paper-light" : "bg-paper-deep");
        return (
          <li key={e.id} className="hair space-y-1 bg-paper p-2 text-xs">
            <p className="flex flex-wrap items-center gap-1">
              <span className={tone(st.policy === "match")}>{st.policy === "match" ? "policy matches draft" : st.policy === "mismatch" ? "policy differs from draft" : "draft policy unknown (legacy)"}</span>
              <span className={tone(st.currency === "current")}>{st.currency === "current" ? "agent unchanged since" : st.currency === "stale" ? "stale · agent edited since" : "agent unavailable"}</span>
              <span className={tone(st.engine === "supported")}>{st.engine === "supported" ? e.engine_version : `unsupported engine ${e.engine_version}`}</span>
            </p>
            <p className="break-words">policy <span className="font-mono">{short(e.run_policy_hash)}</span> · rules mode · {e.repetitions} repetition(s) × {e.scenarios.length} scenario(s) · content <span className="font-mono">{short(e.content_hash)}</span> · attached {new Date(e.attached_at).toLocaleDateString()}</p>
            <Link to="/greenhouse" search={{ run: e.run_id }} className="underline">Open trial</Link>
          </li>
        );
      })}
      <li className="text-[0.7rem] text-ink-soft">{frozen ? "Frozen when you loaded this draft; later attachments or agent edits do not change what this review shows. " : ""}Advisory vSOL sandbox evidence only — not an approval, safety rating or forecast.</li>
    </ul>
  );
}

export function AttachEvidence({ proposalId, originId, runs, onDone }: { proposalId: string; originId: string | null; runs: any[]; onDone: () => Promise<void> }) {
  const eligible = runs.filter((r) => r.status === "done" && originId && r.agent_ids.includes(originId));
  const [run, setRun] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!originId) return <p className="text-xs text-ink-soft">The drafting agent is unknown, so no trial can be attached.</p>;
  if (!eligible.length) return <p className="text-xs"><Link to="/greenhouse" className="underline">Run a greenhouse trial</Link> that includes this agent to attach evidence.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select aria-label="Trial to attach" className="field" value={run} onChange={(e) => setRun(e.target.value)}>
        <option value="">Choose one of your trials…</option>
        {eligible.map((r) => <option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString()} · {short(r.content_hash)}</option>)}
      </select>
      <button type="button" className="btn btn-paper" disabled={!run || busy} onClick={() => { setBusy(true); setMsg(""); ghAttach({ data: { proposalId, runId: run } }).then(async (r) => { if (!r.ok) throw new Error(r.error); setMsg("Attached to your review."); await onDone(); }).catch((e) => setMsg((e as Error).message)).finally(() => setBusy(false)); }}>{busy ? "Attaching…" : "Attach evidence"}</button>
      {msg && <span role="status">{msg}</span>}
    </div>
  );
}

/** Immutable snapshot of what the reviewer saw when they clicked "Use this draft". */
export interface FrozenReview {
  proposalId: string; name: string; symbol: string; agentHandle: string;
  originPolicyHash: string | null; originMode: string | null; frozenAt: string;
  items: { row: EvidenceRow; status: EvidenceLabel; receipts: { r: ReceiptEvidence; s: ReturnType<typeof receiptStatus> }[]; receiptsError: string | null }[];
}
export function freezeReview(p: { id: string; name: string; symbol: string; agent_handle: string; origin_policy_hash?: string | null; origin_mode?: string | null }, rows: EvidenceRow[], agents: Record<string, Agent>, now: Date): FrozenReview {
  const items = rows.filter((e) => e.proposal_id === p.id).map((e) => {
    const cur = agents[e.origin_agent_id];
    const receipts = (e.receipts ?? []).filter((r) => r.run_id === e.run_id && r.verified?.signature === true && r.verified?.integrity === true).map((r) => deepFreeze({ r: structuredClone(r), s: receiptStatus(r, e) }));
    return { row: deepFreeze(structuredClone(e)), receipts: Object.freeze(receipts) as any, receiptsError: e.receiptsError ?? null, status: evidenceStatus({ runPolicyHash: e.run_policy_hash, proposalPolicyHash: e.proposal_policy_hash, engineVersion: e.engine_version }, cur ? policyHash(cur) : null) };
  });
  return deepFreeze({ proposalId: p.id, name: p.name, symbol: p.symbol, agentHandle: p.agent_handle, originPolicyHash: p.origin_policy_hash ?? null, originMode: p.origin_mode ?? null, frozenAt: now.toISOString(), items });
}

/** Renders only the frozen snapshot — never recomputes status from live agents. */
export function FrozenEvidence({ review }: { review: FrozenReview }) {
  const tone = (ok: boolean) => cn("hair px-1 font-mono text-[0.6rem] uppercase", ok ? "bg-sprout text-paper-light" : "bg-paper-deep");
  return (
    <div className="space-y-1 text-xs" data-testid="frozen-evidence">
      <p className="font-mono text-[0.65rem] uppercase tracking-widest">Frozen review · {review.name} ${review.symbol} by @{review.agentHandle} · drafted with policy {review.originPolicyHash ? `${short(review.originPolicyHash)} (${review.originMode ?? "unknown"} mode)` : "unknown (legacy draft)"} · frozen {review.frozenAt.replace("T", " ").slice(0, 19)} UTC</p>
      {!review.items.length ? <p>No greenhouse evidence was attached when this review was frozen.</p> :
        <ul className="space-y-1">{review.items.map(({ row: e, status: st, receipts, receiptsError }) => (
          <li key={e.id} className="hair space-y-1 bg-paper p-2">
            <p className="flex flex-wrap items-center gap-1">
              <span className={tone(st.policy === "match")}>{st.policy === "match" ? "policy matches draft" : st.policy === "mismatch" ? "policy differs from draft" : "draft policy unknown (legacy)"}</span>
              <span className={tone(st.currency === "current")}>{st.currency === "current" ? "agent unchanged at freeze" : st.currency === "stale" ? "stale at freeze · agent edited" : "agent unavailable at freeze"}</span>
              <span className={tone(st.engine === "supported")}>{st.engine === "supported" ? e.engine_version : `unsupported engine ${e.engine_version}`}</span>
            </p>
            <p className="break-words">policy <span className="font-mono">{short(e.run_policy_hash)}</span> · rules mode · {e.repetitions} repetition(s) × {e.scenarios.length} scenario(s) · content <span className="font-mono">{short(e.content_hash)}</span> · attached {new Date(e.attached_at).toLocaleDateString()}</p>
            {receiptsError && <p role="alert" data-testid="frozen-receipt-error">Receipt evidence could not be loaded at freeze ({receiptsError}); none is shown.</p>}
            {receipts.map(({ r, s }) => <p key={r.id} className="flex flex-wrap items-center gap-1" data-testid="frozen-receipt">
              <span className={tone(true)}>signed receipt · signature & integrity verified</span>
              <span className={tone(r.verified.replay === "pass")}>{r.verified.replay === "pass" ? "exact replay" : "replay unsupported"}</span>
              {r.legacy && <span className={tone(false)}>legacy v1</span>}
              <span className={tone(s.policyMatch)}>{s.policyMatch ? "receipt policy matches" : s.includesAgent ? "receipt policy differs" : "receipt lacks agent"}</span>
              <span className={tone(s.engine === "supported")}>{s.engine === "supported" ? r.engine_version : `unsupported ${r.engine_version}`}</span>
              <span className={tone(false)}>{r.anchor.recorded === "none" ? "no anchor" : `anchor recorded ${r.anchor.recorded} at freeze · not re-read on chain`}</span>
              <span className="font-mono">key {short(r.issuer_key)} · receipt {short(r.manifest_hash)}</span>
            </p>)}
          </li>))}</ul>}
      <p className="text-[0.7rem] text-ink-soft">Frozen when you loaded this draft; later attachments or agent edits do not change it. Advisory vSOL sandbox evidence only — not part of the signed passport, not an approval, safety rating or forecast.</p>
    </div>
  );
}
