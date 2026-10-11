import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/pq/ui";
import { RECEIPT_MAX_BYTES, verifyAnchor, verifyReceiptBundle, type RCheck, type ReceiptVerification } from "@/pq/receipt";
import { memoReader } from "@/pq/memo-reader";
import { useLiveScope } from "@/lib/live-scope";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = { pass: "bg-sprout text-paper-light", fail: "bg-poppy-deep text-paper-light", unavailable: "bg-paper-deep", unsupported: "bg-paper-deep" };
export function ChecksList({ checks }: { checks: RCheck[] }) {
  return <ul className="space-y-1" aria-label="Receipt checks">{checks.map((c) => (
    <li key={c.id} className="hair grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 bg-paper p-2 text-xs">
      <span className={cn("hair self-start px-1 text-center font-mono text-[0.65rem] uppercase", TONE[c.status])}>{c.status}</span>
      <span className="min-w-0 break-words"><strong>{c.label}</strong> — {c.detail}</span>
    </li>))}</ul>;
}

/** Optional, caller-chosen RPC check of an exported anchor hint. Never trusts the hint itself. Results are
 * bound to (receipt, signature, RPC, operation) so an old pass can never appear for a new file or URL. */
export function AnchorRpcCheck({ v }: { v: ReceiptVerification }) {
  const [rpc, setRpc] = useState(v.manifest?.cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
  const [res, setRes] = useState<{ key: string; check: RCheck } | null>(null); const [busy, setBusy] = useState(false);
  const base = `${v.bundle?.manifestHash ?? ""}|${v.bundle?.anchorHint?.signature ?? ""}|${rpc}`;
  const scope = useLiveScope(base);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => { ctrl.current?.abort(); setBusy(false); }, [base]);
  if (!v.manifest || !v.bundle?.anchorHint) return null;
  async function run() {
    ctrl.current?.abort(); const c = new AbortController(); ctrl.current = c;
    scope.bump(); const t = scope.token(); setBusy(true); setRes(null);
    let check: RCheck;
    try { check = await verifyAnchor(v.manifest!, v.bundle!.manifestHash, v.bundle!.anchorHint, memoReader(rpc, { signal: c.signal })); }
    catch (e) { check = { id: "anchor", label: "Optional Memo anchor", status: "unavailable", detail: (e as Error).message.slice(0, 200) }; }
    if (!scope.live(t)) return;
    setRes({ key: t.key, check }); setBusy(false);
  }
  const shown = res && res.key === base ? res.check : null;
  return <div className="space-y-2">
    <label className="block text-xs font-semibold">Re-read the anchor on chain with an RPC you choose (https)<input value={rpc} onChange={(e) => { setRpc(e.target.value); setRes(null); }} className="field mt-1 w-full font-mono text-xs" /></label>
    <button type="button" className="btn btn-paper" disabled={busy} onClick={() => void run()}>{busy ? "Reading chain…" : "Check anchor on chain"}</button>
    {shown && <ChecksList checks={[shown]} />}
  </div>;
}

/** File verifier. Each selection, owner change (parent re-keys) or unmount invalidates older reads. */
export function ReceiptFileVerifier() {
  const [v, setV] = useState<ReceiptVerification | null>(null); const [busy, setBusy] = useState(false); const [name, setName] = useState(""); const [readErr, setReadErr] = useState("");
  const scope = useLiveScope("file");
  return <Panel title="Verify a receipt file offline">
    <p className="text-xs">Runs entirely in your browser: strict parsing (duplicate keys rejected), commitments, stored checksums, identity binding, the ML-DSA-65 receipt signature and an exact Greenhouse replay where this build supports the engine. No Fleuri database is used. CLI: <span className="font-mono">bun scripts/verify-receipt.ts receipt.json [--rpc URL]</span></p>
    <input type="file" accept="application/json,.json" aria-label="Research receipt file" onChange={async (e) => {
      scope.bump(); const t = scope.token(); setV(null); setName(""); setReadErr("");
      const f = e.target.files?.[0]; if (!f) { setBusy(false); return; }
      setBusy(true);
      try {
        const text = f.size > RECEIPT_MAX_BYTES ? null : await f.text();
        if (!scope.live(t)) return;
        await new Promise((r) => setTimeout(r, 20));
        if (!scope.live(t)) return;
        const out = text == null ? { checks: [{ id: "schema" as const, label: "Schema & bounds", status: "fail" as const, detail: "Receipt is larger than the 2.6 MB limit." }], manifest: null, bundle: null, valid: false } : verifyReceiptBundle(text);
        if (!scope.live(t)) return;
        setV(out); setName(f.name);
      } catch (err) {
        if (scope.live(t)) setReadErr(`Could not read ${f.name}: ${(err as Error)?.message ?? "unknown error"}. Choose the file again to retry.`);
      } finally { if (scope.live(t)) setBusy(false); }
    }} />
    {readErr && <p role="alert" className="text-sm text-poppy-deep">{readErr}</p>}
    {busy && <p className="text-sm" role="status">Verifying and replaying…</p>}
    {v && <><p role="status" className={cn("hair p-2 text-sm font-semibold", v.valid ? "bg-sprout text-paper-light" : "bg-poppy-deep text-paper-light")}>{v.valid ? "Valid signed research receipt." : "Not a valid receipt."} <span className="font-normal">{name}</span> Signature validity shows which key attested these bytes; it does not make the strategy good.</p><ChecksList checks={v.checks} /><AnchorRpcCheck key={`${v.bundle?.manifestHash}|${name}`} v={v} /></>}
  </Panel>;
}
