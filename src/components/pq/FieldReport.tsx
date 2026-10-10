// Readable Botanist field report. Raw JSON stays available as optional detail.
import type { ReactNode } from "react";
import { FlowerTiles } from "@/components/PixelFlower";
import { downloadBlob, explorerAddr, explorerTx } from "@/components/pq/ui";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const pct = (bps?: number | null) => (bps === null || bps === undefined ? "—" : `${(bps / 100).toFixed(2)}%`);
const sol = (l?: string | null) => (l ? `${(Number(BigInt(l) / 1_000_000n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} SOL` : "—");

function Row({ k, children, tone }: { k: string; children: ReactNode; tone?: "good" | "warn" | "na" }) {
  const t = tone === "good" ? "bg-sprout text-paper-light" : tone === "warn" ? "bg-poppy-deep text-paper-light" : tone === "na" ? "bg-paper-deep" : "";
  return <div className="grid gap-1 p-2 sm:grid-cols-[11rem_minmax(0,1fr)]"><dt className="font-mono text-[0.65rem] uppercase">{k}</dt><dd className="min-w-0 break-words text-sm">{tone ? <span className={`hair mr-2 px-1 font-mono text-[0.6rem] uppercase ${t}`}>{tone === "good" ? "ok" : tone === "warn" ? "note" : "n/a"}</span> : null}{children}</dd></div>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="space-y-1"><h3 className="font-mono text-[0.7rem] uppercase tracking-widest">{title}</h3><dl className="hair divide-y divide-ink/20 bg-paper-light">{children}</dl></section>;
}
const A = ({ a, cluster }: { a?: string | null; cluster: string }) => a ? <a className="font-mono text-xs underline" href={explorerAddr(a, cluster)} target="_blank" rel="noreferrer">{short(a)} ↗</a> : <span>—</span>;

