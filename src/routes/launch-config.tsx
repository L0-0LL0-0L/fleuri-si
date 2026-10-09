import { createFileRoute, Link } from "@tanstack/react-router";
import { Keypair } from "@solana/web3.js";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/bits";
import { Panel, PendingTransactions, RealBadge, WalletButtons, explorerAddr, signSubmitConfirm, useWallets, type PqMine } from "@/components/pq/ui";
import { getPqReadiness, pqMine, pqPrepareConfig } from "@/lib/pq.functions";
import { FEE_PRESET_BPS, parseDraft, type ConfigDraftT, type ExpectedTerms } from "@/pq/config-draft";
import { connectWallet, type WalletKind } from "@/services/wallet";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/launch-config")({
  head: () => ({
    meta: [
      { title: "Pool config — fleuri launchpad" },
      { name: "description", content: "Review and wallet-sign the Meteora bonding-curve config that every Fleuri launch uses." },
      { property: "og:title", content: "Pool config — fleuri launchpad" },
      { property: "og:description", content: "Review exact fees, supply, graduation, LP shares and recipients, then sign with your own wallet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ConfigPage,
});

type Prepared = { preparationId: string; transaction: string; cluster: string; config: string; expected: ExpectedTerms; cost: { ok: boolean; error?: string; balanceLamports: number; simulatedChangeLamports?: number; networkFeeLamports?: number } };
const sol = (l?: number) => (l == null ? "—" : `${(l / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`);
const num = (label: string, v: number, set: (n: number) => void, opts: { min?: number; max?: number; step?: number } = {}) => (
  <label className="text-sm font-semibold">{label}<input type="number" required value={Number.isFinite(v) ? v : ""} min={opts.min} max={opts.max} step={opts.step ?? 1} onChange={(e) => set(e.target.valueAsNumber)} className="hair mt-1 h-11 w-full bg-paper-light px-3 font-mono" /></label>
);

function ConfigPage() {
  const { userId, store } = useGarden();
  const wallets = useWallets();
  const cfgKey = useRef<Keypair | null>(null);
  const [cluster, setCluster] = useState<string>();
  const [configured, setConfigured] = useState<string | null>(null);
  const [wallet, setWallet] = useState<{ kind: WalletKind; address: string } | null>(null);
  const [d, setD] = useState<ConfigDraftT>({ decimals: 6, totalSupply: 1_000_000_000, percentageSupplyOnMigration: 20, migrationThresholdSol: 85, baseFeeBps: 100, creatorTradingFeePercent: 50, migrationFeeOption: 2, lp: { partnerClaimable: 0, partnerLocked: 50, creatorClaimable: 0, creatorLocked: 50 }, feeClaimer: "", leftoverReceiver: "" });
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ address: string; detail: string } | null>(null);
  const [mine, setMine] = useState<PqMine | null>(null);

  const refresh = async () => { if (store.get().userId) { const r = await pqMine(); if (r.ok) setMine(r.data); } };
  useEffect(() => { void getPqReadiness().then((r) => { if (r.ok) { setCluster(r.data.cluster); setConfigured(r.data.dbcConfig); } }); }, []);
  useEffect(() => { void refresh(); }, [userId]);
  const set = <K extends keyof ConfigDraftT>(k: K) => (v: ConfigDraftT[K]) => { setD((x) => ({ ...x, [k]: v })); setPrepared(null); setAck(false); };
  const setLp = (k: keyof ConfigDraftT["lp"]) => (v: number) => { setD((x) => ({ ...x, lp: { ...x.lp, [k]: v } })); setPrepared(null); setAck(false); };
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(""); try { await fn(); } catch (e) { setError((e as Error).message); await refresh().catch(() => {}); } finally { setBusy(null); } };

  async function connect(kind: WalletKind) { const address = await connectWallet(kind); setWallet({ kind, address }); setPrepared(null); }
  async function review() {
    if (!wallet) throw new Error("Connect the wallet that will pay for the config first.");
    const draft = parseDraft(d);
    cfgKey.current = Keypair.generate();
    const r = await pqPrepareConfig({ data: { wallet: wallet.address, config: cfgKey.current.publicKey.toBase58(), draft } });
    if (!r.ok) throw new Error(r.error);
    setPrepared(r.data); setAck(false);
  }
  async function sign() {
    if (!prepared || !cfgKey.current || !wallet) throw new Error("Review the prepared config first.");
    const r = await signSubmitConfirm(wallet.kind, prepared, { coSign: [cfgKey.current], onStatus: setBusy });
    cfgKey.current.secretKey.fill(0); cfgKey.current = null;
    setDone({ address: prepared.config, detail: r.detail }); setPrepared(null); toast.success("Config confirmed on chain."); await refresh();
  }
  const e = prepared?.expected;

  return (
    <div className="space-y-5">
      <PageHeader title="set the soil." kicker="fleuri · meteora pool config"><RealBadge cluster={cluster} /></PageHeader>
      <p className="hair bg-paper-light p-3 text-sm">Every launch uses one Meteora bonding-curve config. Here you choose its exact terms, review them, and sign with your own wallet. A fresh config key is made on this device and only co-signs; nothing is sent until your wallet approves. {configured ? <>A config is already set: <span className="break-all font-mono text-xs">{configured}</span>.</> : "No config is set yet, so launching is blocked."} <Link to="/launchpad" className="font-semibold underline">Back to launchpad</Link></p>

      {!userId && <Panel title="Your workspace"><p className="text-sm">Open your workspace so the prepared transaction is tied to you.</p><button type="button" className="btn btn-ink" disabled={!!busy} onClick={() => void run("Opening workspace…", async () => { await store.startSandbox(); await refresh(); })}>{busy ?? "Open workspace"}</button></Panel>}

      {done ? (
        <Panel title="Config confirmed">
          <p className="display text-2xl">the soil is ready.</p>
          <p className="text-sm">{done.detail}</p>
          <p className="break-all font-mono text-xs">{done.address}</p>
          <a className="text-sm underline" href={explorerAddr(done.address, cluster ?? "mainnet-beta")} target="_blank" rel="noreferrer">Inspect the account ↗</a>
          <p className="text-sm">Last step: save this address as the project setting <span className="font-mono">METEORA_DBC_CONFIG</span> (ask in chat and the secure form opens), then recheck readiness on the launchpad.</p>
          <button type="button" className="btn btn-paper" onClick={() => void navigator.clipboard.writeText(done.address).then(() => toast.success("Address copied"))}>Copy address</button>
        </Panel>
      ) : (
        <Panel title="1 · Wallet">
          {wallet ? <p className="break-all text-sm">Connected {wallet.kind}: <span className="font-mono text-xs">{wallet.address}</span></p> : <p className="text-sm">The connected wallet pays rent and network fees.</p>}
          <WalletButtons avail={wallets} busy={busy} action={wallet ? "Switch to" : "Connect"} onPick={(k) => void run("Connecting wallet…", () => connect(k))} />
        </Panel>
      )}

      {!done && <Panel title="2 · Terms">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(ev) => { ev.preventDefault(); void run("Building the exact Meteora transaction…", review); }}>
          {num("Token decimals (6–9)", d.decimals, set("decimals"), { min: 6, max: 9 })}
          {num("Total supply (whole tokens)", d.totalSupply, set("totalSupply"), { min: 1_000_000 })}
          {num("Trading fee (bps, 100 = 1%)", d.baseFeeBps, set("baseFeeBps"), { min: 25, max: 1000 })}
          {num("Creator share of trading fees (%)", d.creatorTradingFeePercent, set("creatorTradingFeePercent"), { min: 0, max: 100 })}
          {num("Graduation threshold (SOL raised)", d.migrationThresholdSol, set("migrationThresholdSol"), { min: 1, step: 0.1 })}
          {num("Supply left for the DAMM v2 pool (%)", d.percentageSupplyOnMigration, set("percentageSupplyOnMigration"), { min: 1, max: 50 })}
          <label className="text-sm font-semibold sm:col-span-2">DAMM v2 pool fee after graduation
            <select value={d.migrationFeeOption} onChange={(ev) => set("migrationFeeOption")(Number(ev.target.value))} className="hair mt-1 h-11 w-full bg-paper-light px-3">{FEE_PRESET_BPS.map((b, i) => <option key={b} value={i}>{b} bps ({b / 100}%)</option>)}</select>
          </label>
          <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-4"><legend className="text-sm font-semibold">LP after graduation (must total 100%, at least 10% locked)</legend>
            {num("Your platform · claimable", d.lp.partnerClaimable, setLp("partnerClaimable"), { min: 0, max: 100 })}
            {num("Your platform · locked", d.lp.partnerLocked, setLp("partnerLocked"), { min: 0, max: 100 })}
            {num("Token creator · claimable", d.lp.creatorClaimable, setLp("creatorClaimable"), { min: 0, max: 100 })}
            {num("Token creator · locked", d.lp.creatorLocked, setLp("creatorLocked"), { min: 0, max: 100 })}
          </fieldset>
          {(["feeClaimer", "leftoverReceiver"] as const).map((k) => (
            <label key={k} className="text-sm font-semibold sm:col-span-2">{k === "feeClaimer" ? "Fee recipient (claims your platform's trading fees)" : "Leftover token recipient"}
              <div className="mt-1 flex flex-wrap gap-2"><input required value={d[k]} onChange={(ev) => set(k)(ev.target.value.trim())} className="hair h-11 min-w-0 flex-1 bg-paper-light px-3 font-mono text-xs" placeholder="Solana address" />
                {wallet && <button type="button" className="btn btn-paper" onClick={() => set(k)(wallet.address)}>Use my wallet</button>}</div>
            </label>
          ))}
          <p className="text-xs text-ink-soft sm:col-span-2">Fixed for every config: SOL quote, standard SPL token, immutable metadata, fixed supply, revoked mint and freeze authorities, graduation to DAMM v2, no pool creation fee, no vesting.</p>
          <button type="submit" className="btn btn-red sm:col-span-2" disabled={!!busy || !wallet || !userId}>{busy ?? "Review exact config"}</button>
        </form>
      </Panel>}

      {prepared && e && (
        <Panel title="3 · Review and sign">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            {([
              ["Network", prepared.cluster],
              ["New config address", prepared.config],
              ["Payer", wallet?.address],
              ["Supply (raw units)", `${e.totalSupply} · ${e.decimals} decimals`],
              ["Trading fee", `${e.baseFeeBps} bps · creator ${e.creatorTradingFeePercent}% / platform ${e.partnerTradingFeePercent}%`],
              ["Graduation", `${Number(e.quoteThresholdLamports) / 1e9} SOL (${e.quoteThresholdLamports} lamports) → DAMM v2 at ${e.migratedPoolFeeBps} bps`],
              ["LP", `platform ${e.lp.partnerLiquidityPercent}% claimable + ${e.lp.partnerPermanentLockedPercent}% locked · creator ${e.lp.creatorLiquidityPercent}% claimable + ${e.lp.creatorPermanentLockedPercent}% locked`],
              ["Fee recipient", e.feeClaimer + (e.feeClaimer === wallet?.address ? " (your wallet)" : "")],
              ["Leftover recipient", e.leftoverReceiver + (e.leftoverReceiver === wallet?.address ? " (your wallet)" : "")],
              ["Wallet balance", sol(prepared.cost.balanceLamports)],
              ["Simulated cost", prepared.cost.ok ? `${sol(prepared.cost.simulatedChangeLamports)} (account rent) · network fee ${sol(prepared.cost.networkFeeLamports)}` : prepared.cost.error],
            ] as const).map(([k, v]) => <div key={k} className="contents"><dt className="font-semibold">{k}</dt><dd className="break-all font-mono text-xs">{v}</dd></div>)}
          </dl>
          {!prepared.cost.ok && <p role="alert" className="text-sm text-poppy-deep">Simulation failed, so signing is disabled. Usually the wallet needs more SOL.</p>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(ev) => setAck(ev.target.checked)} /><span>I checked every term and both recipient addresses above. This config cannot be edited after it is created.</span></label>
          <button type="button" className="btn btn-red" disabled={!ack || !prepared.cost.ok || !!busy} onClick={() => void run("Preparing signature…", sign)}>{busy ?? `Sign with ${wallet?.kind}`}</button>
          <p className="text-xs text-ink-soft">This prepared transaction expires in about 90 seconds. If it expires, review again to rebuild it.</p>
        </Panel>
      )}

      {error && <p role="alert" className="hair break-words bg-paper-light p-3 text-sm text-poppy-deep">{error}</p>}
      {mine && <PendingTransactions rows={mine.preparations} onRefresh={refresh} />}
    </div>
  );
}
