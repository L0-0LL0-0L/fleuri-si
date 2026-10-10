import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { PageHeader } from "@/components/bits";
import { CheckList, Panel, WalletButtons, downloadBlob, explorerTx, useWallets } from "@/components/pq/ui";
import { botanistInfo } from "@/lib/pq.functions";
import { connectWallet, walletSignTransaction, type WalletKind } from "@/services/wallet";
import { b64 } from "@/pq/canonical";
import { USDC_DECIMALS } from "@/pq/botanist";

export const Route = createFileRoute("/botanist")({
  head: () => ({ meta: [
    { title: "Botanist field report — fleuri" }, { name: "description", content: "A paid point-in-time inspection of any Solana token mint: authorities, metadata, fees, graduation and holder evidence. 0.50 USDC via x402." },
    { property: "og:title", content: "Botanist field report — fleuri" }, { property: "og:description", content: "Paid on-chain token inspection over x402. Verification stays free." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Botanist,
});

const ENDPOINT = "/api/public/botanist/report";
const KEY = "fleuri.botanist.jobs";
type Saved = { jobId: string; token: string; mint: string; at: number };
const loadSaved = (): Saved[] => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };

function Botanist() {
  const wallets = useWallets();
  const [info, setInfo] = useState<any>(null); const [mint, setMint] = useState(""); const [quote, setQuote] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState(""); const [result, setResult] = useState<any>(null); const [saved, setSaved] = useState<Saved[]>([]);
  const [ack, setAck] = useState(false);
  useEffect(() => { void botanistInfo().then((r) => r.ok ? setInfo(r.data) : setMsg(r.error)); setSaved(loadSaved()); }, []);
  const remember = (s: Saved) => { const all = [s, ...loadSaved().filter((x) => x.jobId !== s.jobId)].slice(0, 20); localStorage.setItem(KEY, JSON.stringify(all)); setSaved(all); };
  async function post(body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), header: r.headers.get("PAYMENT-REQUIRED") };
  }
  async function getQuote() {
    setBusy("Quoting…"); setMsg(""); setResult(null);
    try {
      const r = await post({ mint: mint.trim() });
      if (r.status !== 402) throw new Error(r.body.error ?? `Unexpected ${r.status}`);
      const pr = r.header ? decodePaymentRequiredHeader(r.header) : r.body;
      remember({ jobId: r.body.jobId, token: r.body.token, mint: mint.trim(), at: Date.now() });
      setQuote({ ...r.body, req: pr.accepts[0] }); setAck(false);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }
  async function pay(kind: WalletKind) {
    setBusy("Preparing payment…"); setMsg("");
    try {
      const req = quote.req; const fresh = await botanistInfo(); if (!fresh.ok || !fresh.data.blockhash) throw new Error("Could not read a recent blockhash.");
      if (fresh.data.feePayer !== req.extra.feePayer) throw new Error("Facilitator fee payer changed; request a new quote.");
      const payer = new PublicKey(await connectWallet(kind)); const usdc = new PublicKey(req.asset);
      const tx = new Transaction({ feePayer: new PublicKey(req.extra.feePayer), recentBlockhash: fresh.data.blockhash });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        createTransferCheckedInstruction(getAssociatedTokenAddressSync(usdc, payer, true), usdc, getAssociatedTokenAddressSync(usdc, new PublicKey(req.payTo), true), payer, BigInt(req.amount), USDC_DECIMALS),
        new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: new TextEncoder().encode(req.extra.memo) as any }));
      setBusy("Approve in your wallet…");
      const signed = await walletSignTransaction(kind, tx);
      const header = encodePaymentSignatureHeader({ x402Version: 2, resource: { url: location.origin + ENDPOINT, description: "Botanist field report", mimeType: "application/json" }, accepted: req, payload: { transaction: b64(new Uint8Array(signed.serialize({ requireAllSignatures: false, verifySignatures: false }))) } } as any);
      setBusy("Settling and confirming on chain…");
      await finish(post({ jobId: quote.jobId, token: quote.token }, { "PAYMENT-SIGNATURE": header }));
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }
  async function finish(p: Promise<{ status: number; body: any }>) {
    const r = await p;
    if (r.status === 200) { setResult(r.body); setQuote(null); }
    else setMsg(r.body.error ?? r.body.detail ?? `Status ${r.status}`);
  }
  const resume = (s: Saved) => { setBusy("Resuming…"); setMsg(""); void finish(post({ jobId: s.jobId, token: s.token })).catch((e) => setMsg(e.message)).finally(() => setBusy(null)); };
  const usd = (u: string) => (Number(u) / 10 ** USDC_DECIMALS).toFixed(2);
  return <div className="space-y-4">
    <PageHeader title="the botanist." kicker="paid field report · x402" />
    <p className="text-sm">One point-in-time inspection of any Solana token mint, for {info ? usd(info.price) : "0.50"} USDC. Passport verification stays <Link to="/verify" className="underline">free</Link>. This is not an audit or safety rating.</p>
    <Panel title="Checkout readiness">{info ? <CheckList checks={info.checks} label="Botanist readiness" /> : <p className="text-sm">Checking…</p>}</Panel>
    <Panel title="1 · Mint to inspect">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void getQuote(); }}>
        <input aria-label="Token mint address" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Token mint address" className="hair min-w-0 flex-1 bg-paper-light px-2 py-2 font-mono text-xs" />
        <button className="btn btn-red" disabled={!mint || !!busy || !info?.ready}>{info?.ready === false ? "Checkout not ready" : "Get quote"}</button>
      </form>
    </Panel>
    {quote && <Panel title="2 · Review and pay">
      <dl className="hair divide-y divide-ink/20 text-sm">{[["Price", `${usd(quote.req.amount)} USDC (${quote.req.amount} base units)`], ["Network", "Solana mainnet (" + quote.req.network + ")"], ["Pays to", quote.req.payTo], ["Network fee paid by", `facilitator ${quote.req.extra.feePayer}`], ["Job memo", quote.req.extra.memo], ["Quote expires", `${quote.req.maxTimeoutSeconds / 60} minutes`]].map(([k, v]) => <div key={k} className="grid gap-1 p-2 sm:grid-cols-[10rem_1fr]"><dt className="font-mono text-[0.65rem] uppercase">{k}</dt><dd className="break-all">{v}</dd></div>)}</dl>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I reviewed the price and recipient. My wallet needs this USDC.</label>
      <WalletButtons avail={wallets} busy={busy} disabled={!ack} action="Pay with" onPick={(k) => void pay(k)} />
    </Panel>}
    {msg && <p role="alert" className="hair break-words bg-paper-light p-3 text-sm text-poppy-deep">{msg}</p>}
    {result && <Panel title="Field report">
      <p className="text-sm">Observed at slot {result.report.observedSlot} · {result.report.observedAt}. Paid in <a className="underline" href={explorerTx(result.receipt.payment.transaction, "mainnet-beta")} target="_blank" rel="noreferrer">{result.receipt.payment.transaction.slice(0, 12)}… ↗</a></p>
      <pre className="hair max-h-96 overflow-auto whitespace-pre-wrap break-all p-2 text-[0.7rem]">{JSON.stringify(result.report, null, 2)}</pre>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(result.report, null, 2)], { type: "application/json" }), `botanist-${result.jobId}.json`)}>Download report</button>
        <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(result.receipt, null, 2)], { type: "application/json" }), `botanist-receipt-${result.jobId}.json`)}>Download receipt</button>
      </div>
      <p className="text-xs text-ink-soft">{result.receipt.notice}</p>
    </Panel>}
    {saved.length > 0 && <Panel title="Your reports on this device">
      <p className="text-xs">Retrieval tokens are kept only in this browser. Resuming never charges again.</p>
      {saved.map((s) => <div key={s.jobId} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="break-all font-mono text-xs">{s.mint}</span><button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => resume(s)}>Open / resume</button></div>)}
    </Panel>}
  </div>;
}
