import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { evidenceStatus, policyHash } from "@/domain/greenhouse";
import type { Agent } from "@/domain/types";
import { ghAttach } from "@/lib/greenhouse.functions";
import { cn } from "@/lib/utils";

export interface EvidenceRow { id: string; proposal_id: string; run_id: string; origin_agent_id: string; run_policy_hash: string; proposal_policy_hash: string | null; engine_version: string; content_hash: string; repetitions: number; scenarios: string[]; attached_at: string }
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
