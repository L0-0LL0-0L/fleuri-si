import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { PageHeader } from "@/components/bits";
import { CheckList, Panel, WalletButtons, useWallets } from "@/components/pq/ui";
import { FieldReport } from "@/components/pq/FieldReport";
import { botanistInfo } from "@/lib/pq.functions";
import { connectWallet, walletSignTransaction, type WalletKind } from "@/services/wallet";
import { b64 } from "@/pq/canonical";
import { USDC_DECIMALS, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@/pq/botanist";

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
/** header = the exact signed PAYMENT-SIGNATURE, saved BEFORE the first POST and resent verbatim. */
type Saved = { jobId: string; token: string; mint: string; at: number; expiresAt?: string; header?: string; state?: "quoted" | "accepted" | "delivered" | "failed" };
const loadSaved = (): Saved[] => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };

function Botanist() {
  const wallets = useWallets();
  const [info, setInfo] = useState<any>(null); const [mint, setMint] = useState(""); const [quote, setQuote] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState(""); const [result, setResult] = useState<any>(null); const [saved, setSaved] = useState<Saved[]>([]);
  const [ack, setAck] = useState(false); const [active, setActive] = useState<Saved | null>(null);
  useEffect(() => { void botanistInfo().then((r) => r.ok ? setInfo(r.data) : setMsg(r.error)); setSaved(loadSaved()); }, []);
  const remember = (s: Saved) => { const all = [s, ...loadSaved().filter((x) => x.jobId !== s.jobId)].slice(0, 20); localStorage.setItem(KEY, JSON.stringify(all)); setSaved(all); return s; };
  const patch = (jobId: string, p: Partial<Saved>) => { const cur = loadSaved().find((x) => x.jobId === jobId); return cur ? remember({ ...cur, ...p }) : null; };
  async function post(body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), header: r.headers.get("PAYMENT-REQUIRED") };
  }
  const showQuote = (s: Saved, r: { body: any; header: string | null }) => {
    const pr = r.header ? decodePaymentRequiredHeader(r.header) : r.body;
    setQuote({ jobId: s.jobId, token: s.token, mint: r.body.mint ?? s.mint, expiresAt: r.body.expiresAt ?? s.expiresAt, req: pr.accepts[0] }); setAck(false); setActive(null);
  };
  async function getQuote() {
    setBusy("Quoting…"); setMsg(""); setResult(null); setActive(null);
    try {
      const m = mint.trim(); const r = await post({ mint: m });
      if (r.status !== 402) throw new Error(r.body.error ?? `Unexpected ${r.status}`);
      const s = remember({ jobId: r.body.jobId, token: r.body.token, mint: m, at: Date.now(), expiresAt: r.body.expiresAt, state: "quoted" });
      showQuote(s, r);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }
  async function pay(kind: WalletKind) {
    setBusy("Preparing payment…"); setMsg("");
    try {
      const cur = loadSaved().find((x) => x.jobId === quote.jobId);
      if (cur?.header) throw new Error("This job already has a signed payment. Use Resume — you will not be asked to pay again.");
      if (new Date(quote.expiresAt).getTime() <= Date.now()) throw new Error("This quote expired. Request a new one; nothing was charged.");
      const req = quote.req; const fresh = await botanistInfo(); if (!fresh.ok || !fresh.data.blockhash) throw new Error("Could not read a recent blockhash.");
      if (fresh.data.feePayer !== req.extra.feePayer) throw new Error("Facilitator fee payer changed; request a new quote.");
      const payer = new PublicKey(await connectWallet(kind)); const usdc = new PublicKey(req.asset);
      const message = new TransactionMessage({ payerKey: new PublicKey(req.extra.feePayer), recentBlockhash: fresh.data.blockhash, instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        createTransferCheckedInstruction(getAssociatedTokenAddressSync(usdc, payer, true), usdc, getAssociatedTokenAddressSync(usdc, new PublicKey(req.payTo), true), payer, BigInt(req.amount), USDC_DECIMALS),
        new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: new TextEncoder().encode(req.extra.memo) as any })] }).compileToV0Message();
      setBusy("Approve in your wallet…");
      const signed = await walletSignTransaction(kind, new VersionedTransaction(message));
      const header = encodePaymentSignatureHeader({ x402Version: 2, resource: { url: location.origin + ENDPOINT, description: "Botanist field report", mimeType: "application/json" }, accepted: req, payload: { transaction: b64(new Uint8Array(signed.serialize())) } } as any);
      // Durable BEFORE the first POST: a lost response is resumed with these exact bytes.
      const s = patch(quote.jobId, { header, state: "accepted" })!; setQuote(null); setActive(s);
      setBusy("Settling and confirming on chain…");
      await send(s);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }
  async function send(s: Saved) {
    let r;
    try { r = await post({ jobId: s.jobId, token: s.token }, s.header ? { "PAYMENT-SIGNATURE": s.header } : {}); }
    catch { setActive(s); setMsg("Connection lost. Resume sends the same signed payment — no second wallet approval."); return; }
    if (r.status === 200) { patch(s.jobId, { state: "delivered" }); setResult(r.body); setActive(null); setQuote(null); setMsg(""); return; }
    if (r.status === 402 && !s.header) { showQuote(s, r); return; }
    if (r.status === 402 && s.header) {
      // Refused before acceptance (nothing bound or charged): the saved bytes are unusable; allow a fresh signature.
      const n = patch(s.jobId, { header: undefined, state: "quoted" })!; showQuote(n, r); setMsg(r.body.error ?? "Payment was refused before acceptance; nothing was charged."); return;
    }
    if (r.status === 410) { patch(s.jobId, { state: "failed" }); setActive(null); setQuote(null); setMsg(r.body.error ?? "This quote is closed."); return; }
    setActive(s); setMsg(r.body.error ?? r.body.detail ?? `Status ${r.status}`);
  }
  const resume = (s: Saved) => { setBusy("Resuming…"); setMsg(""); setResult(null); setMint(s.mint); void send(s).catch((e) => setMsg(e.message)).finally(() => setBusy(null)); };
  const usd = (u: string) => (Number(u) / 10 ** USDC_DECIMALS).toFixed(2);
  return <div className="space-y-4">
    <PageHeader title="the botanist." kicker="paid field report · x402" />
    <p className="text-sm">One point-in-time inspection of any Solana token mint, for {info ? usd(info.price) : "0.50"} USDC. Passport verification stays <Link to="/verify" className="underline">free</Link>. This is not an audit or safety rating.</p>
    <Panel title="Checkout readiness">{info ? <CheckList checks={info.checks} label="Botanist readiness" /> : <p className="text-sm">Checking…</p>}</Panel>
    <Panel title="1 · Mint to inspect">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void getQuote(); }}>
        <input aria-label="Token mint address" value={mint} onChange={(e) => { setMint(e.target.value); if (quote) { setQuote(null); setAck(false); } }} placeholder="Token mint address" className="hair min-w-0 flex-1 bg-paper-light px-2 py-2 font-mono text-xs" />
        <button className="btn btn-red" disabled={!mint || !!busy || !info?.ready}>{info?.ready === false ? "Checkout not ready" : "Get quote"}</button>
      </form>
    </Panel>
    {quote && <Panel title="2 · Review and pay">
      <dl className="hair divide-y divide-ink/20 text-sm">{[["Inspected mint", quote.mint], ["Price", `${usd(quote.req.amount)} USDC (${quote.req.amount} base units)`], ["Network", "Solana mainnet (" + quote.req.network + ")"], ["Pays to", quote.req.payTo], ["Network fee paid by", `facilitator ${quote.req.extra.feePayer}`], ["Job memo", quote.req.extra.memo], ["Quote expires", quote.expiresAt ? new Date(quote.expiresAt).toLocaleString() : "—"]].map(([k, v]) => <div key={k} className="grid gap-1 p-2 sm:grid-cols-[10rem_1fr]"><dt className="font-mono text-[0.65rem] uppercase">{k}</dt><dd className="break-all">{v}</dd></div>)}</dl>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I reviewed the mint, price and recipient. My wallet needs this USDC.</label>
      <WalletButtons avail={wallets} busy={busy} disabled={!ack} action="Pay with" onPick={(k) => void pay(k)} />
    </Panel>}
    {active && <Panel title="Payment accepted · resume">
      <p className="text-sm">Your signed payment for <span className="break-all font-mono text-xs">{active.mint}</span> is saved on this device. Resume re-sends the exact same bytes; your wallet is never asked again for this job.</p>
      <button type="button" className="btn btn-red" disabled={!!busy} onClick={() => resume(active)}>{busy ?? "Resume"}</button>
    </Panel>}
    {msg && <p role="alert" className="hair break-words bg-paper-light p-3 text-sm text-poppy-deep">{msg}</p>}
    {result && <Panel title="Field report"><FieldReport result={result} /></Panel>}
    {saved.length > 0 && <Panel title="Your reports on this device">
      <p className="text-xs">Retrieval tokens and signed payments stay only in this browser. Resuming never charges again.</p>
      {saved.map((s) => <div key={s.jobId} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="min-w-0 break-all font-mono text-xs">{s.mint} <span className="uppercase text-ink-soft">· {s.state ?? "quoted"}</span></span><button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => resume(s)}>{s.state === "delivered" ? "Open report" : "Resume"}</button></div>)}
    </Panel>}
  </div>;
}
