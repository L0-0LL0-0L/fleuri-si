import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ListSkeleton, PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { CopyLink } from "@/components/bits";
import { Panel, PendingTransactions, RealBadge, WalletButtons, downloadBlob, explorerTx, signSubmitConfirm, useWallets, type PendingPreparation } from "@/components/pq/ui";
import { TrialReport, type TrialRow } from "@/components/greenhouse/TrialReport";
import { AnchorRpcCheck, ChecksList } from "@/components/receipts/ReceiptChecks";
import { ManifestReview } from "@/components/receipts/ManifestReview";
import { ScopeNote } from "./receipts.index";
import { createFence } from "@/lib/greenhouse-session";
import { pqMine } from "@/lib/pq.functions";
import { rrGet, rrPrepareAnchor, rrPublic, rrPublish } from "@/lib/research.functions";
import { isLegacyManifest, verifyReceiptBundle } from "@/pq/receipt";
import { reviewAnchorPrep, type AnchorPrep } from "@/pq/anchor-review";
import { useLiveScope } from "@/lib/live-scope";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";
import type { WalletKind } from "@/services/wallet";

export const Route = createFileRoute("/receipts/$id")({
  head: () => ({ meta: [
    { title: "Research receipt — fleuri" },
    { name: "description", content: "A signed, replayable research receipt for a Greenhouse trial, verifiable offline." },
    { property: "og:title", content: "Research receipt — fleuri" },
    { property: "og:description", content: "ML-DSA-65 signed record of a virtual scheduled-rules experiment." },
    { property: "og:type", content: "article" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: ReceiptPage,
});

// Each load is bound to the owner + receipt + generation captured when it (or its reload callback)
// was created. Results are stored with that scope key and rendered only while it is still current,
// so a stale reload can never paint receipt A under owner B / receipt B, even before effects run.
type Loaded = { key: string; g: number; row: any } | { key: string; g: number; err: string };
export function ReceiptPage() {
  const { id } = Route.useParams();
  const { userId } = useGarden();
  const key = `${userId ?? "guest"}|${id}`;
  const [data, setData] = useState<Loaded | null>(null);
  const fence = useRef(createFence()).current;
  useEffect(() => () => { fence.bump(); }, []);
  async function load(rid: string, uid: string | null, k: string, g: number) {
    if (!fence.guard(g)) return;
    try {
      const own = uid ? await rrGet({ data: { id: rid } }) : null;
      if (!fence.guard(g)) return;
      const r = own?.ok ? own : await rrPublic({ data: { id: rid } });
      if (!fence.guard(g)) return;
      setData(r.ok ? { key: k, g, row: r.data } : { key: k, g, err: r.error });
    } catch (e) { if (fence.guard(g)) setData({ key: k, g, err: (e as Error).message }); }
  }
  // id or session change: never show the previous receipt/owner while the new one loads.
  useEffect(() => {
    const g = fence.bump();
    if (!/^[0-9a-f-]{36}$/i.test(id)) { setData({ key, g, err: "That is not a receipt id." }); return; }
    void load(id, userId, key, g);
  }, [id, userId]);
  const cur = data && data.key === key ? data : null;
  const err = cur && "err" in cur ? cur.err : "";
  const row = cur && "row" in cur ? cur.row : null;
  return <div className="space-y-4">
    <PageHeader title="research receipt" kicker="signed · greenhouse" />
    <FlowerTiles count={8} cols={8} start={4} />
    {err ? <EmptyState title="receipt unavailable" body={err} action={<Link to="/receipts" className="btn btn-paper">All receipts</Link>} /> : !row ? <ListSkeleton /> : <ReceiptDetail key={key} row={row} owner={userId} reload={() => load(id, userId, cur!.key, cur!.g)} />}
  </div>;
}

function ReceiptDetail({ row, reload, owner }: { row: any; reload: () => Promise<void>; owner: string | null }) {
  const wallets = useWallets();
  const { store } = useGarden(); const ownerLive = () => store.get().userId === owner; // the store can change before props
  const v = useMemo(() => (row.bundle ? verifyReceiptBundle(JSON.parse(JSON.stringify(row.bundle)), { domain: row.manifest.domain }) : null), [row]);
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState("");
  const [reviewPub, setReviewPub] = useState(false); const [anchor, setAnchor] = useState<AnchorPrep | null>(null);
  const [preps, setPreps] = useState<PendingPreparation[]>([]); const [prepErr, setPrepErr] = useState("");
  // Async results are bound to owner + receipt + this mount. Deliberate prepared-state changes (a new
  // preparation, a successful anchor) do not invalidate the operation that made them; the wallet
  // guard separately checks that the reviewed preparation is still the one on screen.
  const scope = useLiveScope(`${owner ?? "guest"}|${row.id}`);
  const anchorRef = useRef<AnchorPrep | null>(null); anchorRef.current = anchor;
  const opRef = useRef(0);
  const walletCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => walletCtrl.current?.abort(), []);
  const review = useMemo(() => anchor ? reviewAnchorPrep(anchor, { wallet: row.manifest.issuer.wallet, cluster: row.manifest.cluster, genesisHash: row.manifest.genesisHash, manifestHash: row.manifest_hash }) : null, [anchor, row]);
  const trial: TrialRow = { id: row.manifest.source.runId, status: "done", engine_version: row.experiment.input.engineVersion, agent_ids: row.experiment.input.config.agentIds, input: row.experiment.input, output: row.experiment.output, input_hash: row.experiment.inputHash, output_hash: row.experiment.outputHash, content_hash: row.experiment.contentHash, published: false, created_at: row.experiment.createdAt, finished_at: null, error: null };
  async function loadPreps() {
    if (!row.mine || !ownerLive()) return; const t = scope.token();
    const m = await pqMine().catch((e) => ({ ok: false as const, error: (e as Error).message }));
    if (!scope.live(t) || !ownerLive()) return;
    if (m.ok) { setPreps(m.data.preparations.filter((p: any) => p.kind === "receipt_anchor" && p.subject === row.id)); setPrepErr(""); } else setPrepErr(m.error);
  }
  useEffect(() => { void loadPreps(); }, [row.id]);
  async function act(label: string, fn: (live: () => boolean) => Promise<void>) {
    const t = scope.token(); const op = ++opRef.current; const live = () => scope.live(t) && ownerLive();
    if (!live()) return;
    setBusy(label); setMsg("");
    // Only the owning (latest) operation clears busy; an older completion never clears a newer one.
    try { await fn(live); } catch (e) { if (live() && opRef.current === op) setMsg((e as Error).message); } finally { if (live() && opRef.current === op) setBusy(null); }
  }
  const publish = (p: boolean) => act(p ? "Publishing…" : "Making private…", async (live) => { const r = await rrPublish({ data: { id: row.id, published: p } }); if (!live()) return; if (!r.ok) throw new Error(r.error); setReviewPub(false); toast.success(p ? "Receipt published" : "Receipt is private again"); await reload(); });
  const prepare = () => act("Preparing the exact Memo transaction…", async (live) => { const r = await rrPrepareAnchor({ data: { id: row.id } }); if (!live()) return; if (!r.ok) throw new Error(r.error); setAnchor(r.data as AnchorPrep); });
  const sign = (k: WalletKind) => {
    if (!anchor || !review?.ok) return;
    const prep = anchor; const scopeKey = scope.token();
    walletCtrl.current?.abort(); const ctrl = new AbortController(); walletCtrl.current = ctrl;
    return act("Preparing…", async (live) => {
      const r = await signSubmitConfirm(k, prep, { onStatus: (s) => live() && setBusy(s), guard: () => scope.live(scopeKey) && ownerLive() && !ctrl.signal.aborted && anchorRef.current?.preparationId === prep.preparationId && Date.parse(prep.expiresAt) > Date.now(), signal: ctrl.signal });
      if (!live() || ctrl.signal.aborted || anchorRef.current?.preparationId !== prep.preparationId) return; // cancelled or replaced
      setAnchor(null); toast.success(r.detail); await reload(); await loadPreps();
    });
  };
  const lamports = (n?: number) => (n == null ? "unknown" : `${(n / 1e9).toFixed(6)} SOL`);
  const recorded = row.anchor_status === "confirmed";
  return <div className="space-y-4">
    <Panel title="Verification">
      {v ? <><p role="status" className={cn("hair p-2 text-sm font-semibold", v.valid ? "bg-sprout text-paper-light" : "bg-poppy-deep text-paper-light")}>{v.valid ? "Valid signed research receipt." : "This receipt does not verify."} Checked in your browser from the exported bundle, without using the database.</p><ChecksList checks={v.checks} /></> : <p className="text-sm">This receipt is not signed yet.</p>}
      <div className="flex flex-wrap gap-2">
        {row.bundle && <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(row.bundle, null, 1)], { type: "application/json" }), `fleuri-receipt-${row.manifest_hash.slice(0, 12)}.json`)}>Download receipt bundle</button>}
        {row.published && <CopyLink path={`/receipts/${row.id}`} label="Copy public link" />}
      </div>
    </Panel>
    {row.mine && <Panel title="Sharing · private by default">
      <p className="text-xs">{row.published ? "Published: anyone with the link can read the signed receipt and its experiment." : "Private: only your workspace can see this receipt."}</p>
      {row.published ? <button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => void publish(false)}>Make private</button>
      : !reviewPub ? <button type="button" className="btn btn-red" disabled={!!busy || !v?.valid} onClick={() => setReviewPub(true)}>Review & publish</button>
      : <div className="hair space-y-2 bg-paper-deep p-2 text-xs"><p className="font-semibold">Publishing discloses:</p><ul className="list-disc pl-4"><li>the full experiment — frozen market, policy snapshots (including free-text strategy and persona), every trace and scorecard;</li><li>your signer proof — wallet {row.manifest.issuer.wallet}, ML-DSA public key and the dual-signed registration statement (which includes your workspace id);</li>{isLegacyManifest(row.manifest) && <li><strong>this legacy v1 receipt also contains its private request identifier</strong> inside the signed manifest; it cannot be removed without breaking the signature. New receipts omit it.</li>}<li>the receipt signature and any recorded anchor.</li></ul><div className="flex flex-wrap gap-2"><button type="button" className="btn btn-red" disabled={!!busy} onClick={() => void publish(true)}>{busy ?? "Publish receipt"}</button><button type="button" className="btn btn-paper" onClick={() => setReviewPub(false)}>Cancel</button></div></div>}
    </Panel>}
    <Panel title="Optional Solana Memo anchor">
      <div className="flex flex-wrap items-center gap-2 text-xs"><RealBadge cluster={row.manifest.cluster} /><span className={cn("hair px-1 font-mono uppercase", row.anchor_status === "failed" ? "bg-poppy-deep text-paper-light" : "bg-paper-deep")}>{row.anchor_status === "none" ? "not anchored" : `recorded: ${row.anchor_status}`}</span></div>
      {recorded && row.anchor_signature && <p className="text-xs">fleuri recorded a confirmed Memo (slot {row.anchor_slot}). This is stored metadata — <a className="underline" href={explorerTx(row.anchor_signature, row.manifest.cluster)} target="_blank" rel="noreferrer">view the transaction</a> or re-read it below; only a passing chain re-read is verification.</p>}
      {v && <AnchorRpcCheck key={`${row.id}|${row.anchor_signature ?? ""}`} v={v} />}
      <p className="text-xs text-ink-soft">The Memo puts this receipt's hash on chain, signed by the issuer wallet. Solana records the hash; it does not verify the ML-DSA signature, and offline verification never depends on the anchor. It costs a small network fee in real SOL.</p>
      {row.mine && row.status === "signed" && (row.anchor_status === "none" || row.anchor_status === "failed" || row.anchor_status === "pending") && (!anchor
        ? <button type="button" className="btn btn-paper" disabled={!!busy || preps.length > 0} onClick={() => void prepare()}>{busy ?? (row.anchor_status === "failed" ? "Prepare a new anchor" : "Prepare anchor")}</button>
        : <div className="hair space-y-1 bg-paper-light p-2 text-xs" data-testid="anchor-review"><p className="font-semibold">Review the exact transaction before your wallet signs</p>
          <p className="break-all">Memo in the bytes: <span className="font-mono">{review?.memo ?? "unreadable"}</span></p>
          <p className="break-all">Fee payer / only signer: <span className="font-mono">{review?.feePayer ?? "unknown"}</span> · network {anchor.cluster} · genesis {anchor.genesisHash ? `${anchor.genesisHash.slice(0, 8)}…` : "unconfirmed"}{anchor.reused ? " · reusing your earlier unsigned preparation" : ""}</p>
          <p>{anchor.cost?.ok ? `Simulated: wallet spends ${lamports(anchor.cost.simulatedChangeLamports)} (network fee ${lamports(anchor.cost.networkFeeLamports)}) of ${lamports(anchor.cost.balanceLamports)}.` : `Simulation unavailable: ${anchor.cost?.error ?? "unknown"}`}</p>
          <p>Expires {new Date(anchor.expiresAt).toLocaleTimeString()}. Nothing is sent until you approve in your wallet.</p>
          {review && !review.ok && <ul role="alert" className="list-disc pl-4 text-poppy-deep">{review.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <WalletButtons avail={wallets} busy={busy} disabled={!review?.ok} action="Anchor with" onPick={(k) => void sign(k)} />
          <button type="button" className="btn btn-paper" onClick={() => { walletCtrl.current?.abort(); opRef.current++; setBusy(null); setAnchor(null); }}>Cancel</button></div>)}
      {msg && <p role="alert" className="break-words text-sm text-poppy-deep">{msg}</p>}
    </Panel>
    {row.mine && prepErr && <p role="alert" className="text-sm text-poppy-deep">Could not load pending transactions: {prepErr}</p>}
    {row.mine && <PendingTransactions rows={preps} onRefresh={async () => { const t = scope.token(); if (!scope.live(t) || !ownerLive()) return; await reload(); if (scope.live(t)) await loadPreps(); }} />}
    <ScopeNote />
    <Panel title="Signed manifest"><ManifestReview m={row.manifest} hash={row.manifest_hash} /></Panel>
    <TrialReport key={trial.id} row={trial} handles={{}} receiptView />
  </div>;
}
