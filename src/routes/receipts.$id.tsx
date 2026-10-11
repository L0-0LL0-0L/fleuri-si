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
import { verifyReceiptBundle } from "@/pq/receipt";
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

function ReceiptPage() {
  const { id } = Route.useParams();
  const { userId } = useGarden();
  const [row, setRow] = useState<any>(null); const [err, setErr] = useState("");
  const fence = useRef(createFence()).current;
  async function load(g = fence.current()) {
    const own = userId ? await rrGet({ data: { id } }) : null;
    const r = own?.ok ? own : await rrPublic({ data: { id } });
    if (!fence.guard(g)) return;
    if (!r.ok) { setErr(r.error); return; }
    setRow(r.data);
  }
  // id or session change: never show the previous receipt/owner while the new one loads.
  useEffect(() => { const g = fence.bump(); setRow(null); setErr(""); if (!/^[0-9a-f-]{36}$/i.test(id)) { setErr("That is not a receipt id."); return; } load(g).catch((e) => fence.guard(g) && setErr((e as Error).message)); }, [id, userId]);
  return <div className="space-y-4">
    <PageHeader title="research receipt" kicker="signed · greenhouse" />
    <FlowerTiles count={8} cols={8} start={4} />
    {err ? <EmptyState title="receipt unavailable" body={err} action={<Link to="/receipts" className="btn btn-paper">All receipts</Link>} /> : !row ? <ListSkeleton /> : <ReceiptDetail key={row.id} row={row} reload={() => load()} />}
  </div>;
}

