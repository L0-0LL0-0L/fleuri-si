import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader } from "@/components/bits";
import { Panel } from "@/components/pq/ui";
import { GraftRibbon, GraftTrustNote, STATUS_LABEL, StatusChip } from "@/components/graft/bits";
import { useGarden } from "@/store/garden";
import { graftApprove, graftBundle, graftDecide, graftDetail, graftPropose, graftRun, graftShare, graftShared, graftTransition } from "@/lib/graft.functions";
import { TOOLS, isAddress } from "@/domain/graft";

export const Route = createFileRoute("/graft/$id")({
  head: () => ({
    meta: [
      { title: "Graft mandate — fleuri" },
      { name: "description", content: "Review, approve and run a read-only research mandate; inspect its reports, incidents, regression checks and evidence export." },
      { property: "og:title", content: "Graft mandate — fleuri" },
      { property: "og:description", content: "An owner-approved, read-only research mandate for one exact agent version." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Detail,
});

const newId = () => crypto.randomUUID();
const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…` : "—");

function Detail() {
  const { id } = Route.useParams();
  const { userId } = useGarden();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runReq, setRunReq] = useState(newId);
  const load = useCallback(async () => {
    try {
      const r = userId ? await graftDetail({ data: { id } }) : await graftShared({ data: { id } });
      const r2 = !r.ok && userId ? await graftShared({ data: { id } }) : r;
      if (r2.ok) { setD(r2); setErr(null); } else { setD(null); setErr(r2.error); }
    } catch { setErr("Could not reach the server."); }
  }, [id, userId]);
  useEffect(() => { let live = true; setD(null); setErr(null); load().then(() => { if (!live) setD(null); }); return () => { live = false; }; }, [load]);
  const act = async (f: () => Promise<any>, ok: (r: any) => string) => {
    setBusy(true);
    try { const r = await f(); if (!r.ok) toast.error(r.error); else toast.success(ok(r)); await load(); }
    catch { toast.error("Could not reach the server."); }
    finally { setBusy(false); }
  };
  if (err) return <EmptyState title="Mandate unavailable" body={err} action={<Link to="/graft" className="btn btn-paper">Back to Graft</Link>} />;
  if (!d) return <p className="text-sm">Loading…</p>;
  const m = d.mandate; const st = m.effective_status ?? m.status; const draft = m.draft;
  const owner = d.isOwner;
  return (
    <div className="space-y-5">
      <PageHeader title="Graft mandate" kicker={`${draft.pool.kind === "dbc" ? "DBC" : "DAMM v2"} pool research`}><GraftRibbon className="h-12 w-12" /></PageHeader>
      <GraftTrustNote />
      <Panel title="Mandate">
        <div className="flex flex-wrap items-center gap-2"><StatusChip s={st} />{!owner && <span className="chip">Shared read-only view</span>}{m.shared && owner && <span className="chip">Shared publicly</span>}</div>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="font-bold">Agent</dt><dd className="break-all">{m.agent_id} · {m.agent_version.db.archetype}, risk {m.agent_version.db.risk} · model {m.agent_version.modelId} · {m.agent_version.promptTemplate}</dd>
          <dt className="font-bold">Pool</dt><dd className="num break-all"><Link to="/watchtower" search={{ pool: draft.pool.address }} className="underline">{draft.pool.address}</Link></dd>
          <dt className="font-bold">Tools</dt><dd>{draft.tools.map((t: keyof typeof TOOLS) => TOOLS[t].label).join("; ")}</dd>
          <dt className="font-bold">Expires</dt><dd>{new Date(m.expires_at).toLocaleString()} ({new Date(m.expires_at).toISOString()})</dd>
          <dt className="font-bold">Budgets</dt><dd>{draft.budgets.runsPerDay} runs/day for this mandate (server-enforced, not on-chain) · evidence TTL {draft.evidenceTtlSecs}s · max observation age {draft.requirements.maxObservationAgeSecs}s</dd>
          <dt className="font-bold">Purchases</dt><dd>{draft.purchases.services.length ? `Proposals only, Botanist report up to ${Number(draft.purchases.maxAtomic) / 1e6} USDC` : "None allowed"}</dd>
          <dt className="font-bold">Draft hash</dt><dd className="num break-all">{m.draft_hash}</dd>
          <dt className="font-bold">Agent version</dt><dd className="num break-all">{m.agent_version_hash}{owner && d.currentVersionMatches === false && <span className="block text-poppy-deep">The agent or server version has changed since this draft. It can't be approved or run; draft a new one.</span>}</dd>
          {m.approval_proof_hash && <><dt className="font-bold">Approval evidence</dt><dd className="num break-all">{m.approval_proof_hash} · {m.approval_proof.observations.map((o: any) => `slot ${o.slot}`).join(", ")}</dd></>}
        </dl>
        {owner && (
          <div className="flex flex-wrap gap-2">
            {m.status === "draft" && <button type="button" className="btn btn-red" disabled={busy} onClick={() => act(() => graftTransition({ data: { id, to: "review" } }), () => "Moved to review.")}>Send to review</button>}
            {m.status === "review" && <button type="button" className="btn btn-red" disabled={busy || d.currentVersionMatches === false} onClick={() => act(() => graftApprove({ data: { id, draftHash: m.draft_hash } }), (r) => r.denied ? `Not approved: ${r.denied.replace("_", " ")}` : "Approved with fresh pool evidence.")}>Approve this exact draft</button>}
            {st === "active" && <button type="button" className="btn btn-red" disabled={busy} onClick={() => act(async () => { const r = await graftRun({ data: { mandateId: id, requestId: runReq } }); if (r.ok && r.status !== "busy") setRunReq(newId()); return r; }, (r) => r.status === "done" ? "Report saved." : r.status === "denied" ? `Refused: ${r.code.replace(/_/g, " ")}` : r.status === "busy" ? "Already running; try again shortly." : `Job ${r.status}.`)}>{busy ? "Working…" : "Run steward now"}</button>}
            {["draft", "review", "active", "suspended"].includes(m.status) && <button type="button" className="btn btn-paper" disabled={busy} onClick={() => { if (confirm("Revoke this mandate? This cannot be undone.")) void act(() => graftTransition({ data: { id, to: "revoked" } }), () => "Revoked."); }}>Revoke</button>}
            {st === "active" && <button type="button" className="btn btn-paper" disabled={busy} onClick={() => act(() => graftTransition({ data: { id, to: "completed" } }), () => "Marked complete.")}>Mark complete</button>}
            <button type="button" className="btn btn-paper" disabled={busy} onClick={() => act(() => graftShare({ data: { id, shared: !m.shared } }), (r) => r.shared ? "Anyone with the link can now read this mandate." : "Private again.")}>{m.shared ? "Make private" : "Share read-only link"}</button>
            <button type="button" className="btn btn-paper" disabled={busy} onClick={async () => {
              const r = await graftBundle({ data: { id } }).catch(() => null);
              if (!r?.ok) { toast.error(r ? r.error : "Could not reach the server."); return; }
              const url = URL.createObjectURL(new Blob([r.bundle], { type: "application/json" }));
              const a = document.createElement("a"); a.href = url; a.download = `graft-${id.slice(0, 8)}.json`; a.click(); URL.revokeObjectURL(url);
            }}>Export evidence</button>
          </div>
        )}
        {m.status === "review" && owner && <p className="text-xs">Approving fetches fresh read-only evidence for this pool first. If the pool can't be read, is stale or doesn't qualify, approval is refused.</p>}
      </Panel>

      <Panel title={`Reports (${d.reports.length})`}>
        {d.reports.length === 0 ? <p className="text-sm">No reports yet.</p> : (
          <ul className="space-y-3">{[...d.reports].reverse().map((r: any) => (
            <li key={r.job_id} className="hair bg-paper p-2 text-sm">
              <p className="num text-xs break-all">report {short(r.report_hash)} · {new Date(r.created_at).toLocaleString()}</p>
              {r.report.observations.map((o: any, i: number) => <p key={i} className="text-xs">{TOOLS[o.tool as keyof typeof TOOLS]?.label ?? o.tool} · slot <span className="num">{o.slot}</span> · fetched {new Date(o.fetchedAt).toLocaleTimeString()} · result {short(o.resultHash)}</p>)}
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">{r.report.qualifications.map((q: any) => (
                <li key={q.id} className="hair bg-paper-light p-1 text-xs"><span className={`num font-bold ${q.status === "met" ? "" : "text-poppy-deep"}`}>{q.status === "met" ? "MET" : q.status === "not_met" ? "NOT MET" : "UNKNOWN"}</span> {q.label}<span className="block">{q.detail}</span></li>
              ))}</ul>
            </li>
          ))}</ul>
        )}
        <p className="text-xs">Qualifications are hard facts read from chain accounts at the slots shown. They are not predictions of price or profit.</p>
      </Panel>

      {owner && draft.purchases.services.length > 0 && <Proposals d={d} id={id} busy={busy} act={act} active={st === "active"} />}

      <Panel title={`Incidents (${d.incidents.length})`}>
        {d.incidents.length === 0 ? <p className="text-sm">None.</p> : <ul className="space-y-1 text-sm">{d.incidents.map((i: any, k: number) => <li key={k}><span className="num font-bold">{i.code}</span> · {new Date(i.at).toLocaleString()} — {i.detail}</li>)}</ul>}
      </Panel>

      <Panel title="Regression checks (rerun now)">
        <p className="text-xs">Captured cases replay the exact typed gate snapshot recorded at each incident. Built-in fixtures are synthetic, documented cases. Passing them doesn't grant any permission.</p>
        <ul className="space-y-1 text-sm">{d.regressions.map((r: any) => <li key={r.id}><span className="num font-bold">{r.pass ? "PASS" : "FAIL"}</span> <span className="chip">{r.source}</span> {r.label} — expected {r.expected}, got {r.got}</li>)}</ul>
      </Panel>

      <Panel title="Timeline (append-only)">
        <ol className="space-y-1 text-sm">{d.events.map((e: any, k: number) => <li key={k} className="num text-xs">{new Date(e.at).toLocaleString()} · {e.kind}{e.from_status !== e.to_status ? ` · ${STATUS_LABEL[e.from_status] ?? "—"} → ${STATUS_LABEL[e.to_status] ?? e.to_status}` : ""}</li>)}</ol>
      </Panel>
      <Link to="/graft" className="btn btn-paper">Back to Graft</Link>
    </div>
  );
}

function Proposals({ d, id, busy, act, active }: { d: any; id: string; busy: boolean; act: (f: () => Promise<any>, ok: (r: any) => string) => Promise<void>; active: boolean }) {
  const [mint, setMint] = useState("");
  const [amt, setAmt] = useState("100000");
  const [purpose, setPurpose] = useState("");
  const [req, setReq] = useState(newId);
  const cap = Number(d.mandate.draft.purchases.maxAtomic);
  const ok = isAddress(mint) && /^[1-9]\d*$/.test(amt) && Number(amt) <= cap && purpose.trim().length > 0;
  return (
    <Panel title="Purchase proposals (no payment authority)">
      <ul className="space-y-2 text-sm">{d.proposals.map((p: any) => {
        const s = p.effective_status ?? p.status;
        return (
          <li key={p.id} className="hair bg-paper p-2">
            <StatusChip s={s} /> <span className="num">{Number(p.proposal.maxAtomic) / 1e6} USDC max</span> · Botanist report for <span className="num break-all">{p.proposal.mint}</span> · until {new Date(p.expires_at).toLocaleString()}
            <p className="text-xs">{p.proposal.purpose}</p>
            {s === "proposed" && <div className="mt-1 flex gap-2">
              <button type="button" className="btn btn-red" disabled={busy} onClick={() => act(() => graftDecide({ data: { id: p.id, hash: p.proposal_hash, approve: true } }), (r) => STATUS_LABEL[r.status] ?? r.status)}>Approve proposal</button>
              <button type="button" className="btn btn-paper" disabled={busy} onClick={() => act(() => graftDecide({ data: { id: p.id, hash: p.proposal_hash, approve: false } }), () => "Rejected.")}>Reject</button>
            </div>}
            {s === "approved_awaiting_wallet_payment" && <p className="mt-1 text-xs">Nothing has been paid. To buy, use the <Link to="/botanist" className="underline">Botanist checkout</Link> with your own wallet; it shows the live x402 price before you sign.</p>}
          </li>
        );
      })}</ul>
      {active ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-sm font-bold sm:col-span-3">Token mint<input className="hair mt-1 block w-full bg-paper-light p-2 font-normal num" value={mint} onChange={(e) => { setMint(e.target.value.trim()); setReq(newId()); }} spellCheck={false} /></label>
          <label className="text-sm font-bold">Max (atomic, cap {cap})<input className="hair mt-1 block w-full bg-paper-light p-2 font-normal num" value={amt} onChange={(e) => { setAmt(e.target.value.replace(/\D/g, "")); setReq(newId()); }} /></label>
          <label className="text-sm font-bold sm:col-span-2">Why<input className="hair mt-1 block w-full bg-paper-light p-2 font-normal" maxLength={200} value={purpose} onChange={(e) => { setPurpose(e.target.value); setReq(newId()); }} /></label>
          <button type="button" className="btn btn-paper sm:col-span-3" disabled={busy || !ok} onClick={() => act(() => graftPropose({ data: { mandateId: id, requestId: req, service: "botanist.report", mint, maxAtomic: amt, minutes: 60, purpose } }), () => "Proposal recorded. Nothing was paid.")}>Record proposal</button>
          <p className="text-xs sm:col-span-3">Needs a steward report within the evidence TTL. Approving a proposal only records your consent; it never pays.</p>
        </div>
      ) : <p className="text-xs">New proposals need an active mandate.</p>}
    </Panel>
  );
}
