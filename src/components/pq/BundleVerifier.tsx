// Standalone in-browser bundle verifier: talks directly to the RPC and IPFS gateway the visitor
// chooses. Nothing goes through Fleuri's server or database, so RPC credentials stay local.
import { useState } from "react";
import { CheckList, Panel } from "@/components/pq/ui";

export function BundleVerifier() {
  const [file, setFile] = useState<unknown>(null); const [name, setName] = useState("");
  const [rpc, setRpc] = useState("https://api.mainnet-beta.solana.com"); const [gw, setGw] = useState("https://ipfs.io/ipfs/");
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setErr(""); setRes(null);
    try {
      // The lazily loaded chain reader pulls SPL helpers that expect a global Buffer at import.
      const { Buffer } = await import("buffer"); (globalThis as any).Buffer ??= Buffer;
      const [{ verifyBundle }, { connectionReader, rpcConnection }] = await Promise.all([import("@/pq/evidence"), import("@/pq/evidence-reader")]);
      const at = { rpc, gw }; const r = await verifyBundle(file, connectionReader(rpcConnection(rpc), gw)); setRes({ ...r, endpoints: at });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const failed = res?.checks.some((c: any) => c.status === "fail"); const all = res && !failed && res.checks.every((c: any) => c.status === "pass" || c.id === "image");
  return <Panel title="Verify an evidence bundle independently">
    <p className="text-sm">Upload a <span className="font-mono">fleuri.evidence-bundle/v1</span> file. Your browser reads the chain and IPFS directly from the endpoints below; fleuri's server and database are not used. Every claimed hash and address in the file is re-checked.</p>
    <label className="block text-sm">Bundle file<input type="file" accept=".json,application/json" className="mt-1 block w-full text-xs" onChange={async (e) => { setErr(""); setRes(null); setFile(null); setName(""); const f = e.target.files?.[0]; if (!f) return; if (f.size > 120_000) { setErr("Bundle must be 120 KB or smaller."); e.target.value = ""; return; } try { setFile(JSON.parse(await f.text())); setName(f.name); } catch { setErr("Not valid JSON."); e.target.value = ""; } }} /></label>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-sm">Solana RPC (https)<input value={rpc} onChange={(e) => { setRpc(e.target.value); setRes(null); }} className="hair mt-1 block w-full bg-paper-light px-2 py-2 font-mono text-xs" /></label>
      <label className="text-sm">IPFS gateway (https)<input value={gw} onChange={(e) => { setGw(e.target.value); setRes(null); }} className="hair mt-1 block w-full bg-paper-light px-2 py-2 font-mono text-xs" /></label>
    </div>
    <button type="button" className="btn btn-red" disabled={!file || busy} onClick={() => void run()}>{busy ? "Reading chain directly…" : `Verify ${name || "bundle"}`}</button>
    {err && <p role="alert" className="text-sm text-poppy-deep">{err}</p>}
    {res && <><p role="status" className={`hair p-2 text-sm font-semibold ${failed ? "bg-poppy text-paper-light" : all ? "bg-sprout text-paper-light" : "bg-paper-light"}`}>{failed ? "A check failed." : all ? "Bundle verified against the chain and IPFS." : "Partially verified — some evidence unavailable from these endpoints."}</p><CheckList label="Bundle checks" checks={res.checks} /><p className="text-xs">Observed {res.observedAt} via {new URL(res.endpoints.rpc).host}. Command line: <span className="font-mono">bun scripts/verify-bundle.ts bundle.json --rpc URL --gateway URL</span></p></>}
  </Panel>;
}
