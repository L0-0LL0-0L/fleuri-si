// Optional Pollen vault associations on a real token page. Association is not proof of routing.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Panel, WalletButtons, explorerAddr, signSubmitConfirm, useWallets } from "@/components/pq/ui";
import { pollenAssociate, pollenForLaunch, pollenPrepareRoute } from "@/lib/pq.functions";
import { connectWallet } from "@/services/wallet";

export function PollenOnToken({ launchId, cluster }: { launchId: string; cluster: string }) {
  const wallets = useWallets();
  const [signer, setSigner] = useState<string | null>(null); const [rows, setRows] = useState<any[]>([]);
  const [vault, setVault] = useState(""); const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState("");
  const load = async (s = signer) => { const r = await pollenForLaunch({ data: { launchId, signer: s } }); if (r.ok) setRows(r.data); };
  useEffect(() => { void load(); }, [launchId]);
  const run = async (l: string, f: () => Promise<void>) => { setBusy(l); setMsg(""); try { await f(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); } };
  return <Panel title="Pollen · fee-sharing vaults (optional)">
    <p className="text-sm">A creator can link a <Link to="/pollen" className="underline">Pollen vault</Link> they own. Linking alone does not route any fees: routing works only if this pool's immutable config names the vault as fee claimer.</p>
    {rows.length === 0 && <p className="text-sm">No vault linked.</p>}
    {rows.map((v) => <div key={v.address} className="hair space-y-1 p-2 text-sm">
      <a className="font-mono text-xs underline break-all" href={explorerAddr(v.address, cluster)} target="_blank" rel="noreferrer">{v.address} ↗</a>
      {v.error ? <p className="text-poppy-deep">{v.error}</p> : <>
        <p>{v.vault.recipients.length} recipients · funded {v.vault.funded} base units of {v.vault.symbol}</p>
        <p className="font-semibold">{v.eligible ? "Partner-fee routing: eligible" : "Partner-fee routing: unavailable"}</p>
        {!v.eligible && <ul className="list-disc pl-5 text-xs">{v.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>}
        {v.eligible && <WalletButtons avail={wallets} busy={busy} action="Claim partner fees into vault with" onPick={(k) => void run("Preparing…", async () => { const w = await connectWallet(k); const p = await pollenPrepareRoute({ data: { wallet: w, vault: v.address, launchId } }); if (!p.ok) throw new Error(p.error); const r = await signSubmitConfirm(k, p.data, { onStatus: setBusy }); setMsg(r.detail); await load(w); })} />}
      </>}
    </div>)}
    {!signer && rows.length > 0 && <WalletButtons avail={wallets} busy={busy} action="Check my eligibility with" onPick={(k) => void run("Connecting…", async () => { const w = await connectWallet(k); setSigner(w); await load(w); })} />}
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run("Linking…", async () => { const r = await pollenAssociate({ data: { vault: vault.trim(), launchId } }); if (!r.ok) throw new Error(r.error); setVault(""); await load(); setMsg("Linked after reading the vault on chain."); }); }}>
      <input aria-label="Vault address to link" value={vault} onChange={(e) => setVault(e.target.value)} placeholder="Your vault address (creator only)" className="hair min-w-0 flex-1 bg-paper-light px-2 py-2 font-mono text-xs" />
      <button className="btn btn-paper" disabled={!vault || !!busy}>Link vault</button>
    </form>
    {msg && <p role="status" className="text-sm break-words">{msg}</p>}
  </Panel>;
}