function ReceiptDetail({ row, reload }: { row: any; reload: () => Promise<void> }) {
  const wallets = useWallets();
  const v = useMemo(() => (row.bundle ? verifyReceiptBundle(JSON.parse(JSON.stringify(row.bundle)), { domain: row.manifest.domain }) : null), [row]);
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState("");
  const [reviewPub, setReviewPub] = useState(false); const [anchor, setAnchor] = useState<any>(null);
  const [preps, setPreps] = useState<PendingPreparation[]>([]);
  const trial: TrialRow = { id: row.manifest.source.runId, status: "done", engine_version: row.experiment.input.engineVersion, agent_ids: row.experiment.input.config.agentIds, input: row.experiment.input, output: row.experiment.output, input_hash: row.experiment.inputHash, output_hash: row.experiment.outputHash, content_hash: row.experiment.contentHash, published: false, created_at: row.experiment.createdAt, finished_at: null, error: null };
  async function loadPreps() { if (!row.mine) return; const m = await pqMine(); if (m.ok) setPreps(m.data.preparations.filter((p: any) => p.kind === "receipt_anchor" && p.subject === row.id)); }
  useEffect(() => { void loadPreps(); }, [row.id]);
  async function act(label: string, fn: () => Promise<void>) { setBusy(label); setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); } }
  const publish = (p: boolean) => act(p ? "Publishing…" : "Making private…", async () => { const r = await rrPublish({ data: { id: row.id, published: p } }); if (!r.ok) throw new Error(r.error); setReviewPub(false); toast.success(p ? "Receipt published" : "Receipt is private again"); await reload(); });
  const prepare = () => act("Preparing the exact Memo transaction…", async () => { const r = await rrPrepareAnchor({ data: { id: row.id } }); if (!r.ok) throw new Error(r.error); setAnchor(r.data); });
  const sign = (k: WalletKind) => act("Preparing…", async () => { const r = await signSubmitConfirm(k, anchor, { onStatus: setBusy }); setAnchor(null); toast.success(r.detail); await reload(); await loadPreps(); });
  const lamports = (n?: number) => (n == null ? "unknown" : `${(n / 1e9).toFixed(6)} SOL`);
  return <div className="space-y-4">
    <Panel title="Verification">
      {v ? <><p role="status" className={cn("hair p-2 text-sm font-semibold", v.valid ? "bg-sprout text-paper-light" : "bg-poppy-deep text-paper-light")}>{v.valid ? "Valid signed research receipt." : "This receipt does not verify."} Checked in your browser from the exported bundle, without using the database.</p><ChecksList checks={v.checks} /></> : <p className="text-sm">This receipt is not signed yet.</p>}
      <div className="flex flex-wrap gap-2">
        {row.bundle && <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(row.bundle, null, 1)], { type: "application/json" }), `fleuri-receipt-${row.manifest_hash.slice(0, 12)}.json`)}>Download receipt bundle</button>}
        {row.published && <CopyLink path={`/receipts/${row.id}`} label="Copy public link" />}
      </div>
      {v && <AnchorRpcCheck v={v} />}
    </Panel>
    {row.mine && <Panel title="Sharing · private by default">
      <p className="text-xs">{row.published ? "Published: anyone with the link can read the signed receipt and its experiment." : "Private: only your workspace can see this receipt."}</p>
      {row.published ? <button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => void publish(false)}>Make private</button>
      : !reviewPub ? <button type="button" className="btn btn-red" disabled={!!busy || !v?.valid} onClick={() => setReviewPub(true)}>Review & publish</button>
      : <div className="hair space-y-2 bg-paper-deep p-2 text-xs"><p className="font-semibold">Publishing discloses:</p><ul className="list-disc pl-4"><li>the full experiment — frozen market, policy snapshots (including free-text strategy and persona), every trace and scorecard;</li><li>your signer proof — wallet {row.manifest.issuer.wallet}, ML-DSA public key and the dual-signed registration statement (which includes your workspace id);</li><li>the receipt signature and any anchor.</li></ul><div className="flex flex-wrap gap-2"><button type="button" className="btn btn-red" disabled={!!busy} onClick={() => void publish(true)}>{busy ?? "Publish receipt"}</button><button type="button" className="btn btn-paper" onClick={() => setReviewPub(false)}>Cancel</button></div></div>}
    </Panel>}
    <Panel title="Optional Solana Memo anchor">
      <div className="flex flex-wrap items-center gap-2 text-xs"><RealBadge cluster={row.manifest.cluster} /><span className={cn("hair px-1 font-mono uppercase", row.anchor_status === "confirmed" ? "bg-sprout text-paper-light" : row.anchor_status === "failed" ? "bg-poppy-deep text-paper-light" : "bg-paper-deep")}>{row.anchor_status === "none" ? "not anchored" : row.anchor_status}</span></div>
      {row.anchor_status === "confirmed" && row.anchor_signature && <a className="block break-all text-xs underline" href={explorerTx(row.anchor_signature, row.manifest.cluster)} target="_blank" rel="noreferrer">Confirmed Memo transaction (slot {row.anchor_slot})</a>}
      <p className="text-xs text-ink-soft">The Memo puts this receipt's hash on chain, signed by the issuer wallet. Solana records the hash; it does not verify the ML-DSA signature, and offline verification never depends on the anchor. It costs a small network fee in real SOL.</p>
      {row.mine && row.status === "signed" && (row.anchor_status === "none" || row.anchor_status === "failed" || row.anchor_status === "pending") && (!anchor
        ? <button type="button" className="btn btn-paper" disabled={!!busy || preps.length > 0} onClick={() => void prepare()}>{busy ?? (row.anchor_status === "failed" ? "Prepare a new anchor" : "Prepare anchor")}</button>
        : <div className="hair space-y-1 bg-paper-light p-2 text-xs"><p className="font-semibold">Review before your wallet signs</p><p className="break-all">Memo: <span className="font-mono">{anchor.memo}</span></p><p>Network: {anchor.cluster} · wallet <span className="font-mono">{anchor.wallet}</span></p><p>{anchor.cost?.ok ? `Simulated: wallet spends ${lamports(anchor.cost.simulatedChangeLamports)} (network fee ${lamports(anchor.cost.networkFeeLamports)}).` : `Simulation unavailable: ${anchor.cost?.error ?? "unknown"}`}</p><p>Expires {new Date(anchor.expiresAt).toLocaleTimeString()}. Nothing is sent until you approve in your wallet.</p><WalletButtons avail={wallets} busy={busy} action="Anchor with" onPick={(k) => void sign(k)} /><button type="button" className="btn btn-paper" onClick={() => setAnchor(null)}>Cancel</button></div>)}
      {msg && <p role="alert" className="break-words text-sm text-poppy-deep">{msg}</p>}
    </Panel>
    {row.mine && <PendingTransactions rows={preps} onRefresh={async () => { await reload(); await loadPreps(); }} />}
    <ScopeNote />
    <Panel title="Signed manifest"><ManifestReview m={row.manifest} hash={row.manifest_hash} /></Panel>
    <TrialReport key={trial.id} row={trial} handles={{}} receiptView />
  </div>;
}
