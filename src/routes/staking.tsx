import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel, RealBadge, WalletButtons, explorerAddr, signSubmitConfirm, useWallets } from "@/components/pq/ui";
import { stakingPrepare, stakingState } from "@/lib/pq.functions";
import { connectWallet, type WalletKind } from "@/services/wallet";
import { useGarden } from "@/store/garden";
import { formatUnits } from "@/pq/pollen";
import { DEFAULT_TERM_SECONDS, blockers } from "@/pq/staking";

export const Route = createFileRoute("/staking")({
  head: () => ({ meta: [
    { title: "Pollen Staking · stake $FLEURI for Pollen-funded wSOL — fleuri" },
    { name: "description", content: "Stake $FLEURI and share Pollen-funded wrapped SOL rewards. No emissions, no fixed APY. Deposits open only after every chain check passes." },
    { property: "og:title", content: "Pollen Staking — fleuri" },
    { property: "og:description", content: "Stake $FLEURI for a share of Pollen-funded wSOL. Live chain checks, no fabricated yields." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: StakingPage,
});

const FL = 6; // FLEURI decimals (verified on chain)
const days = (s: number | string) => `${(Number(s) / 86_400).toLocaleString(undefined, { maximumFractionDigits: 2 })} days`;
const wsol = (v?: string | null) => (v == null ? "—" : `${formatUnits(v, 9)} wSOL`);
const fl = (v?: string | null) => (v == null ? "—" : `${formatUnits(v, FL)} FLEURI`);
function toUnits(t: string) { const m = t.trim().match(/^(\d{1,13})(?:\.(\d{1,6}))?$/); if (!m) throw new Error("Enter a plain amount with at most 6 decimals."); const v = BigInt(m[1] + (m[2] ?? "").padEnd(6, "0")); if (v <= 0n) throw new Error("Amount must be greater than zero."); return v.toString(); }
function countdown(sec: number) { if (sec <= 0) return "ready"; const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return `${d}d ${h}h ${m}m`; }

function StakingPage() {
  const { userId, store } = useGarden();
  const wallets = useWallets();
  const [wallet, setWallet] = useState<{ kind: WalletKind; address: string } | null>(null);
  const [st, setSt] = useState<any>(null); const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [amount, setAmount] = useState(""); const [unAmount, setUnAmount] = useState("");
  const [tick, setTick] = useState(0);
  const load = async (w = wallet?.address ?? null) => { const r = await stakingState({ data: { wallet: w } }); if (r.ok) { setSt({ ...r.data, fetchedAt: Date.now() }); setLoadErr(""); } else setLoadErr(r.error); };
  useEffect(() => { void load(); }, []);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  async function run(label: string, f: () => Promise<void>) { setBusy(label); setErr(""); setMsg(""); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } }
  async function act(action: string, amt?: string) {
    await run("Building and simulating…", async () => {
      const p = await stakingPrepare({ data: { wallet: wallet!.address, action: action as any, ...(amt ? { amount: amt } : {}) } });
      if (!p.ok) throw new Error(p.error);
      if (!confirm(`Review: ${action.replace("_", " ")}${p.data.review.amount ? ` ${action === "stake" || action === "request_unstake" ? fl(p.data.review.amount) : p.data.review.amount}` : ""} on ${p.data.cluster}, program ${p.data.review.programId}. The simulation passed. Sign with your wallet?`)) return;
      const r = await signSubmitConfirm(wallet!.kind, p.data, { onStatus: setBusy });
      setMsg(r.detail); await load(wallet!.address);
    });
  }
  // Chain time advances from the last RPC read; the program enforces the real clock.
  const chainNow = st?.chainTime ? st.chainTime + Math.floor((Date.now() - st.fetchedAt) / 1000) : null;
  void tick;
  const pos = st?.position; const L = st?.pool?.ledger;
  const pendingLeft = pos && Number(pos.pendingAmount) > 0 && chainNow ? Number(pos.unlockTs) - chainNow : null;
  const exitsOk = !!st?.checks && blockers("withdraw", st.checks).length === 0; // exits ignore deposit-only checks
  const wrongNet = st && st.cluster !== "mainnet-beta";
  const notDeployed = st && (!st.programId || st.programId === st.placeholder);
  const stale = st && st.checks?.find((c: any) => c.id === "rpc" && !c.ok);

  return <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
    <PageHeader title="pollen staking" kicker="Stake $FLEURI · share Pollen-funded wSOL"><RealBadge cluster={st?.cluster} /></PageHeader>
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <p className="max-w-prose text-sm">Stake $FLEURI to share <strong>wrapped SOL actually received</strong> from one fixed <Link to="/pollen" className="underline">Pollen</Link> fee-sharing vault. There are no new FLEURI emissions and no fixed APY: if nothing arrives, nothing is paid. Received funds are released over {days(DEFAULT_TERM_SECONDS)} (proposed default); top-ups during an open window finish by that same deadline, so nobody can delay rewards. Unstaking has a {days(DEFAULT_TERM_SECONDS)} cooldown. This layer extends Pollen's 2–5 recipient cap to any number of stakers.</p>
      <FlowerTiles count={4} cols={4} className="w-40" />
    </div>

    {!st && !loadErr && <Panel title="Reading the chain"><p className="text-sm">Loading live program, mint and pool state…</p></Panel>}
    {loadErr && <Panel title="Chain unavailable"><p className="text-sm text-poppy-deep" role="alert">{loadErr}</p><button className="btn btn-paper" onClick={() => void load()}>Retry</button></Panel>}

    {st && <>
      {(notDeployed || wrongNet || stale) && <Panel title="Status">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {notDeployed && <li><strong>Not deployed.</strong> The program source and tests exist, but no Pollen Staking program is deployed or configured for fleuri yet. Deposits are off.</li>}
          {wrongNet && <li><strong>Wrong network.</strong> This server reads {st.cluster ?? "an invalid cluster"}; $FLEURI lives on Solana mainnet.</li>}
          {stale && <li><strong>Stale RPC.</strong> The latest block time could not be confirmed as recent; figures may be old.</li>}
        </ul>
      </Panel>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Deposit readiness">
          <ul className="space-y-1 text-sm">
            {st.checks.map((c: any) => <li key={c.id} className="flex gap-2"><span aria-hidden className={c.ok ? "text-sprout" : "text-poppy-deep"}>{c.ok ? "✓" : "✕"}</span><span className="min-w-0 [overflow-wrap:anywhere]"><strong>{c.label}.</strong> {c.detail}</span></li>)}
          </ul>
          <p className="text-xs">{st.depositsEnabled ? "All checks pass." : "Deposits stay blocked until every check passes."}</p>
        </Panel>
        <Panel title="Immutable terms & fee source">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt>Stake mint</dt><dd className="font-mono text-xs [overflow-wrap:anywhere]">{st.stakeMint}</dd>
            <dt>Mint authority</dt><dd>{st.mint ? (st.mint.mintAuthority ?? "revoked") : "unknown"}</dd>
            <dt>Freeze authority</dt><dd className="[overflow-wrap:anywhere]">{st.mint ? (st.mint.freezeAuthority ? <span className="text-poppy-deep">still set: {st.mint.freezeAuthority}</span> : "revoked") : "unknown"}</dd>
            <dt>Reward</dt><dd>wrapped SOL</dd>
            <dt>Program</dt><dd className="font-mono text-xs [overflow-wrap:anywhere]">{st.programId ?? "not configured"}</dd>
            <dt>Upgrade</dt><dd className="[overflow-wrap:anywhere]">{st.facts.programUpgradeable === null ? "unknown" : st.facts.programUpgradeable ? `upgradeable by ${st.facts.upgradeAuthority}` : "immutable"}</dd>
            {L && <><dt>Release</dt><dd>{days(L.duration)}</dd><dt>Cooldown</dt><dd>{days(L.cooldown)}</dd><dt>Current window ends</dt><dd>{Number(L.streamEnd) > 0 ? new Date(Number(L.streamEnd) * 1000).toUTCString() : "—"}</dd></>}
            <dt>Fee source</dt><dd className="[overflow-wrap:anywhere]">{st.feeSource ? <a className="font-mono text-xs underline" href={explorerAddr(st.feeSource.address, st.cluster)} target="_blank" rel="noreferrer">{st.feeSource.address} ↗</a> : "none"}</dd>
          </dl>
          <p className="text-xs">The existing $FLEURI bonding-curve pool uses a config fleuri does not control, so its fees are not routed here. A Pollen vault can also be funded manually, so a received claim proves Pollen funding, not that it came from DBC/DAMM trading fees. Trading origin stays unverified unless individual route funding is proven.</p>
        </Panel>
      </div>

      <Panel title="Pool totals">
        {L ? <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <div><dt className="text-xs">Active stake</dt><dd>{fl(L.totalActive)}</dd></div>
          <div><dt className="text-xs">Pollen-funded rewards</dt><dd>{wsol(L.dfsFundedTotal)}</dd></div>
          <div><dt className="text-xs">Treasury top-ups</dt><dd>{wsol(L.treasuryTotal)}</dd></div>
          <div><dt className="text-xs">Released to stakers</dt><dd>{wsol(L.distributedTotal)}</dd></div>
          <div><dt className="text-xs">Claimed</dt><dd>{wsol(L.claimedTotal)}</dd></div>
          <div><dt className="text-xs">Unallocated (no stakers)</dt><dd>{wsol(L.unallocated)}</dd></div>
        </dl> : <p className="text-sm">No pool exists yet. Nothing is staked and no rewards have been funded.</p>}
      </Panel>

      <Panel title="Your position">
        {!userId && <div className="space-y-2"><p className="text-sm">Open a workspace so prepared transactions can be recovered.</p><button className="btn btn-ink" disabled={!!busy} onClick={() => void run("Opening…", async () => { await store.startSandbox(); })}>Open workspace</button></div>}
        {!wallet ? <WalletButtons avail={wallets} busy={busy} action="Connect" onPick={(k) => void run("Connecting…", async () => { const a = await connectWallet(k); setWallet({ kind: k, address: a }); await load(a); })} />
          : <div className="space-y-3 text-sm">
            <p className="[overflow-wrap:anywhere]">Wallet <span className="font-mono text-xs">{wallet.address}</span></p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><dt className="text-xs">Wallet FLEURI</dt><dd>{fl(st.balances?.fleuri)}</dd></div>
              <div><dt className="text-xs">Active stake</dt><dd>{pos ? fl(pos.active) : "none"}</dd></div>
              <div><dt className="text-xs">Claimable now</dt><dd>{pos?.claimable != null ? wsol(pos.claimable) : "—"}</dd></div>
              <div><dt className="text-xs">Pending withdrawal</dt><dd>{pos && Number(pos.pendingAmount) > 0 ? <>{fl(pos.pendingAmount)} · {pendingLeft != null ? countdown(pendingLeft) : "…"}</> : "none"}</dd></div>
            </dl>
            {!st.pool && <p>No pool to stake into yet.</p>}
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-col text-xs">Stake amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="hair w-40 bg-paper-light px-2 py-2 text-sm" placeholder="0.0" /></label>
              <button className="btn btn-red" disabled={!!busy || !userId || !st.depositsEnabled || !amount} title={!st.depositsEnabled ? "Blocked until all readiness checks pass" : ""} onClick={() => { try { void act("stake", toUnits(amount)); } catch (e) { setErr((e as Error).message); } }}>Stake</button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-col text-xs">Unstake amount<input inputMode="decimal" value={unAmount} onChange={(e) => setUnAmount(e.target.value)} className="hair w-40 bg-paper-light px-2 py-2 text-sm" placeholder="0.0" /></label>
              <button className="btn btn-ink" disabled={!!busy || !userId || !exitsOk || !pos || Number(pos.pendingAmount) > 0 || !unAmount} title={pos && Number(pos.pendingAmount) > 0 ? "One pending withdrawal at a time" : ""} onClick={() => { try { void act("request_unstake", toUnits(unAmount)); } catch (e) { setErr((e as Error).message); } }}>Request unstake</button>
              <button className="btn btn-paper" disabled={!!busy || !userId || !exitsOk || !pos || Number(pos.pendingAmount) === 0} onClick={() => void act("cancel_unstake")}>Cancel unstake</button>
              <button className="btn btn-paper" disabled={!!busy || !userId || !exitsOk || pendingLeft == null || pendingLeft > 0} onClick={() => void act("withdraw")}>Withdraw</button>
              <button className="btn btn-red" disabled={!!busy || !userId || !exitsOk || !pos || !pos.claimable || pos.claimable === "0"} onClick={() => void act("claim")}>Claim wSOL</button>
            </div>
            <p className="text-xs">A requested unstake stops earning immediately. Withdraw and unstake never depend on Meteora fee collection.</p>
          </div>}
      </Panel>
    </>}
    {busy && <p role="status" className="text-sm">{busy}</p>}
    {msg && <p role="status" className="text-sm [overflow-wrap:anywhere]">{msg}</p>}
    {err && <p role="alert" className="text-sm text-poppy-deep [overflow-wrap:anywhere]">{err}</p>}
  </div>;
}
