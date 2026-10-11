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
import { rrPrepare, rrResume, rrSign } from "@/lib/research.functions";
import { clearReceiptPending, clearReceiptSig, readReceiptPending, readReceiptSig, writeReceiptPending, writeReceiptSig, type ReceiptPending, type ReceiptSig } from "@/lib/receipt-session";
import { loadLocal, usePqLocal, withSecret } from "@/pq/local";
import { parseReceiptManifest, receiptHash, signReceipt, type ReceiptManifestT } from "@/pq/receipt";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/receipts/new")({
  validateSearch: z.object({ run: z.string().uuid().optional(), draft: z.string().uuid().optional() }),
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
  const { run: runParam, draft: draftParam } = Route.useSearch();
  const navigate = useNavigate();
  const { userId, store } = useGarden();
  const local = usePqLocal();
  const fence = useRef(createFence()).current;
  const [runId, setRunId] = useState<string | undefined>(runParam);
  const [row, setRow] = useState<TrialRow | null>(null); const [ids, setIds] = useState<any[] | null>(null); const [idErr, setIdErr] = useState("");
  const [pick, setPick] = useState(""); const [draft, setDraft] = useState<{ id: string; manifest: ReceiptManifestT; manifestHash: string } | null>(null);
  const [pending, setPending] = useState<ReceiptPending | null>(null); const [saved, setSaved] = useState<ReceiptSig | null>(null);
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState("");
  const [reloadN, setReloadN] = useState(0);

  useEffect(() => { loadLocal(); }, []);
  // Owner/run/draft change: clear every private draft/signature/pending view and fence late responses.
  useEffect(() => {
    const g = fence.bump();
    setRow(null); setIds(null); setIdErr(""); setPick(""); setDraft(null); setAck(false); setErr(""); setBusy(null); setSaved(null); setPending(null); setRunId(runParam);
    if (!userId || (!runParam && !draftParam)) return;
    (async () => {
      let rid = runParam;
      if (draftParam) { // exact server draft recovery: works with no local storage, on any device
        const d = await rrResume({ data: { id: draftParam } });
        if (!fence.guard(g)) return;
        if (!d.ok) return setErr(d.error);
        if (d.data.status === "signed") { void navigate({ to: "/receipts/$id", params: { id: d.data.id } }); return; }
        if (receiptHash(d.data.manifest) !== d.data.manifestHash || d.data.manifest.source.runId !== d.data.runId) return setErr("The stored draft does not match its hash or trial.");
        rid = d.data.runId; setRunId(rid);
        const p: ReceiptPending = { requestId: d.data.requestId, runId: rid, identityId: d.data.identityId, receiptId: d.data.id, manifestHash: d.data.manifestHash };
        writeReceiptPending(userId, p, localStorage); setPending(p); setPick(p.identityId);
        setDraft({ id: d.data.id, manifest: d.data.manifest, manifestHash: d.data.manifestHash });
        setSaved(readReceiptSig(userId, d.data.id, d.data.manifestHash, localStorage) ?? legacySig(readReceiptPending(userId, rid, localStorage), d.data.id, d.data.manifestHash));
      } else {
        const p = readReceiptPending(userId, rid!, localStorage); setPending(p); if (p) setPick(p.identityId);
      }
      const [r, m] = await Promise.all([ghRun({ data: { id: rid! } }), pqMine()]);
      if (!fence.guard(g)) return;
      if (!r.ok) return setErr(r.error);
      if (!(r.data as any).mine) return setErr("Only your own saved trials can be attested from your account.");
      setRow(r.data as TrialRow);
      if (m.ok) setIds(m.data.identities.filter((i: any) => i.status !== "revoked")); else setIdErr(m.error);
    })().catch((e) => fence.guard(g) && setErr((e as Error).message));
  }, [userId, runParam, draftParam, reloadN]);

  async function freeze() {
    if (!userId || !runId || !pick) return;
    const g = fence.current(); setBusy("Freezing the draft on the server…"); setErr("");
    try {
      const p: ReceiptPending = pending && pending.identityId === pick ? { requestId: pending.requestId, runId, identityId: pick } : { requestId: crypto.randomUUID(), runId, identityId: pick };
      writeReceiptPending(userId, p, localStorage); setPending(p); // saved before the request: reloads recover the same draft
      const r = await rrPrepare({ data: { requestId: p.requestId, runId, identityId: pick } });
      if (!fence.guard(g)) return;
      if (!r.ok) throw new Error(r.error);
      if (r.data.status === "signed") { clearReceiptPending(userId, runId, localStorage); toast.success("This receipt was already signed."); void navigate({ to: "/receipts/$id", params: { id: r.data.id } }); return; }
      if (receiptHash(parseReceiptManifest(r.data.manifest)) !== r.data.manifestHash) throw new Error("The server draft does not match its hash.");
      const next = { ...p, receiptId: r.data.id, manifestHash: r.data.manifestHash }; writeReceiptPending(userId, next, localStorage); setPending(next);
      setDraft({ id: r.data.id, manifest: r.data.manifest, manifestHash: r.data.manifestHash }); setAck(false);
      setSaved(readReceiptSig(userId, r.data.id, r.data.manifestHash, localStorage));
    } catch (e) { if (fence.guard(g)) setErr((e as Error).message); } finally { if (fence.guard(g)) setBusy(null); }
  }
  async function sign() {
    const d = draft, owner = userId;
    if (!owner || !runId || !d || !pending) return;
    // Re-check at the moment of the click: explicit acknowledgement, the matching unlocked key and scope.
    if (!ack) { setErr("Confirm you reviewed the frozen record first."); return; }
    const chosen = ids?.find((i) => i.id === pick);
    if (!chosen || chosen.id !== pending.identityId || chosen.key_hash !== d.manifest.issuer.keyHash) { setErr("The chosen identity is not the one this draft names."); return; }
    if (pending.receiptId !== d.id || pending.manifestHash !== d.manifestHash) { setErr("This draft no longer matches the recovery record. Reload the page."); return; }
    const g = fence.current(); setBusy("Signing with ML-DSA-65…"); setErr("");
    try {
      let sig = saved && saved.receiptId === d.id && saved.manifestHash === d.manifestHash ? { publicKey: saved.publicKey, signature: saved.signature } : null;
      if (!sig) {
        if (!local.unlocked || local.envelope?.keyHash !== d.manifest.issuer.keyHash) throw new Error("Unlock the key named in this draft first.");
        const s = withSecret((kp) => signReceipt(d.manifest, kp)); // the secret never leaves this call; also checks the key hash
        if (!fence.guard(g)) return;
        sig = { publicKey: s.publicKey, signature: s.signature };
        const v = { receiptId: d.id, manifestHash: d.manifestHash, ...sig }; writeReceiptSig(owner, v, localStorage); setSaved(v); // resend these exact bytes after a lost response
      }
      setBusy("Server is verifying the signature…");
      const r = await rrSign({ data: { id: d.id, ...sig } });
      if (!fence.guard(g)) return;
      if (!r.ok) throw new Error(r.error);
      clearReceiptPending(owner, runId, localStorage); clearReceiptSig(owner, d.id, localStorage);
      toast.success(r.data.recovered ? "Recovered your signed receipt" : "Receipt signed and saved (private)");
      void navigate({ to: "/receipts/$id", params: { id: d.id } });
    } catch (e) { if (fence.guard(g)) setErr((e as Error).message); } finally { if (fence.guard(g)) setBusy(null); }
  }

  const idt = ids?.find((i) => i.id === pick);
  const keyReady = !!idt && (!!saved || (local.unlocked && local.envelope?.keyHash === idt.key_hash && (!draft || draft.manifest.issuer.keyHash === idt.key_hash)));
  const supported = row ? SUPPORTED_ENGINES.includes(row.input.engineVersion as any) : false;
  return <div className="space-y-4">
    <PageHeader title="new receipt" kicker="research receipts" />
    <ScopeNote />
    {!runId && !draftParam ? <Panel title="Choose a trial"><p className="text-sm">Open a completed trial in the <Link to="/greenhouse" className="underline">Greenhouse</Link> and choose “Create research receipt”.</p></Panel>
    : !userId ? <Panel title="Your workspace"><p className="text-sm">Open your workspace to attest your own trials.</p><button type="button" className="btn btn-ink" disabled={!!busy} onClick={() => { setBusy("Opening…"); store.startSandbox().catch((e) => setErr((e as Error).message)).finally(() => setBusy(null)); }}>{busy ?? "Open workspace"}</button></Panel>
    : err && !row ? <p role="alert" className="hair bg-poppy-deep p-2 text-sm text-paper-light">{err}</p>
    : !row ? <ListSkeleton />
    : idErr ? <Panel title="Identities unavailable"><p role="alert" className="text-sm text-poppy-deep">Could not load your PQ identities: {idErr}</p><button type="button" className="btn btn-paper" onClick={() => setReloadN((n) => n + 1)}>Try again</button></Panel>
    : !ids ? <ListSkeleton />
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
        <div className={cn("hair p-2 text-xs", keyReady ? "bg-sprout text-paper-light" : "bg-paper-deep")}>{keyReady ? (saved ? "A signature for this exact draft is saved on this device; it will be resent unchanged." : "The unlocked key on this device matches the chosen identity.") : <>Unlock the key with fingerprint <span className="font-mono">{idt?.key_hash.slice(0, 16)}…</span> on the <Link to="/identity" className="underline">PQ identity</Link> page, then return here. Your private key never leaves this browser.</>}</div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I reviewed this frozen record. I'm attesting that my registered identity reviewed this virtual, scheduled-rules experiment — not that the strategy is good, safe or profitable.</span></label>
        <button type="button" className="btn btn-red" disabled={!ack || !keyReady || !!busy} onClick={() => void sign()}>{busy ?? (saved ? "Resend my saved signature" : "Sign & save receipt")}</button>
      </Panel>}
      {err && <p role="alert" className="hair break-words bg-poppy-deep p-2 text-sm text-paper-light">{err}</p>}
      <TrialReport key={row.id} row={row} handles={{}} />
    </>}
  </div>;
}

/** Older pending records stored the signature beside the run; reuse only for the exact same draft. */
function legacySig(p: ReceiptPending | null, id: string, hash: string): ReceiptSig | null {
  return p && p.receiptId === id && p.manifestHash === hash && p.publicKey && p.signature ? { receiptId: id, manifestHash: hash, publicKey: p.publicKey, signature: p.signature } : null;
}
