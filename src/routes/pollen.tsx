import { createFileRoute, Link } from "@tanstack/react-router";
import { Keypair } from "@solana/web3.js";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel, RealBadge, WalletButtons, explorerAddr, signSubmitConfirm, useWallets } from "@/components/pq/ui";
import { pollenInspect, pollenImport, pollenList, pollenPrepareClaim, pollenPrepareCreate, pollenPrepareFund } from "@/lib/pq.functions";
import { POLLEN_MINTS, USDC_MINT, formatUnits, parseTerms, percentToBps } from "@/pq/pollen";
import { connectWallet, type WalletKind } from "@/services/wallet";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/pollen")({
  head: () => ({ meta: [
    { title: "Pollen · fee-sharing vaults — fleuri" },
    { name: "description", content: "Create, fund and claim real Meteora Dynamic Fee Sharing vaults with fixed, owner-chosen recipient shares." },
    { property: "og:title", content: "Pollen · fee-sharing vaults — fleuri" },
    { property: "og:description", content: "Real on-chain fee-sharing vaults: 2–5 recipients, shares fixed forever, every claim on Solana." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: PollenPage,
});

const sol = (l?: number) => (l == null ? "—" : `${(l / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`);
type Row = { address: string; pct: string };

function PollenPage() {
  const { userId, store } = useGarden();
  const wallets = useWallets();
  const [wallet, setWallet] = useState<{ kind: WalletKind; address: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [mint, setMint] = useState(USDC_MINT);
  const [rows, setRows] = useState<Row[]>([{ address: "", pct: "50" }, { address: "", pct: "50" }]);
  const [review, setReview] = useState<any>(null); const [ack, setAck] = useState(false);
  const base = useRef<Keypair | null>(null);
  const [known, setKnown] = useState<any[]>([]);
  const [lookup, setLookup] = useState(""); const [vault, setVault] = useState<any>(null);
  const [amount, setAmount] = useState("");
  async function run(label: string, f: () => Promise<void>) { setBusy(label); setErr(""); setMsg(""); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } }
  useEffect(() => { void pollenList().then((r) => r.ok && setKnown(r.data)); }, []);
  const terms = () => parseTerms({ mint, recipients: rows.map((r) => ({ address: r.address.trim(), bps: percentToBps(r.pct) })) });
  let termsErr = ""; try { terms(); } catch (e) { termsErr = (e as Error).message; }
  async function open(addr: string) { const r = await pollenInspect({ data: { vault: addr } }); if (!r.ok) throw new Error(r.error); setVault(r.data); setLookup(addr); }

  return <div className="space-y-4">
    <PageHeader title="pollen." kicker="real fee-sharing vaults · Meteora Dynamic Fee Sharing" />
    <div className="grid gap-4 md:grid-cols-[1fr_auto]"><p className="max-w-prose text-sm">A Pollen vault splits whatever is paid into it between 2–5 wallets <strong>you</strong> choose. Shares are written into the Meteora program when the vault is created and can never be edited. There is no fleuri wallet and no admin withdrawal. Each recipient claims their own share with their own wallet.</p><FlowerTiles count={4} cols={4} className="w-40" /></div>
    <p className="hair bg-paper-light p-3 text-sm"><strong>Manual funding ≠ fee routing.</strong> “Fund” pays tokens in through the program, which updates every share. Tokens sent straight to the vault's token account are <em>not</em> counted. Trading fees reach a vault only when a pool's immutable config names the vault as its fee claimer; see your token page for eligibility.</p>
    {!userId && <Panel title="Your workspace"><p className="text-sm">Open a workspace so prepared transactions are tied to you.</p><button type="button" className="btn btn-ink" disabled={!!busy} onClick={() => void run("Opening…", async () => { await store.startSandbox(); })}>Open workspace</button></Panel>}
    <Panel title="1 · Wallet">{wallet ? <p className="font-mono text-xs break-all">{wallet.kind}: {wallet.address}</p> : <WalletButtons avail={wallets} busy={busy} action="Connect" onPick={(k) => void run("Connecting…", async () => setWallet({ kind: k, address: await connectWallet(k) }))} />}</Panel>

    <Panel title="2 · Create a vault">
      <label className="block text-sm font-semibold">Token<select value={mint} onChange={(e) => { setMint(e.target.value); setReview(null); }} className="hair mt-1 h-11 w-full bg-paper-light px-2">{Object.entries(POLLEN_MINTS).map(([m, v]) => <option key={m} value={m}>{v.symbol} · {m.slice(0, 6)}…</option>)}</select></label>
      <fieldset className="space-y-2"><legend className="text-sm font-semibold">Recipients (2–5) and shares (must total 100%)</legend>
        {rows.map((r, i) => <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2"><input aria-label={`Recipient ${i + 1} wallet`} value={r.address} onChange={(e) => { const n = [...rows]; n[i] = { ...r, address: e.target.value }; setRows(n); setReview(null); }} placeholder="Solana wallet address" className="hair min-w-0 bg-paper-light px-2 py-2 font-mono text-xs" /><input aria-label={`Recipient ${i + 1} share percent`} value={r.pct} inputMode="decimal" onChange={(e) => { const n = [...rows]; n[i] = { ...r, pct: e.target.value }; setRows(n); setReview(null); }} className="hair bg-paper-light px-2 py-2 font-mono text-xs" /><button type="button" className="btn btn-paper" disabled={rows.length <= 2} onClick={() => { setRows(rows.filter((_, j) => j !== i)); setReview(null); }}>Remove</button></div>)}
        <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-paper" disabled={rows.length >= 5} onClick={() => { setRows([...rows, { address: "", pct: "0" }]); setReview(null); }}>Add recipient</button>{wallet && <button type="button" className="btn btn-paper" onClick={() => { const n = [...rows]; const i = n.findIndex((x) => !x.address); if (i >= 0) { n[i] = { ...n[i], address: wallet.address }; setRows(n); setReview(null); } }}>Fill an empty row with my wallet</button>}</div>
      </fieldset>
      {termsErr && <p className="text-sm text-poppy-deep">{termsErr}</p>}
      <button type="button" className="btn btn-red" disabled={!!busy || !wallet || !userId || !!termsErr} onClick={() => void run("Building and simulating…", async () => {
        base.current = Keypair.generate();
        const r = await pollenPrepareCreate({ data: { wallet: wallet!.address, base: base.current.publicKey.toBase58(), terms: terms() } });
        if (!r.ok) throw new Error(r.error); setReview(r.data); setAck(false);
      })}>{busy ?? "Review exact vault"}</button>
      {review && <div className="hair space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2"><RealBadge cluster={review.cluster} /><span className="font-mono text-xs break-all">vault {review.vault}</span></div>
        <ul className="text-sm">{review.terms.recipients.map((r: any) => <li key={r.address} className="flex justify-between gap-2"><span className="font-mono text-xs break-all">{r.address}</span><strong>{(r.bps / 100).toFixed(2)}%</strong></li>)}</ul>
        <p className="text-sm">Token {POLLEN_MINTS[review.terms.mint].symbol}. Owner and payer: your wallet. One-time base key generated in this browser (never sent). Cost: {review.cost.ok ? `${sol(review.cost.simulatedChangeLamports)} (rent + network fee ${sol(review.cost.networkFeeLamports)})` : review.cost.error}</p>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand these recipients and shares are fixed forever once created.</label>
        <WalletButtons avail={wallets} busy={busy} disabled={!ack || !review.cost.ok} action="Sign with" onPick={(k) => void run("Signing…", async () => { const r = await signSubmitConfirm(k, review, { coSign: [base.current!], onStatus: setBusy }); base.current = null; setMsg(r.detail); setReview(null); await open(review.vault); })} />
      </div>}
    </Panel>

    <Panel title="3 · Inspect, fund or claim a vault">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run("Reading vault…", () => open(lookup.trim())); }}><input aria-label="Vault address" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Vault address" className="hair min-w-0 flex-1 bg-paper-light px-2 py-2 font-mono text-xs" /><button className="btn btn-ink" disabled={!!busy || !lookup}>Inspect</button></form>
      {vault && <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><RealBadge cluster={vault.cluster} /><a className="font-mono text-xs underline break-all" href={explorerAddr(vault.vault.address, vault.cluster)} target="_blank" rel="noreferrer">{vault.vault.address} ↗</a><span className="text-xs">slot {vault.slot}</span></div>
        {!vault.vault.supported && <p className="text-sm text-poppy-deep">This vault uses an unsupported token; funding is disabled here.</p>}
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{(["funded", "claimed", "unclaimed", "dust"] as const).map((k) => <div key={k} title={k === "dust" ? "Rounding remainder from the program’s floor math; it is not claimable by anyone." : undefined}><dt className="font-mono text-xs uppercase">{k}</dt><dd className="font-semibold">{vault.vault.decimals != null ? formatUnits(vault.vault[k], vault.vault.decimals) : vault.vault[k]} {vault.vault.symbol}</dd></div>)}</dl>
        {vault.vault.pdaIssues?.length > 0 && <p className="text-xs">{vault.vault.pdaIssues.join(" ")}</p>}<table className="w-full text-xs"><thead><tr className="text-left"><th>Recipient</th><th>Share</th><th>Earned</th><th>Claimed</th><th>Unclaimed</th></tr></thead><tbody>{vault.vault.recipients.map((r: any) => <tr key={r.address}><td className="font-mono break-all">{r.address.slice(0, 6)}…{r.address.slice(-4)}{wallet?.address === r.address ? " (you)" : ""}</td><td>{(r.share / vault.vault.totalShare * 100).toFixed(2)}%</td>{(["earned", "claimed", "unclaimed"] as const).map((k) => <td key={k}>{vault.vault.decimals != null ? formatUnits(r[k], vault.vault.decimals) : r[k]}</td>)}</tr>)}</tbody></table>
        <p className="text-xs">Owner {vault.vault.owner}. Shares are fixed by the program; there is no edit or admin withdrawal instruction.</p>
        <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Amount to fund<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="hair mt-1 block bg-paper-light px-2 py-2 font-mono text-xs" /></label>
          <button type="button" className="btn btn-red" disabled={!!busy || !wallet || !userId || !vault.vault.supported || !amount} onClick={() => void run("Building fund transaction…", async () => { const p = await pollenPrepareFund({ data: { wallet: wallet!.address, vault: vault.vault.address, amount } }); if (!p.ok) throw new Error(p.error); if (!p.data.cost.ok) throw new Error(p.data.cost.error); if (!confirm(`Fund ${formatUnits(p.data.amount, p.data.decimals)} ${p.data.symbol} into this vault on ${p.data.cluster}? Network fee ≈ ${sol(p.data.cost.networkFeeLamports)}.`)) return; const r = await signSubmitConfirm(wallet!.kind, p.data, { onStatus: setBusy }); setMsg(r.detail); await open(vault.vault.address); })}>Fund via program</button>
          <button type="button" className="btn btn-ink" disabled={!!busy || !wallet || !userId || !vault.vault.recipients.some((r: any) => r.address === wallet?.address && BigInt(r.unclaimed) > 0n)} title={!vault.vault.recipients.some((r: any) => r.address === wallet?.address) ? "Connect a recipient wallet to claim" : "Nothing claimable yet — a zero claim would only advance your checkpoint"} onClick={() => void run("Building claim…", async () => { const p = await pollenPrepareClaim({ data: { wallet: wallet!.address, vault: vault.vault.address } }); if (!p.ok) throw new Error(p.error); if (!confirm(`Claim ${formatUnits(p.data.expected, p.data.decimals)} ${p.data.symbol} to your wallet?`)) return; const r = await signSubmitConfirm(wallet!.kind, p.data, { onStatus: setBusy }); setMsg(r.detail); await open(vault.vault.address); })}>Claim my share</button>
          <button type="button" className="btn btn-paper" disabled={!!busy || !userId} onClick={() => void run("Importing…", async () => { const r = await pollenImport({ data: { vault: vault.vault.address } }); if (!r.ok) throw new Error(r.error); setMsg("Vault listed on fleuri after reading it on chain."); })}>List on fleuri</button></div>
      </div>}
    </Panel>
    {err && <p role="alert" className="hair bg-paper-light p-3 text-sm text-poppy-deep break-words">{err}</p>}
    {msg && <p role="status" className="hair bg-paper-light p-3 text-sm">{msg}</p>}
    <Panel title="Known vaults">{known.length ? <ul className="text-sm">{known.map((v) => <li key={v.address}><button type="button" className="underline font-mono text-xs break-all" onClick={() => void run("Reading vault…", () => open(v.address))}>{v.address}</button> · {POLLEN_MINTS[v.mint]?.symbol} · {v.recipients.length} recipients</li>)}</ul> : <p className="text-sm">No vaults recorded yet.</p>}<p className="text-xs">Link a vault to your launch from its <Link to="/launchpad" className="underline">token page</Link>.</p></Panel>
  </div>;
}