export function FieldReport({ result }: { result: { jobId: string; report: any; receipt: any } }) {
  const r = result.report; const f = r.facts ?? {}; const cl = r.cluster === "devnet" ? "devnet" : "mainnet-beta"; const un: Record<string, string> = r.unavailable ?? {};
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
      <div className="space-y-1">
        <p className="font-display text-2xl leading-none">{f.metadata?.name ?? "Unnamed mint"} {f.metadata?.symbol ? <span className="text-poppy">${f.metadata.symbol}</span> : null}</p>
        <p className="break-all font-mono text-xs">{r.mint}</p>
        <p className="text-xs text-ink-soft">Observed from slot {r.observedSlot} · {new Date(r.observedAt).toLocaleString()} · {r.observedSlotNote}</p>
      </div>
      <FlowerTiles count={4} cols={2} start={3} className="hidden w-36 sm:grid" />
    </div>
    <Section title="Authorities">
      <Row k="Mint authority" tone={f.mint?.mintAuthorityRevoked ? "good" : "warn"}>{f.mint?.mintAuthorityRevoked ? "Revoked — no more tokens can be minted" : <>Active: <A a={f.mint?.mintAuthority} cluster={cl} /></>}</Row>
      <Row k="Freeze authority" tone={f.mint?.freezeAuthorityRevoked ? "good" : "warn"}>{f.mint?.freezeAuthorityRevoked ? "Revoked — accounts cannot be frozen" : <>Active: <A a={f.mint?.freezeAuthority} cluster={cl} /></>}</Row>
      <Row k="Token program">{f.mint?.program} · {f.mint?.decimals} decimals · supply {f.mint?.supply}{f.mint?.token2022Extensions?.length ? ` · extensions: ${f.mint.token2022Extensions.join(", ")}` : ""}</Row>
      <Row k="Token program upgrade" tone={f.tokenProgram ? undefined : "na"}>{f.tokenProgram ? (f.tokenProgram.upgradeable ? <>Upgradeable by <A a={f.tokenProgram.authority} cluster={cl} /></> : "Immutable") : un.tokenProgram}</Row>
    </Section>
    <Section title="Metadata">
      {f.metadata ? <>
        <Row k="Mutable" tone={f.metadata.isMutable ? "warn" : "good"}>{f.metadata.isMutable ? "Yes — the update authority can change name/image" : "No — immutable"}</Row>
        <Row k="Update authority"><A a={f.metadata.updateAuthority} cluster={cl} /></Row>
        <Row k="URI"><span className="break-all font-mono text-xs">{f.metadata.uri}</span></Row>
      </> : <Row k="Metadata" tone="na">{un.metadata ?? "Unavailable"}</Row>}
    </Section>
    <Section title="Holder accounts">
      {f.holders ? <>
        <Row k="Top-10 share" tone={f.holders.top10ShareBps > 5000 ? "warn" : undefined}>{pct(f.holders.top10ShareBps)} of supply · {f.holders.note}</Row>
        {f.holders.topAccounts.slice(0, 10).map((h: any, i: number) => <Row key={h.account} k={`#${i + 1}`}><span className="inline-flex flex-wrap items-center gap-2"><A a={h.account} cluster={cl} /> <span className="font-mono text-xs">{pct(h.shareBps)}</span><span className="h-1.5 bg-poppy" style={{ width: `${Math.min(100, (h.shareBps ?? 0) / 100)}%`, minWidth: 2, maxWidth: 160 }} aria-hidden /></span></Row>)}
      </> : <Row k="Holders" tone="na">{un.holders}</Row>}
    </Section>
    <Section title="Protocol · fees and graduation">
      {f.fleuri ? <>
        <Row k="Fleuri passport"><a className="underline" href={`/passport/${f.fleuri.passport}`}>{short(f.fleuri.passport)}</a> · launch <a className="underline" href={explorerTx(f.fleuri.launchTx, cl)} target="_blank" rel="noreferrer">{short(f.fleuri.launchTx)} ↗</a></Row>
        <Row k="Original creator"><A a={f.fleuri.originalCreator} cluster={cl} /></Row>
        {f.dbc ? <>
          <Row k="Current pool creator" tone={f.dbc.creatorChanged ? "warn" : "good"}><A a={f.dbc.currentCreator} cluster={cl} />{f.dbc.creatorChanged ? " (changed since launch)" : ""}</Row>
          <Row k="Curve progress">{sol(f.dbc.quoteReserveLamports)} of {sol(f.dbc.migrationQuoteThresholdLamports)}{f.dbc.migrated ? " · migrated" : ""}</Row>
          <Row k="DAMM v2 pool" tone={f.dbc.dammV2Confirmed ? "good" : "na"}>{f.dbc.dammV2Confirmed ? <A a={f.dbc.dammV2Pool} cluster={cl} /> : "Not live (no confirmed DAMM v2 pool)"}</Row>
        </> : <Row k="DBC pool" tone="na">{un.dbcPool}</Row>}
        {f.dbcConfig ? <>
          <Row k="Trading fee">{f.dbcConfig.baseFeeBps} bps{f.dbcConfig.dynamicFeeEnabled ? " + dynamic" : ""} · creator {f.dbcConfig.creatorTradingFeePercent}% / partner {f.dbcConfig.partnerTradingFeePercent}%</Row>
          <Row k="Fee claimer" tone={f.dbcConfig.matchesSigned === false ? "warn" : f.dbcConfig.matchesSigned ? "good" : undefined}><A a={f.dbcConfig.feeClaimer} cluster={cl} />{f.dbcConfig.matchesSigned === false ? " — differs from the signed passport" : f.dbcConfig.matchesSigned ? " — matches the signed passport" : ""}</Row>
          <Row k="Graduation">{sol(f.dbcConfig.migrationQuoteThresholdLamports)} → {f.dbcConfig.migrationTarget}, migrated pool fee {f.dbcConfig.migratedPoolFeeBps} bps</Row>
        </> : <Row k="DBC config" tone="na">{un.dbcConfig}</Row>}
        <Row k="DBC program upgrade" tone={f.dbcProgram ? undefined : "na"}>{f.dbcProgram ? (f.dbcProgram.upgradeable ? <>Upgradeable by <A a={f.dbcProgram.authority} cluster={cl} /></> : "Immutable") : un.dbcProgram}</Row>
      </> : <Row k="Protocol" tone="na">{un.protocol}</Row>}
    </Section>
    <Section title="Not proven by this report">
      {Object.entries(un).filter(([k]) => ["lp"].includes(k) || !["metadata", "holders", "protocol", "dbcPool", "dbcConfig", "dbcProgram", "tokenProgram"].includes(k)).map(([k, v]) => <Row key={k} k={k} tone="na">{v}</Row>)}
    </Section>
    <Section title="Evidence and payment">
      <Row k="Explorer"><a className="underline" href={r.evidence?.explorer} target="_blank" rel="noreferrer">Token on Solscan ↗</a></Row>
      <Row k="Paid in"><a className="underline" href={explorerTx(result.receipt.payment.transaction, "mainnet-beta")} target="_blank" rel="noreferrer">{short(result.receipt.payment.transaction)} ↗</a> · slot {result.receipt.payment.slot} · {Number(result.receipt.payment.amount) / 1e6} USDC</Row>
      <Row k="Report digest"><span className="break-all font-mono text-xs">{result.receipt.outputDigest}</span></Row>
    </Section>
    <p className="text-xs text-ink-soft">{r.disclaimer} {result.receipt.notice}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }), `botanist-${result.jobId}.json`)}>Download report JSON</button>
      <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(result.receipt, null, 2)], { type: "application/json" }), `botanist-receipt-${result.jobId}.json`)}>Download receipt</button>
    </div>
    <details className="hair bg-paper-light p-2"><summary className="cursor-pointer font-mono text-xs uppercase">Raw report JSON</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-[0.7rem]">{JSON.stringify(r, null, 2)}</pre></details>
  </div>;
}
