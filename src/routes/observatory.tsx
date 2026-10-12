import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel, RealBadge, downloadBlob, explorerAddr, explorerTx } from "@/components/pq/ui";
import { obsHistory, obsKnown, obsSnapshot } from "@/lib/observatory.functions";
import { POLLEN_MINTS, formatUnits } from "@/pq/pollen";
import { SOURCE_TEXT, TRADING_FEE_SOURCES, gapCount, historyCsv, mergeHistory, windowTotals, type Entry, type History, type ObservedTx, type Stream } from "@/pq/observatory";

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A real public mainnet vault used only as a reading example; unrelated to Fleuri or its revenue. */
export const EXAMPLE_VAULT = "DwyTJxxgyA8KF2MS8Jnmw4PymX2NjvBjnnQjLjj1tG5r";
const STREAMS: Stream[] = ["vault", "tokenVault"];

export const Route = createFileRoute("/observatory")({
  validateSearch: z.object({ vault: z.string().regex(ADDR).optional().catch(undefined) }),
  head: () => ({ meta: [
    { title: "Pollen Observatory — fleuri" },
    { name: "description", content: "Read any Meteora Dynamic Fee Sharing vault: live balances, recipient shares and a bounded, source-attributed history of funding and claims." },
    { property: "og:title", content: "Pollen Observatory — fleuri" },
    { property: "og:description", content: "Public, read-only view of real fee-sharing vaults on Solana, with each funding source proved from the transaction itself." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Observatory,
});

type Snap = { cluster: string; genesisHash: string; slot: number; observedAt: string; program: string; vault: any };
type Filter = "unverified" | "all" | "fund" | "claim" | "trading" | "manual" | "other" | "unknown" | "direct" | "issues";
const emptyHistory = (): History => ({ txs: [], coverage: {} as History["coverage"] });

function entryMatches(e: Entry, f: Filter, recipient: string) {
  if (recipient && !(e.kind === "claim" && e.recipient === recipient)) return false;
  switch (f) {
    case "all": return true;
    case "fund": return e.kind === "fund";
    case "claim": return e.kind === "claim";
    case "trading": return e.kind === "fund" && TRADING_FEE_SOURCES.includes(e.source);
    case "manual": return e.kind === "fund" && e.source === "manual";
    case "unknown": return e.kind === "fund" && e.source === "unknown";
    case "other": return e.kind === "fund" && !TRADING_FEE_SOURCES.includes(e.source) && e.source !== "manual" && e.source !== "unknown";
    case "direct": return e.kind === "direct_transfer";
    case "unverified": return (e.kind === "claim" && !e.recipientMatch) || (e.kind === "fund" && e.evidence !== "proved");
    default: return false;
  }
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<false | "copied" | "copy blocked">(false);
  return <button type="button" className="btn btn-paper !min-h-0 px-2 py-0.5 text-xs" aria-label={`Copy ${label}`} onClick={() => {
    const flash = (v: "copied" | "copy blocked") => { setDone(v); setTimeout(() => setDone(false), 1500); };
    try { const p = navigator.clipboard?.writeText(text); if (!p) flash("copy blocked"); else p.then(() => flash("copied"), () => flash("copy blocked")); } catch { flash("copy blocked"); }
  }}>{done || "copy"}</button>;
}

export function Observatory() {
  const { vault: param } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [input, setInput] = useState(param ?? "");
  const [known, setKnown] = useState<{ address: string; cluster: string; mint: string }[]>([]);
  const [cluster, setCluster] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [hist, setHist] = useState<History>(emptyHistory());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState(""); const [histErr, setHistErr] = useState("");
  const [filter, setFilter] = useState<Filter>("all"); const [recipient, setRecipient] = useState("");
  // Every async result is tagged with the generation it started in; newer lookups invalidate older ones.
  const gen = useRef(0); const current = useRef<string | null>(null); const paging = useRef(false);

  useEffect(() => {
    let live = true;
    obsKnown().then((r) => { if (live && r.ok) { setKnown(r.data.vaults ?? []); setCluster(r.data.cluster ?? null); } }, () => { /* list is optional */ });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (param && param !== current.current) { setInput(param); void load(param); }
    if (!param && current.current) { gen.current++; current.current = null; paging.current = false; setSnap(null); setHist(emptyHistory()); setErr(""); setHistErr(""); setBusy(null); setInput(""); }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [param]);
  useEffect(() => () => { gen.current++; }, []);

  async function load(address: string) {
    const g = ++gen.current; current.current = address; paging.current = false;
    setBusy("Reading the vault…"); setErr(""); setHistErr(""); setSnap(null); setHist(emptyHistory()); setFilter("all"); setRecipient("");
    try {
      const s = await obsSnapshot({ data: { vault: address } });
      if (g !== gen.current) return;
      if (!s.ok) throw new Error(s.error);
      setSnap(s.data);
      setBusy("Reading recent history…");
      const h = await obsHistory({ data: { vault: address, streams: ["vault", "tokenVault"], cursors: {} } });
      if (g !== gen.current) return;
      if (!h.ok) setHistErr(h.error);
      else if (h.data.vault !== address || h.data.cluster !== s.data.cluster) setHistErr("The history reply did not match this vault and network, so it was discarded.");
      else setHist(mergeHistory(emptyHistory(), h.data));
    } catch (e) { if (g === gen.current) setErr((e as Error).message); }
    finally { if (g === gen.current) setBusy(null); }
  }

  async function older() {
    if (!snap || paging.current) return;
    const g = gen.current; const address = snap.vault.address; const net = snap.cluster;
    const streams = STREAMS.filter((s) => !hist.coverage[s]?.exhausted);
    if (!streams.length) return;
    paging.current = true;
    const cursors = Object.fromEntries(streams.map((s) => [s, hist.coverage[s]?.oldestSignature ?? null]));
    setBusy("Loading older history…"); setHistErr("");
    try {
      const h = await obsHistory({ data: { vault: address, streams, cursors } });
      if (g !== gen.current || current.current !== address) return;
      if (!h.ok) { setHistErr(h.error); return; }
      if (h.data.vault !== address || h.data.cluster !== net) { setHistErr("The history reply did not match this vault and network, so it was discarded."); return; }
      setHist((old) => {
        const cov = { ...h.data.coverage };
        for (const s of streams) { const c = cov[s]; if (c && old.coverage[s]) cov[s] = { ...c, pages: old.coverage[s].pages + c.pages, oldestSlot: c.oldestSlot ?? old.coverage[s].oldestSlot }; }
        return mergeHistory(old, { txs: h.data.txs, coverage: cov });
      });
    } catch { if (g === gen.current) setHistErr("Older history could not be loaded. Check your connection and try again."); }
    finally { if (g === gen.current) { paging.current = false; setBusy(null); } }
  }

  function submit(address: string) {
    const a = address.trim();
    if (!ADDR.test(a)) { setErr("Enter a valid Solana address (base58, 32–44 characters)."); return; }
    void navigate({ search: { vault: a }, replace: false });
    if (a === current.current) void load(a);
  }

  const v = snap?.vault; const dec: number | null = v?.decimals ?? null; const sym = v?.symbol ?? "";
  const amt = (x: string) => (dec != null ? `${formatUnits(x, dec)} ${sym}` : `${x} base units`);
  const totals = windowTotals(hist.txs);
  const shown = hist.txs.filter((t) => filter === "issues" ? t.status !== "success" : filter === "all" && !recipient ? true : t.entries.some((e) => entryMatches(e, filter, recipient)));
  const exhausted = STREAMS.every((s) => hist.coverage[s]?.exhausted);
  const covErrors = STREAMS.map((s) => hist.coverage[s]?.error).filter(Boolean);
  const failedReads = gapCount(hist.txs);
  const windowNote = `Loaded window of ${hist.txs.length} transaction(s). ${exhausted ? "The RPC returned no older signatures for either address; that marks the end of what this RPC provides, not proof of complete history." : "Older history exists and is not loaded."}${failedReads ? ` ${failedReads} transaction(s) could not be read or decoded and are gaps.` : ""}${covErrors.length ? " Part of the signature list could not be read." : ""}`;
  const exportMeta = () => snap && ({
    format: "fleuri.pollen-observatory/v2", cluster: snap.cluster, genesis_hash: snap.genesisHash, program: snap.program, vault: v.address, token_vault: v.tokenVault, mint: v.mint, decimals: v.decimals,
    account_slot: snap.slot, observed_at: snap.observedAt, scope: "entire loaded window; on-screen filters not applied", window_transactions: hist.txs.length, gaps: failedReads,
    vault_stream: covText("vault"), token_vault_stream: covText("tokenVault"), coverage_note: windowNote, amounts: "integer base units",
  });
  function covText(s: Stream) { const c = hist.coverage[s]; return !c ? "not read" : c.error ? `not read: ${c.error}` : `${c.pages} page(s) back to slot ${c.oldestSlot ?? "unknown"}${c.exhausted ? "; RPC list ended" : "; more available"}`; }

  function exportJson() {
    if (!snap) return;
    const doc = { ...exportMeta(), note: "Public chain observation. Vault totals are the account state at account_slot; history is a bounded window, not complete history. Amounts are integer base-unit strings.",
      vault: { address: v.address, mint: v.mint, symbol: v.symbol, decimals: v.decimals, tokenVault: v.tokenVault, owner: v.owner, base: v.base, feeVaultType: v.feeVaultType, totalShare: v.totalShare, feePerShare: v.feePerShare, funded: v.funded, claimed: v.claimed, unclaimed: v.unclaimed, notCurrentlyClaimable: v.dust, recipients: v.recipients, pdaIssues: v.pdaIssues },
      historyCoverage: hist.coverage, windowTotals: totals, transactions: hist.txs };
    downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), `pollen-observatory-${v.address.slice(0, 8)}-${snap.slot}.json`);
  }
  const exportCsv = () => snap && downloadBlob(new Blob([historyCsv(hist.txs, dec, exportMeta() ?? undefined)], { type: "text/csv" }), `pollen-observatory-${v.address.slice(0, 8)}-${snap.slot}.csv`);

  return <div className="space-y-4">
    <PageHeader title="pollen observatory." kicker="public · read-only · Meteora Dynamic Fee Sharing">{snap && <RealBadge cluster={snap.cluster} />}</PageHeader>
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <p className="max-w-prose text-sm">Look inside any fee-sharing vault without a wallet. See what it holds right now, who shares it, and where each recent deposit came from. A deposit is labelled a trading fee only when its own transaction proves it. No sign-in, no signing, nothing is sent. Manage your own vaults on <Link to="/pollen" className="underline">Pollen</Link>.</p>
      <FlowerTiles count={4} cols={4} className="w-40" />
    </div>

    <Panel title="Find a vault">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); submit(input); }}>
        <input aria-label="Vault address" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Fee-sharing vault address" className="hair min-w-0 flex-1 bg-paper-light px-2 py-2 font-mono text-xs" />
        <button className="btn btn-red" disabled={!!busy || !input.trim()}>{busy && !snap ? busy : "Observe"}</button>
      </form>
      {known.length > 0 && <label className="block text-sm">Or pick a vault recorded on fleuri
        <select className="hair mt-1 h-11 w-full bg-paper-light px-2 font-mono text-xs" value="" disabled={!!busy} onChange={(e) => { if (e.target.value) { setInput(e.target.value); submit(e.target.value); } }}>
          <option value="">Choose…</option>{known.map((k) => <option key={k.address} value={k.address}>{k.address.slice(0, 8)}…{k.address.slice(-4)} · {POLLEN_MINTS[k.mint]?.symbol ?? "token"} · {k.cluster}</option>)}
        </select></label>}
      {cluster === "mainnet-beta" && <p className="text-xs">Just exploring? <button type="button" className="underline" disabled={!!busy} onClick={() => { setInput(EXAMPLE_VAULT); submit(EXAMPLE_VAULT); }}>Try a public example vault</button> — a random real mainnet vault, not owned by fleuri and not fleuri revenue.</p>}
      {err && <p role="alert" className="text-sm text-poppy-deep break-words">{err}</p>}
      {!snap && !busy && !err && <p className="text-sm text-ink-soft">Paste a vault address to begin. Only accounts owned by the Meteora Dynamic Fee Sharing program are read.</p>}
    </Panel>

    {busy && <p role="status" className="hair bg-paper-light p-3 text-sm">{busy}</p>}

    {snap && v && <>
      <Panel title="Right now · current account totals">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <a className="font-mono underline break-all" href={explorerAddr(v.address, snap.cluster)} target="_blank" rel="noreferrer">{v.address} ↗</a><Copy text={v.address} label="vault address" />
          <span>confirmed account read at slot {snap.slot} · fetched {new Date(snap.observedAt).toUTCString()}</span>
        </div>
        {!v.supported && <p className="text-sm text-poppy-deep">This vault holds a token fleuri doesn't support for funding, so amounts are shown in raw base units.</p>}
        <dl className="grid grid-cols-2 gap-px sm:grid-cols-4">{([["funded", "funded (lifetime)"], ["claimed", "claimed"], ["unclaimed", "claimable now"], ["dust", "not currently claimable"]] as const).map(([k, l]) =>
          <div key={k} className="hair bg-paper p-2"><dt className="font-mono text-[0.65rem] uppercase tracking-widest">{l}</dt><dd className="num text-lg font-bold break-all">{amt(v[k])}</dd></div>)}</dl>
        <p className="text-xs">These are the vault account's own counters, decoded from the account read at that slot. "Funded" counts every program deposit since creation, from any source. It is not fee revenue.</p>
        <div className="overflow-x-auto"><table className="w-full min-w-[32rem] text-xs"><thead><tr className="text-left"><th>Recipient</th><th>Fixed share</th><th>Claimed</th><th>Claimable</th></tr></thead>
          <tbody>{v.recipients.map((r: any) => <tr key={r.address} className="border-t border-ink/20"><td className="py-1"><a className="font-mono underline" href={explorerAddr(r.address, snap.cluster)} target="_blank" rel="noreferrer">{r.address.slice(0, 6)}…{r.address.slice(-4)}</a> <button type="button" className="underline" onClick={() => { setRecipient(r.address); setFilter("claim"); }}>claims</button></td><td>{(r.share / v.totalShare * 100).toFixed(2)}%</td><td className="num">{amt(r.claimed)}</td><td className="num">{amt(r.unclaimed)}</td></tr>)}</tbody></table></div>
        <p className="text-xs">Token {v.symbol} · <span className="font-mono">{v.mint}</span> · token vault <a className="font-mono underline" href={explorerAddr(v.tokenVault, snap.cluster)} target="_blank" rel="noreferrer">{v.tokenVault.slice(0, 6)}…{v.tokenVault.slice(-4)}</a> · owner <span className="font-mono">{v.owner.slice(0, 6)}…</span>{v.pdaIssues?.length ? ` · ${v.pdaIssues.join(" ")}` : " · PDA vault"}</p>
      </Panel>

      <Panel title="Recent activity · bounded window">
        <p className="text-sm">Transactions touching the vault or its token vault, newest first. Totals below cover this loaded window only. {windowNote}</p>
        <dl className="grid grid-cols-2 gap-px text-xs sm:grid-cols-4">
          {([["funded in window", totals.funded], ["of which trading fees (proved)", totals.tradingFee], ["of which manual", totals.manual], ["of which other / unknown", (BigInt(totals.other) + BigInt(totals.unknown)).toString()], ["claimed in window (verified)", totals.claimed], ["claims not verified", totals.claimedUnverified], ["direct transfers (not counted)", totals.directUncounted], ["unclassified transfers", totals.directUnclassified]] as const).map(([l, x]) =>
            <div key={l} className="hair bg-paper p-2"><dt className="font-mono text-[0.6rem] uppercase tracking-widest">{l}</dt><dd className="num font-bold break-all">{amt(x)}</dd></div>)}
        </dl>
        <ul className="text-xs">{(["vault", "tokenVault"] as Stream[]).map((s) => { const c = hist.coverage[s]; return <li key={s}>{s === "vault" ? "Vault" : "Token vault"}: {c ? (c.error ? `not read (${c.error})` : `${c.pages} page(s), back to ${c.oldestSlot != null ? `slot ${c.oldestSlot}` : "—"}${c.exhausted ? ", end of RPC list" : ", more available"}`) : "not read"}</li>; })}</ul>
        {histErr && <p role="alert" className="text-xs text-poppy-deep">{histErr}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs">Show <select className="hair ml-1 h-9 bg-paper-light px-1" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">everything</option><option value="fund">funding</option><option value="claim">claims</option><option value="trading">trading-fee funding</option><option value="manual">manual deposits</option><option value="other">surplus / migration / rewards</option><option value="unknown">unknown source</option><option value="direct">direct transfers</option><option value="unverified">unverified items</option><option value="issues">failed / unreadable</option>
          </select></label>
          {recipient && <button type="button" className="btn btn-paper !min-h-0 px-2 py-1 text-xs" onClick={() => setRecipient("")}>recipient {recipient.slice(0, 4)}…{recipient.slice(-4)} ✕</button>}
          <button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => void load(v.address)}>Refresh</button>
          <button type="button" className="btn btn-ink" disabled={!!busy || exhausted} onClick={() => void older()}>{exhausted ? "End of RPC history" : "Load older"}</button>
          <button type="button" className="btn btn-paper" disabled={!!busy} onClick={exportJson}>Download window JSON</button>
          <button type="button" className="btn btn-paper" disabled={!!busy} onClick={exportCsv}>Download window CSV</button>
        </div>
        <p className="text-[0.7rem] text-ink-soft">Downloads contain the entire loaded window with its network, vault and coverage notes; filters only change this list.</p>
        {shown.length === 0 ? <p className="text-sm text-ink-soft">{hist.txs.length ? "Nothing in this window matches the filter." : "No transactions observed in this window."}</p> :
          <ol className="space-y-2">{shown.map((t) => <TxRow key={t.signature} t={t} cluster={snap.cluster} amt={amt} filter={filter} recipient={recipient} />)}</ol>}
      </Panel>
    </>}

    <Panel title="How to read this">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li><strong>Trading fee</strong> means this deposit came from a Meteora claim of DBC creator/partner trading fees or DAMM v2 position fees. The proof is the transaction itself: the fee-sharing program's own event, under the exact claim it made. It proves this deposit only, not where future fees will go.</li>
        <li>Surplus, migration-fee and farming-reward deposits are shown separately and are never called trading fees. <strong>Unknown</strong> means the source couldn't be proved.</li>
        <li>Tokens sent straight to the token vault are shown as direct transfers. The program does not count them, so they are not rewards.</li>
        <li>Failed transactions moved nothing and are left out of totals. Unreadable ones are marked, never guessed.</li>
      </ul>
    </Panel>
    <FlowerTiles count={8} cols={8} />
  </div>;
}

function TxRow({ t, cluster, amt, filter, recipient }: { t: ObservedTx; cluster: string; amt: (x: string) => string; filter: Filter; recipient: string }) {
  const entries = filter === "all" && !recipient || filter === "issues" ? t.entries : t.entries.filter((e) => entryMatches(e, filter, recipient));
  const tone = t.status === "success" ? "bg-paper" : t.status === "failed" ? "bg-paper-deep" : "bg-paper-light";
  return <li className={`hair p-2 text-xs ${tone}`}>
    <div className="flex flex-wrap items-center gap-2">
      <a className="font-mono underline" href={explorerTx(t.signature, cluster)} target="_blank" rel="noreferrer">{t.signature.slice(0, 10)}…{t.signature.slice(-6)} ↗</a><Copy text={t.signature} label="signature" />
      <span>{t.slot != null ? `slot ${t.slot}` : "slot unknown"} · {t.blockTime != null ? new Date(t.blockTime * 1000).toISOString().replace(".000Z", "Z") : "time unknown"}</span>
      <span className={`chip ${t.status === "success" ? "bg-paper-light" : "bg-poppy text-paper-light"}`}>{t.status}</span>
      <span className="text-ink-soft">via {t.via.map((s) => (s === "vault" ? "vault" : "token vault")).join(" + ")}</span>
    </div>
    {t.reason && <p className="mt-1">{t.reason}</p>}
    {t.status === "success" && !t.entries.length && <p className="mt-1 text-ink-soft">No funding or claim for this vault{t.otherVaultEvents ? ` (${t.otherVaultEvents} event(s) for other vaults ignored)` : ""}.</p>}
    {entries.length > 0 && <ul className="mt-1 space-y-0.5">{entries.map((e, i) => <li key={i} className="flex flex-wrap gap-x-2">
      {e.kind === "fund" && <><strong>Funded {amt(e.amount)}</strong><span className={TRADING_FEE_SOURCES.includes(e.source) ? "font-semibold text-poppy-deep" : ""}>{SOURCE_TEXT[e.source]}</span>{e.evidence !== "proved" && <span>({e.note ?? "source not provable from this transaction"})</span>}</>}
      {e.kind === "claim" && <><strong>Claimed {amt(e.amount)}</strong><span>by <span className="font-mono">{e.recipient.slice(0, 6)}…{e.recipient.slice(-4)}</span></span>{!e.recipientMatch && <span className="text-poppy-deep">not verified — {e.note ?? "recipient did not match the vault's slot"}; excluded from verified totals</span>}</>}
      {e.kind === "direct_transfer" && (e.scope === "outside_dfs"
        ? <><strong>{amt(e.amount)} sent directly</strong><span>to the token vault — not counted by the program, not a reward</span></>
        : <><strong>{amt(e.amount)} unclassified transfer</strong><span>into the token vault; its nesting couldn't be proved — not counted</span></>)}
    </li>)}</ul>}
  </li>;
}
