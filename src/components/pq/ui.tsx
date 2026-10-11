import { Transaction } from "@solana/web3.js";
import { useEffect, useState, type ReactNode } from "react";
import { b64, fromB64 } from "@/pq/canonical";
import type { Check, PassportManifest, SignedPassportT } from "@/pq/passport";
import { pqConfirm, pqSubmit, pqRetry } from "@/lib/pq.functions";
import { connectWallet, getProvider, walletSignTransaction, type WalletKind } from "@/services/wallet";
import { cn } from "@/lib/utils";
import { guardedSignSubmit } from "@/pq/wallet-flow";
export { ScopeChangedError } from "@/pq/wallet-flow";

export function RealBadge({ cluster, className }: { cluster?: string; className?: string }) {
  return (
    <span className={cn("hair inline-flex items-center gap-1 bg-ink px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-widest text-paper-light", className)}>
      <span aria-hidden className="h-1.5 w-1.5 bg-poppy" /> Solana · {cluster === "devnet" ? "devnet test SOL" : cluster ?? "network"}
    </span>
  );
}

const TONE: Record<Check["status"], string> = { pass: "bg-sprout text-paper-light", fail: "bg-poppy-deep text-paper-light", pending: "bg-paper-deep", unavailable: "bg-paper-light text-ink-soft" };
export function CheckList({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <ul aria-label={label} className="hair divide-y divide-ink/20 bg-paper-light">
      {checks.map((c) => (
        <li key={c.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2 p-2 text-sm">
          <span className={cn("hair px-1.5 py-0.5 text-center font-mono text-[0.65rem] uppercase", TONE[c.status])}>{c.status}</span>
          <span className="min-w-0">
            <strong className="block">{c.label}</strong>
            <span className="block break-words text-xs text-ink-soft">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("hair space-y-3 bg-paper-light p-3 sm:p-4", className)} aria-label={title}>
      <h2 className="font-mono text-xs uppercase tracking-widest">{title}</h2>
      {children}
    </section>
  );
}

export function useWallets() {
  const [avail, setAvail] = useState<Record<WalletKind, boolean>>({ phantom: false, solflare: false });
  useEffect(() => {
    // Wallets inject asynchronously; poll for a few seconds so late injectors are found.
    const check = () => setAvail({ phantom: !!getProvider("phantom"), solflare: !!getProvider("solflare") });
    check();
    const t = setInterval(check, 500);
    const stop = setTimeout(() => clearInterval(t), 5000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, []);
  return avail;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const explorerTx = (sig: string, cluster: string) => `https://explorer.solana.com/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
export const explorerAddr = (a: string, cluster: string) => `https://explorer.solana.com/address/${a}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

/**
 * Signs a server-prepared transaction (optionally co-signing with a local ephemeral keypair such as a
 * fresh mint), submits the exact bytes, then polls confirmation. Returns the real signature.
 */
export async function signSubmitConfirm(
  kind: WalletKind,
  prep: { preparationId: string; transaction: string },
  opts: { coSign?: { publicKey: unknown; secretKey: Uint8Array }[]; onStatus?: (s: string) => void; guard?: () => boolean; signal?: AbortSignal } = {},
) {
  return guardedSignSubmit<Transaction>(prep, {
    decode: (t) => Transaction.from(fromB64(t)),
    feePayer: (tx) => tx.feePayer?.toBase58(),
    connect: () => connectWallet(kind),
    coSign: opts.coSign?.length ? (tx) => tx.partialSign(...(opts.coSign as any)) : undefined,
    sign: (tx) => walletSignTransaction(kind, tx),
    serialize: (tx) => b64(tx.serialize()),
    submit: (transaction) => pqSubmit({ data: { preparationId: prep.preparationId, transaction } }) as any,
    confirm: () => pqConfirm({ data: { preparationId: prep.preparationId } }) as any,
    watchAccount: (cb) => {
      const p = getProvider(kind) as any; if (!p?.on) return () => {};
      const onAcct = (pk: any) => cb(pk == null ? null : typeof pk === "string" ? pk : typeof pk?.toBase58 === "function" ? pk.toBase58() : undefined);
      const onDisc = () => cb(null);
      p.on("accountChanged", onAcct); p.on("disconnect", onDisc);
      return () => { const off = (p.off ?? p.removeListener)?.bind(p); off?.("accountChanged", onAcct); off?.("disconnect", onDisc); };
    },
  }, { onStatus: opts.onStatus, guard: opts.guard, signal: opts.signal });
}

export function WalletButtons({ avail, busy, disabled, action, onPick }: { avail: Record<WalletKind, boolean>; busy: string | null; disabled?: boolean; action: string; onPick: (k: WalletKind) => void }) {
  return <div className="flex flex-wrap items-center gap-2">
    {(["phantom", "solflare"] as const).map(k => <button key={k} type="button" className="btn btn-red" disabled={!avail[k] || !!busy || disabled} onClick={() => onPick(k)}>{busy && avail[k] ? busy : `${action} ${k === "phantom" ? "Phantom" : "Solflare"}`}</button>)}
    {!avail.phantom && !avail.solflare && <p className="text-xs text-ink-soft">No Solana wallet detected. Install Phantom or Solflare, then reload. Fleuri never asks for a seed phrase.</p>}
  </div>;
}

export interface PendingPreparation { id:string; kind:string; cluster:string; signature:string; subject:string; expires_at:string; }
export interface PqMine {identities:any[]; launches:any[]; preparations:PendingPreparation[];}
export function PendingTransactions({rows,onRefresh}:{rows:PendingPreparation[];onRefresh:()=>Promise<void>}) {
  const [busy,setBusy]=useState<string|null>(null);
  const [result,setResult]=useState<string|null>(null);
  async function recover(row:PendingPreparation, rebroadcast:boolean) {
    setBusy(row.id); setResult(null);
    try {
      if(rebroadcast) {const r=await pqRetry({data:{preparationId:row.id}}); if(!r.ok) throw new Error(r.error);}
      const c=await pqConfirm({data:{preparationId:row.id}});
      if(!c.ok) throw new Error(c.error);
      setResult(c.data.detail); await onRefresh();
    } catch(e) {setResult((e as Error).message); await onRefresh();}
    finally {setBusy(null);}
  }
  if(!rows.length) return null;
  return <Panel title="Pending transactions · recover safely">
    <p className="text-xs text-ink-soft">Check confirmation after a network error. Retry sends the same signed bytes and signature; it does not create a second launch. An expired blockhash cannot be rebroadcast.</p>
    {rows.map(row=><div key={row.id} className="hair space-y-2 p-3">
      <p className="text-sm font-semibold">{row.kind} · {row.cluster}</p>
      <a className="block break-all font-mono text-xs underline" href={explorerTx(row.signature,row.cluster)} target="_blank" rel="noreferrer">{row.signature}</a>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-paper" disabled={!!busy} onClick={()=>void recover(row,false)}>Check confirmation</button>
        <button type="button" className="btn btn-ink" disabled={!!busy} onClick={()=>void recover(row,true)}>{busy===row.id?"Checking…":"Retry exact transaction"}</button>
      </div>
    </div>)}
    {result && <p role="status" className="break-words text-sm">{result}</p>}
  </Panel>;
}

export function downloadPassport(p:SignedPassportT) {
  downloadBlob(new Blob([JSON.stringify(p,null,2)],{type:"application/json"}),`fleuri-passport-${p.manifestHash}.json`);
}

export const lifecycleLabel:Record<string,string> = {curve_active:"Curve growing",curve_completed:"Curve completed",migration_pending:"Migration pending",damm_v2_live:"Live on DAMM v2"};
function units(raw:string,decimals:number) { const padded=raw.padStart(decimals+1,"0"); const whole=padded.slice(0,-decimals).replace(/\B(?=(\d{3})+(?!\d))/g,","); const fraction=padded.slice(-decimals).replace(/0+$/,""); return `${whole}${fraction?"."+fraction:""}`; }
export function PassportTerms({manifest:m}:{manifest:PassportManifest}) {
  const values:[string,string][]=[
    ["Token",`${m.token.name} · $${m.token.symbol}`], ["Supply cap",`${units(m.token.totalSupply,m.token.decimals)} · ${m.token.decimals} decimals`],
    ...(m.token.website?[["Website",m.token.website] as [string,string]]:[]),
    ...(m.token.twitter?[["Twitter / X",m.token.twitter] as [string,string]]:[]),
    ["Initial base fee (rounded)",`${m.fees.baseFeeBps} bps · dynamic fees ${m.fees.dynamicFeeEnabled?"enabled":"off"}`],
    ["Trading split after protocol",`creator ${m.fees.creatorTradingFeePercent}% · partner ${m.fees.partnerTradingFeePercent}%`],
    ["Pool creation fee",`${units(m.fees.poolCreationFeeLamports,9)} SOL + network/rent costs`],
    ["Creator LP",`${m.lp.creatorLiquidityPercent}% withdrawable · ${m.lp.creatorPermanentLockedPercent}% permanently locked`],
    ["Partner LP",`${m.lp.partnerLiquidityPercent}% withdrawable · ${m.lp.partnerPermanentLockedPercent}% permanently locked`],
    ["Graduation",`DAMM v2 at ${units(m.migration.quoteThresholdLamports,9)} SOL quote reserve`],
    ["Migration fee",`${m.migration.migrationFeePercent}% · creator share ${m.migration.creatorMigrationFeePercent}% · option ${m.migration.migrationFeeOption}`],
    ["Migrated pool fee",`${m.migration.migratedPoolFeeBps} bps`], ["Authorities","Immutable metadata · mint and freeze authorities revoked"],
    ["Dev buy","Disabled"], ["Creator wallet",m.creatorWallet], ["Fee claimer",m.fees.feeClaimer], ["Leftover receiver",m.authority.leftoverReceiver],
    ["Mint",m.token.baseMint], ["DBC config",m.config.address], ["DBC pool",m.pool.address], ["Image",m.token.imageUri],
  ];
  return <div className="space-y-3">
    <dl className="hair divide-y divide-ink/20">{values.map(([label,value])=><div key={label} className="grid gap-1 p-2 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="font-mono text-[0.65rem] uppercase text-ink-soft">{label}</dt><dd className="min-w-0 break-all text-sm">{/^https?:\/\//.test(value)?<a className="underline" href={value} target="_blank" rel="noreferrer">{value}</a>:value}</dd></div>)}</dl>
    <p className="text-xs text-ink-soft">{m.authority.policy}</p>
    <details className="hair p-2"><summary className="cursor-pointer font-mono text-xs">Complete signed config snapshot</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-[0.65rem]">{JSON.stringify(m.config.snapshot,null,2)}</pre></details>
  </div>;
}
