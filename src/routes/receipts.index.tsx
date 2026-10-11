import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel } from "@/components/pq/ui";
import { ReceiptFileVerifier } from "@/components/receipts/ReceiptChecks";
import { createFence } from "@/lib/greenhouse-session";
import { rrMine } from "@/lib/research.functions";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/receipts/")({
  head: () => ({ meta: [
    { title: "Research receipts — fleuri" },
    { name: "description", content: "Signed, replayable research receipts for Greenhouse trials, attested by a registered Fleuri post-quantum identity." },
    { property: "og:title", content: "Research receipts — fleuri" },
    { property: "og:description", content: "ML-DSA-65 signed records of virtual scheduled-rules experiments, verifiable offline." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Receipts,
});

export function ScopeNote() {
  return <div className="hair space-y-1 bg-paper-deep p-3 text-xs">
    <p className="font-semibold">What a research receipt is — and is not</p>
    <p>A <strong>human</strong> signs it with their registered Fleuri ML-DSA-65 identity over a saved Greenhouse trial: the frozen inputs, policy snapshots, settings, every intended decision and outcome trace, scorecards and the original checksums. The trial is a deterministic <strong>vSOL sandbox</strong> run of the scheduled rules engine, which uses archetype and risk only. Free-text strategy was recorded but not executed.</p>
    <p>It is not AI training, not a signature by the agent, not a safety or performance certification and not on-chain trading. An optional Solana Memo can record the receipt hash. Solana doesn't check ML-DSA signatures; that check happens off-chain.</p>
  </div>;
}

function Receipts() {
  const { userId, store } = useGarden();
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const fence = useRef(createFence()).current;
  useEffect(() => {
    const g = fence.bump(); setRows(null); setErr("");
    if (!userId) return;
    rrMine().then((r) => { if (!fence.guard(g)) return; if (r.ok) setRows(r.data); else setErr(r.error); }).catch((e) => fence.guard(g) && setErr((e as Error).message));
  }, [userId]);
  return <div className="space-y-4">
    <PageHeader title="research receipts" kicker="greenhouse · signed" />
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]"><p className="text-sm">Turn one of your saved Greenhouse trials into a portable record signed with your PQ identity. Anyone can check it offline and replay the original experiment exactly. Receipts are private until you publish them.</p><FlowerTiles count={8} cols={4} className="hidden sm:grid" start={2} /></div>
    <ScopeNote />
    {!userId ? <Panel title="Your workspace"><p className="text-sm">Open your workspace to create and manage receipts. Published receipts and the offline verifier work without one.</p><button type="button" className="btn btn-ink" disabled={busy} onClick={() => { setBusy(true); store.startSandbox().catch((e) => setErr((e as Error).message)).finally(() => setBusy(false)); }}>{busy ? "Opening…" : "Open workspace"}</button></Panel>
    : <Panel title="Your receipts">
      <p className="text-xs">To create one, open a completed trial in the <Link to="/greenhouse" className="underline">Greenhouse</Link> and choose “Create research receipt”. Signing needs a <Link to="/identity" className="underline">registered PQ identity</Link>; an on-chain identity anchor is optional.</p>
      {err ? <p role="alert" className="text-sm text-poppy-deep">Could not load your receipts: {err}</p> : rows == null ? <p className="text-sm">Loading…</p> : !rows.length ? <p className="text-sm">No receipts yet.</p> :
        <ul className="divide-y divide-ink/10 text-sm">{rows.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
          <span className="min-w-0 break-words"><span className={cn("hair mr-2 px-1 font-mono text-[0.65rem] uppercase", r.status === "signed" ? "bg-sprout text-paper-light" : "bg-paper-deep")}>{r.status}</span>{r.agents.map((h: string) => `@${h}`).join(", ")} · {new Date(r.created_at).toLocaleString()}{r.published ? " · published" : " · private"}{r.anchor_status !== "none" && ` · anchor ${r.anchor_status}`}</span>
          {r.status === "signed" ? <Link to="/receipts/$id" params={{ id: r.id }} className="btn btn-paper">Open</Link> : <Link to="/receipts/new" search={{ draft: r.id }} className="btn btn-paper">Continue signing</Link>}
        </li>)}</ul>}
    </Panel>}
    {err && rows != null && <p role="alert" className="text-sm text-poppy-deep">{err}</p>}
    <ReceiptFileVerifier key={userId ?? "guest"} />
  </div>;
}
