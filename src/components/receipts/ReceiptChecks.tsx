import { useState } from "react";
import { Panel } from "@/components/pq/ui";
import { verifyAnchor, verifyReceiptBundle, type RCheck, type ReceiptVerification } from "@/pq/receipt";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = { pass: "bg-sprout text-paper-light", fail: "bg-poppy-deep text-paper-light", unavailable: "bg-paper-deep", unsupported: "bg-paper-deep" };
export function ChecksList({ checks }: { checks: RCheck[] }) {
  return <ul className="space-y-1" aria-label="Receipt checks">{checks.map((c) => (
    <li key={c.id} className="hair grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 bg-paper p-2 text-xs">
      <span className={cn("hair self-start px-1 text-center font-mono text-[0.65rem] uppercase", TONE[c.status])}>{c.status}</span>
      <span className="min-w-0 break-words"><strong>{c.label}</strong> — {c.detail}</span>
    </li>))}</ul>;
}

/** Optional, caller-chosen RPC check of an exported anchor hint. Never trusts the hint itself. */
export function AnchorRpcCheck({ v }: { v: ReceiptVerification }) {
  const [rpc, setRpc] = useState(v.manifest?.cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
  const [res, setRes] = useState<RCheck | null>(null); const [busy, setBusy] = useState(false);
  if (!v.manifest || !v.bundle?.anchorHint) return null;
  async function run() {
    setBusy(true); setRes(null);
    try {
      const { Buffer } = await import("buffer"); (globalThis as any).Buffer ??= Buffer;
      const [{ rpcConnection }, { readConfirmedTxEx }] = await Promise.all([import("@/pq/evidence-reader"), import("@/pq/chain-read")]);
      const conn = rpcConnection(rpc);
      setRes(await verifyAnchor(v.manifest!, v.bundle!.manifestHash, v.bundle!.anchorHint, { genesis: () => conn.getGenesisHash(), tx: (s) => readConfirmedTxEx(conn, s) as any }));
    } catch (e) { setRes({ id: "anchor", label: "Optional Memo anchor", status: "unavailable", detail: (e as Error).message.slice(0, 200) }); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    <label className="block text-xs font-semibold">Check the anchor hint with an RPC you choose (https)<input value={rpc} onChange={(e) => { setRpc(e.target.value); setRes(null); }} className="field mt-1 w-full font-mono text-xs" /></label>
    <button type="button" className="btn btn-paper" disabled={busy} onClick={() => void run()}>{busy ? "Reading chain…" : "Check anchor on chain"}</button>
    {res && <ChecksList checks={[res]} />}
  </div>;
}

export function ReceiptFileVerifier() {
  const [v, setV] = useState<ReceiptVerification | null>(null); const [busy, setBusy] = useState(false);
  return <Panel title="Verify a receipt file offline">
    <p className="text-xs">Runs entirely in your browser: strict parsing, commitments, identity binding, the ML-DSA-65 receipt signature and an exact Greenhouse replay. No Fleuri database is used. CLI: <span className="font-mono">bun scripts/verify-receipt.ts receipt.json [--rpc URL]</span></p>
    <input type="file" accept="application/json,.json" aria-label="Research receipt file" onChange={async (e) => {
      const f = e.target.files?.[0]; if (!f) return; setBusy(true); setV(null);
      try { await new Promise((r) => setTimeout(r, 20)); setV(f.size > 2_600_000 ? verifyReceiptBundle("x".repeat(2_600_001)) : verifyReceiptBundle(await f.text())); } finally { setBusy(false); }
    }} />
    {busy && <p className="text-sm" role="status">Verifying and replaying…</p>}
    {v && <><p role="status" className={cn("hair p-2 text-sm font-semibold", v.valid ? "bg-sprout text-paper-light" : "bg-poppy-deep text-paper-light")}>{v.valid ? "Valid signed research receipt." : "Not a valid receipt."} Signature validity shows which key attested these bytes; it does not make the strategy good.</p><ChecksList checks={v.checks} /><AnchorRpcCheck v={v} /></>}
  </Panel>;
}
