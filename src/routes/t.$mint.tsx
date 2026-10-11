import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CopyLink, PageHeader } from "@/components/bits";
import { Panel, RealBadge, explorerAddr, lifecycleLabel } from "@/components/pq/ui";
import { pqTokenPage } from "@/lib/pq.functions";
import { PollenOnToken } from "@/components/pq/PollenOnToken";

export const Route = createFileRoute("/t/$mint")({
  head: () => ({ meta: [
    { title: "Launched token — fleuri" },
    { name: "description", content: "Live on-chain price, holders and bonding-curve status for a token launched on Solana through fleuri." },
    { property: "og:title", content: "Launched token — fleuri" },
    { property: "og:description", content: "Live on-chain price, holders and curve status, with links to trade on Meteora and Jupiter." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: TokenPage,
});

const fmt = (n: number | null | undefined, d = 4) => n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d });
const sig = (n: number | null) => n == null ? "—" : n < 0.0001 ? n.toExponential(3) : fmt(n, 8);

function TokenPage() {
  const { mint } = Route.useParams();
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function load() { setBusy(true); setErr(""); try { const r = await pqTokenPage({ data: { mint } }); if (!r.ok) throw new Error(r.error); setRes(r.data); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  useEffect(() => { setRes(null); void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [mint]);
  const l = res?.launch; const c = res?.chain; const tok = l?.passports?.manifest?.token ?? (res?.tokenMeta ? { name: res.tokenMeta.name, symbol: res.tokenMeta.symbol } : null);
  const isFleuri = mint === FLEURI_MINT;
  const migrated = c?.isMigrated || l?.lifecycle === "damm_v2_live";
  const dammPool = c?.dammV2Pool ?? l?.damm_v2_pool;
  const curvePool = l?.pool ?? c?.pool ?? null;
  const meteoraUrl = migrated && dammPool ? `https://app.meteora.ag/dammv2/${dammPool}` : curvePool ? `https://app.meteora.ag/dbc/${curvePool}` : "";
  const jupUrl = `https://jup.ag/swap/SOL-${mint}`;
  const progress = c?.raisedSol != null && c?.thresholdSol ? Math.min(100, (c.raisedSol / c.thresholdSol) * 100) : null;
  return <div className="space-y-4">
    <PageHeader title={tok ? `${tok.name}.` : "a token on chain."} kicker={tok ? `$${tok.symbol} · real token` : "real token"}><CopyLink path={`/t/${mint}`} /></PageHeader>
    <div className="flex flex-wrap items-center gap-2"><RealBadge cluster={l?.cluster} /><span className="font-mono text-xs break-all">{mint}</span></div>
    {l && <p className="hair bg-paper-light p-3 text-sm">This is a <strong>real Solana token</strong> launched through fleuri. Prices and holders are read live from chain. It is not part of the garden sandbox — sandbox coins live under <Link to="/coins" className="underline">Coins</Link> and use virtual SOL.</p>}
    {c && !l && <p className="hair bg-paper-light p-3 text-sm">
      {isFleuri
        ? <>This is <strong>$FLEURI</strong>, live on a Meteora bonding curve (Solana mainnet). It was launched directly on Meteora, not recorded through fleuri's launchpad, so there is no passport here. Figures below are read live from chain.</>
        : <>This address is <strong>not a recorded fleuri launch</strong>. What follows is read straight from the chain and may be unavailable. It is not part of the garden sandbox — sandbox coins live under <Link to="/coins" className="underline">Coins</Link> and use virtual SOL.</>}
    </p>}
    {!c && !l && <p className="hair bg-paper-light p-3 text-sm">This address is <strong>not a recorded fleuri launch</strong>. It is not part of the garden sandbox — sandbox coins live under <Link to="/coins" className="underline">Coins</Link> and use virtual SOL.</p>}
    {busy && !res && <p role="status" className="hair bg-paper-light p-3 text-sm">Reading chain state…</p>}
    {err && <p role="alert" className="hair bg-paper-light p-3 text-sm text-poppy-deep">{err}</p>}
    {res && !l && !c && <Panel title="Not found"><p className="text-sm">No fleuri launch is recorded for this mint. Check the address, or browse the <Link to="/launchpad" className="underline">launchpad</Link>.</p></Panel>}
    {c && <>
      <Panel title="Price · live">
        {!c.readable && <p className="text-sm text-poppy-deep">The pool could not be read from chain right now. Figures below may be missing.</p>}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="font-mono text-xs uppercase">Curve price</dt><dd className="font-semibold">{sig(c.curvePriceSol ?? null)} SOL</dd></div>
          <div><dt className="font-mono text-xs uppercase">USD (Jupiter)</dt><dd className="font-semibold">{c.usdPrice != null ? `$${sig(c.usdPrice)}` : "not indexed"}</dd></div>
          <div><dt className="font-mono text-xs uppercase">Supply</dt><dd className="font-semibold">{fmt(c.supply, 0)}</dd></div>
          <div><dt className="font-mono text-xs uppercase">Market cap</dt><dd className="font-semibold">{c.curvePriceSol != null && c.supply != null ? `${fmt(c.curvePriceSol * c.supply, 2)} SOL` : "—"}</dd></div>
        </dl>
        {migrated && <p className="text-xs">After graduation the curve price is frozen; the live price is set by the DAMM v2 pool (see Jupiter).</p>}
      </Panel>
      <Panel title="Status">
        <p className="font-semibold">{migrated ? (dammPool ? "Graduated · live on DAMM v2" : "Graduated · DAMM v2 pool not yet confirmed") : "Live · on the bonding curve"}</p>
        {progress != null && !migrated && <><div className="hair h-3 bg-paper"><div className="h-full bg-poppy" style={{ width: `${progress}%` }} /></div><p className="text-sm">{fmt(c.raisedSol, 3)} / {fmt(c.thresholdSol, 2)} SOL raised on the bonding curve ({fmt(progress, 1)}%)</p></>}
        {curvePool && <p className="text-sm">Bonding-curve pool: <a className="underline break-all" href={explorerAddr(curvePool, l?.cluster ?? "mainnet-beta")} target="_blank" rel="noreferrer">{curvePool}</a></p>}
        {dammPool && <p className="text-sm">DAMM v2 pool: <a className="underline break-all" href={explorerAddr(dammPool, l?.cluster ?? "mainnet-beta")} target="_blank" rel="noreferrer">{dammPool}</a></p>}
        {l && <Link to="/passport/$hash" params={{ hash: l.passports.manifest_hash }} className="text-sm underline">Open living passport &amp; evidence download ↗</Link>}
      </Panel>
      <Panel title="Trade · real SOL, outside fleuri">
        <p className="text-sm">Buying and selling happens on these venues with your own wallet and real SOL. Fleuri does not hold funds or route trades.</p>
        <div className="flex flex-wrap gap-2">
          {meteoraUrl && <a className="btn btn-ink" href={meteoraUrl} target="_blank" rel="noreferrer">Trade on Meteora ↗</a>}
          <a className="btn btn-paper" href={jupUrl} target="_blank" rel="noreferrer">Trade on Jupiter ↗</a>
        </div>
      </Panel>
      {l && <PollenOnToken launchId={l.id} cluster={l.cluster} />}
      <Panel title="Top holders · live">
        {!c.topHolders?.length ? <p className="text-sm">No holder data available.</p> :
          <ol className="space-y-1 text-sm">{c.topHolders.map((h: any, i: number) => <li key={h.address} className="flex justify-between gap-2"><a className="truncate font-mono text-xs underline" href={explorerAddr(h.address, l?.cluster ?? "mainnet-beta")} target="_blank" rel="noreferrer">{i + 1}. {h.address}{h.address === curvePool ? " (curve)" : ""}</a><span>{fmt(h.amount, 0)}{c.supply ? ` · ${fmt((h.amount / c.supply) * 100, 2)}%` : ""}</span></li>)}</ol>}
        <p className="text-xs">Largest token accounts, refreshed every 30 seconds. Includes the pool's own reserve.</p>
      </Panel>
    </>}
  </div>;
}
