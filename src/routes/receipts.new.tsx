import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { ListSkeleton, PageHeader } from "@/components/bits";
import { Panel } from "@/components/pq/ui";
import { TrialReport, type TrialRow } from "@/components/greenhouse/TrialReport";
import { ManifestReview } from "@/components/receipts/ManifestReview";
import { ScopeNote } from "./receipts.index";
import { SUPPORTED_ENGINES } from "@/domain/greenhouse";
import { createFence } from "@/lib/greenhouse-session";
import { ghRun } from "@/lib/greenhouse.functions";
import { pqMine } from "@/lib/pq.functions";
import { rrPrepare, rrSign } from "@/lib/research.functions";
import { clearReceiptPending, readReceiptPending, writeReceiptPending, type ReceiptPending } from "@/lib/receipt-session";
import { loadLocal, usePqLocal, withSecret } from "@/pq/local";
import { signReceipt, type ReceiptManifestT } from "@/pq/receipt";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/receipts/new")({
  validateSearch: z.object({ run: z.string().uuid().optional() }),
  head: () => ({ meta: [
    { title: "Create a research receipt — fleuri" },
    { name: "description", content: "Review and sign a research receipt for one of your saved Greenhouse trials." },
    { property: "og:title", content: "Create a research receipt — fleuri" },
    { property: "og:description", content: "Sign a frozen Greenhouse trial with your registered PQ identity." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: NewReceipt,
});

function NewReceipt() {
  const { run: runId } = Route.useSearch();
  const navigate = useNavigate();
  const { userId, store } = useGarden();
  const local = usePqLocal();
  const fence = useRef(createFence()).current;
  const [row, setRow] = useState<TrialRow | null>(null); const [ids, setIds] = useState<any[] | null>(null);
  const [pick, setPick] = useState(""); const [draft, setDraft] = useState<{ id: string; manifest: ReceiptManifestT; manifestHash: string } | null>(null);
  const [pending, setPending] = useState<ReceiptPending | null>(null);
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState("");

  useEffect(() => { loadLocal(); }, []);
  // Owner/run change: clear every private draft/signature/pending view and fence late responses.
  useEffect(() => {
    const g = fence.bump();
    setRow(null); setIds(null); setPick(""); setDraft(null); setAck(false); setErr(""); setBusy(null);
    const p = runId ? readReceiptPending(userId, runId, localStorage) : null; setPending(p); if (p) setPick(p.identityId);
    if (!userId || !runId) return;
    Promise.all([ghRun({ data: { id: runId } }), pqMine()]).then(([r, m]) => {
      if (!fence.guard(g)) return;
      if (!r.ok) return setErr(r.error);
      if (!(r.data as any).mine) return setErr("Only your own saved trials can be attested from your account.");
      setRow(r.data as TrialRow);
      if (m.ok) setIds(m.data.identities.filter((i: any) => i.status !== "revoked")); else setErr(m.error);
    }).catch((e) => fence.guard(g) && setErr((e as Error).message));
  }, [userId, runId]);

  async function freeze() {
    if (!userId || !runId || !pick) return;
    const g = fence.current(); setBusy("Freezing the draft on the server…"); setErr("");
    try {
      const p: ReceiptPending = pending && pending.identityId === pick ? pending : { requestId: crypto.randomUUID(), runId, identityId: pick };
      writeReceiptPending(userId, p, localStorage); setPending(p); // saved before the request: reloads recover the same draft
      const r = await rrPrepare({ data: { requestId: p.requestId, runId, identityId: pick } });
      if (!fence.guard(g)) return;
      if (!r.ok) throw new Error(r.error);
      if (r.data.status === "signed") { clearReceiptPending(userId, runId, localStorage); toast.success("This receipt was already signed."); void navigate({ to: "/receipts/$id", params: { id: r.data.id } }); return; }
      const next = { ...p, receiptId: r.data.id, manifestHash: r.data.manifestHash }; writeReceiptPending(userId, next, localStorage); setPending(next);
      setDraft({ id: r.data.id, manifest: r.data.manifest, manifestHash: r.data.manifestHash }); setAck(false);
    } catch (e) { if (fence.guard(g)) setErr((e as Error).message); } finally { if (fence.guard(g)) setBusy(null); }
  }
  async function sign() {
    if (!userId || !runId || !draft || !pending) return;
    const g = fence.current(); setBusy("Signing with ML-DSA-65…"); setErr("");
    try {
      let sig = pending.receiptId === draft.id && pending.manifestHash === draft.manifestHash && pending.signature && pending.publicKey ? { publicKey: pending.publicKey, signature: pending.signature } : null;
      if (!sig) {
        const s = withSecret((kp) => signReceipt(draft.manifest, kp)); // the secret never leaves this call
        sig = { publicKey: s.publicKey, signature: s.signature };
        const next = { ...pending, ...sig }; writeReceiptPending(userId, next, localStorage); setPending(next); // resend these exact bytes after a lost response
      }
      setBusy("Server is verifying the signature…");
      const r = await rrSign({ data: { id: draft.id, ...sig } });
      if (!fence.guard(g)) return;
      if (!r.ok) throw new Error(r.error);
      clearReceiptPending(userId, runId, localStorage);
      toast.success(r.data.recovered ? "Recovered your signed receipt" : "Receipt signed and saved (private)");
      void navigate({ to: "/receipts/$id", params: { id: draft.id } });
    } catch (e) { if (fence.guard(g)) setErr((e as Error).message); } finally { if (fence.guard(g)) setBusy(null); }
  }

  const idt = ids?.find((i) => i.id === pick);
  const keyReady = !!idt && local.unlocked && local.envelope?.keyHash === idt.key_hash;
  const supported = row ? SUPPORTED_ENGINES.includes(row.input.engineVersion as any) : false;
  return <div className="space-y-4">
    <PageHeader title="new receipt" kicker="research receipts" />
    <ScopeNote />
    {!runId ? <Panel title="Choose a trial"><p className="text-sm">Open a completed trial in the <Link to="/greenhouse" className="underline">Greenhouse</Link> and choose “Create research receipt”.</p></Panel>
    : !userId ? <Panel title="Your workspace"><p className="text-sm">Open your workspace to attest your own trials.</p><button type="button" className="btn btn-ink" disabled={!!busy} onClick={() => { setBusy("Opening…"); store.startSandbox().catch((e) => setErr((e as Error).message)).finally(() => setBusy(null)); }}>{busy ?? "Open workspace"}</button></Panel>
    : err && !row ? <p role="alert" className="hair bg-poppy-deep p-2 text-sm text-paper-light">{err}</p>
    : !row || !ids ? <ListSkeleton />
    : row.status !== "done" || !supported ? <Panel title="Not eligible"><p className="text-sm">{row.status !== "done" ? "Only completed trials can be attested." : `This trial uses ${row.input.engineVersion}, which this build cannot replay exactly. Receipts require exact replay.`}</p></Panel>
    : <>
      <Panel title="1 · Choose your signing identity">
        {!ids.length ? <p className="text-sm">You have no registered PQ identity. <Link to="/identity" className="underline">Create and register one</Link>; an on-chain anchor is optional for receipts.</p> :
          <fieldset className="space-y-1" disabled={!!draft}>{ids.map((i) => <label key={i.id} className={cn("hair flex flex-wrap items-center gap-2 p-2 text-xs", pick === i.id ? "bg-paper-deep" : "bg-paper")}>
            <input type="radio" name="identity" checked={pick === i.id} onChange={() => setPick(i.id)} />
            <span className="min-w-0 break-all font-mono">{i.key_hash.slice(0, 16)}… · wallet {i.wallet.slice(0, 6)}…{i.wallet.slice(-4)} · {i.cluster}</span>
            <span className="hair bg-sprout px-1 font-mono text-[0.6rem] uppercase text-paper-light">registered</span>
            <span className={cn("hair px-1 font-mono text-[0.6rem] uppercase", i.status === "anchored" ? "bg-sprout text-paper-light" : "bg-paper-deep")}>{i.status === "anchored" ? "anchored" : "not anchored (optional)"}</span>
          </label>)}</fieldset>}
        {pending && !draft && <p className="text-xs" role="status">An unfinished receipt for this trial was found in this workspace. Freezing again recovers the same server draft.</p>}
        {!draft && <button type="button" className="btn btn-red" disabled={!pick || !!busy} onClick={() => void freeze()}>{busy ?? (pending ? "Recover the frozen draft" : "Freeze the draft")}</button>}
      </Panel>
      {draft && <Panel title="2 · Review exactly what you will sign">
        <ManifestReview m={draft.manifest} hash={draft.manifestHash} />
        <div className={cn("hair p-2 text-xs", keyReady ? "bg-sprout text-paper-light" : "bg-paper-deep")}>{keyReady ? "The unlocked key on this device matches the chosen identity." : <>Unlock the key with fingerprint <span className="font-mono">{idt?.key_hash.slice(0, 16)}…</span> on the <Link to="/identity" className="underline">PQ identity</Link> page, then return here. Your private key never leaves this browser.</>}</div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I reviewed this frozen record. I'm attesting that my registered identity reviewed this virtual, scheduled-rules experiment — not that the strategy is good, safe or profitable.</span></label>
        <button type="button" className="btn btn-red" disabled={!ack || !keyReady || !!busy} onClick={() => void sign()}>{busy ?? (pending?.signature ? "Resend my saved signature" : "Sign & save receipt")}</button>
      </Panel>}
      {err && <p role="alert" className="hair break-words bg-poppy-deep p-2 text-sm text-paper-light">{err}</p>}
      <TrialReport key={row.id} row={row} handles={{}} />
    </>}
  </div>;
}
