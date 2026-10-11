import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel, PendingTransactions, WalletButtons, explorerAddr, type PendingPreparation } from "@/components/pq/ui";
import { formatUnits } from "@/pq/pollen";
import { DEFAULT_TERM_SECONDS } from "@/pq/staking";
import { POLL_MS, displayChecks, freshness, gates, ownPosition, reviewLines, type Snapshot } from "@/pq/staking-view";
import type { WalletKind } from "@/services/wallet";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };
export type StakingApi = {
  state: (wallet: string | null) => Promise<Res<any>>;
  prepare: (input: { wallet: string; action: string; amount?: string }) => Promise<Res<any>>;
  mine: () => Promise<Res<{ preparations: PendingPreparation[] }>>;
  sign: (kind: WalletKind, prep: any, onStatus: (s: string) => void) => Promise<{ detail: string }>;
  connect: (kind: WalletKind) => Promise<string>;
};

const days = (s: number | string) => `${(Number(s) / 86_400).toLocaleString(undefined, { maximumFractionDigits: 2 })} days`;
const wsol = (v?: string | null) => (v == null ? "—" : `${formatUnits(v, 9)} wSOL`);
const fl = (v?: string | null) => (v == null ? "—" : `${formatUnits(v, 6)} FLEURI`);
function toUnits(t: string) { const m = t.trim().match(/^(\d{1,13})(?:\.(\d{1,6}))?$/); if (!m) throw new Error("Enter a plain amount with at most 6 decimals."); const v = BigInt(m[1] + (m[2] ?? "").padEnd(6, "0")); if (v <= 0n) throw new Error("Amount must be greater than zero."); return v.toString(); }
function countdown(sec: number) { if (sec <= 0) return "ready"; const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return `${d}d ${h}h ${m}m`; }

export function StakingView({ api, userId, onOpenWorkspace, wallets, pollMs = POLL_MS }: { api: StakingApi; userId: string | null; onOpenWorkspace: () => Promise<void>; wallets: Record<WalletKind, boolean>; pollMs?: number }) {
  const [wallet, setWallet] = useState<{ kind: WalletKind; address: string } | null>(null);
  const [st, setSt] = useState<Snapshot | null>(null); const [readErr, setReadErr] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [amount, setAmount] = useState(""); const [unAmount, setUnAmount] = useState("");
  const [pending, setPending] = useState<PendingPreparation[]>([]);
  const [review, setReview] = useState<{ prep: any; resolve: (ok: boolean) => void } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0); const inflight = useRef(false); const walletRef = useRef<string | null>(null);

  /** One read at a time; results from older requests or another wallet are dropped. */
  const load = useCallback(async (force = false) => {
    if (inflight.current && !force) return;
    inflight.current = true; setReading(true);
    const my = ++seq.current; const w = walletRef.current;
    try {
      const r = await api.state(w);
      if (my !== seq.current || w !== walletRef.current) return;
      if (r.ok) { setSt({ ...r.data, fetchedAt: Date.now(), wallet: w }); setReadErr(""); } else setReadErr(r.error);
    } catch (e) { if (my === seq.current) setReadErr((e as Error).message || "Read failed"); }
    finally { if (my === seq.current) { inflight.current = false; setReading(false); setNow(Date.now()); } }
  }, [api]);
  const loadPending = useCallback(async () => {
    if (!userId) { setPending([]); return; }
    const r = await api.mine().catch(() => null);
    if (r?.ok) setPending(r.data.preparations.filter((p) => p.kind.startsWith("staking_")));
  }, [api, userId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadPending(); }, [loadPending]);
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); }, 5_000);
    const p = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") void load(); }, pollMs);
    const vis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); clearInterval(p); document.removeEventListener("visibilitychange", vis); };
  }, [load, pollMs]);

  function switchWallet(next: { kind: WalletKind; address: string } | null) {
    walletRef.current = next?.address ?? null; setWallet(next);
    setSt((s) => (s ? { ...s, wallet: null, position: undefined, balances: undefined } : s));
    setMsg(""); setErr(""); void load(true);
  }

  async function run(label: string, f: () => Promise<void>) { setBusy(label); setErr(""); setMsg(""); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } }
  async function act(action: string, amt?: string) {
    await run("Building and simulating…", async () => {
      const p = await api.prepare({ wallet: wallet!.address, action, ...(amt ? { amount: amt } : {}) });
      if (!p.ok) throw new Error(p.error);
      setBusy("Review before signing");
      const ok = await new Promise<boolean>((resolve) => setReview({ prep: p.data, resolve }));
      setReview(null);
      if (!ok) { setMsg("Cancelled. Nothing was signed."); return; }
      const r = await api.sign(wallet!.kind, p.data, setBusy);
      setMsg(r.detail);
    });
    await Promise.all([load(true), loadPending()]);
  }

  const g = gates(st, wallet?.address ?? null, now, readErr);
  const fr = freshness(st, now, readErr);
  const pos = ownPosition(st, wallet?.address ?? null); const L = st?.pool?.ledger;
  const chainNow = st?.chainTime ? st.chainTime + Math.floor((now - st.fetchedAt) / 1000) : null;
  const pendingLeft = pos && BigInt(pos.pendingAmount) > 0n && chainNow ? Number(pos.unlockTs) - chainNow : null;
  const wrongNet = st && st.cluster !== "mainnet-beta";
  const notDeployed = st && (!st.programId || st.programId === st.placeholder);
  const dis = !!busy || !userId;

  return <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <p className="max-w-prose text-sm">Stake $FLEURI to share <strong>wrapped SOL actually received</strong> from one fixed <Link to="/pollen" className="underline">Pollen</Link> fee-sharing vault. There are no new FLEURI emissions and no fixed APY: if nothing arrives, nothing is paid. Received funds are released over {days(DEFAULT_TERM_SECONDS)} (proposed default); top-ups during an open window finish by that same deadline, so nobody can delay rewards. Rewards held while nobody was staked resume automatically for the first staker. Unstaking has a {days(DEFAULT_TERM_SECONDS)} cooldown. This layer extends Pollen's 2–5 recipient cap to any number of stakers.</p>
      <FlowerTiles count={4} cols={4} className="w-40" />
    </div>

    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" className="btn btn-paper" disabled={reading} onClick={() => void load(true)}>{reading ? "Reading chain…" : "Refresh"}</button>
      <span role="status" aria-label="freshness" className={fr.stale ? "text-poppy-deep" : ""}>{fr.stale ? `Stale: ${fr.reason}` : fr.reason} Auto-refresh every {Math.round(pollMs / 1000)}s while this tab is visible.</span>
    </div>

    {!st && !readErr && <Panel title="Reading the chain"><p className="text-sm">Loading live program, mint and pool state…</p></Panel>}
    {!st && readErr && <Panel title="Chain unavailable"><p className="text-sm text-poppy-deep" role="alert">{readErr}</p></Panel>}

    {review && <Panel title="Review before signing">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">{reviewLines(review.prep).map(([k, v]) => <div key={k} className="contents"><dt className="text-xs">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>)}</dl>
      <p className="text-xs">The simulation passed. Your wallet will show the same transaction; fleuri never signs for you.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-red" onClick={() => review.resolve(true)}>Sign in wallet</button><button type="button" className="btn btn-paper" onClick={() => review.resolve(false)}>Cancel</button></div>
    </Panel>}

    <PendingTransactions rows={pending} onRefresh={async () => { await Promise.all([loadPending(), load(true)]); }} />

    {st && <>
      {(notDeployed || wrongNet || fr.stale) && <Panel title="Status">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {notDeployed && <li><strong>Not deployed.</strong> The program source and tests exist, but no Pollen Staking program is deployed or configured for fleuri yet. Deposits are off.</li>}
          {wrongNet && <li><strong>Wrong network.</strong> This server reads {st.cluster ?? "an invalid cluster"}; $FLEURI lives on Solana mainnet.</li>}
          {fr.stale && <li><strong>Stale data.</strong> {fr.reason} Actions stay off until a fresh read.</li>}
        </ul>
      </Panel>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Deposit readiness">
          <ul className="space-y-1 text-sm">
            {displayChecks(st, now, readErr).map((c) => <li key={c.id} className="flex gap-2"><span aria-hidden className={c.ok ? "text-sprout" : "text-poppy-deep"}>{c.ok ? "✓" : "✕"}</span><span className="min-w-0 [overflow-wrap:anywhere]"><strong>{c.label}.</strong> {c.detail}</span></li>)}
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
            <dt>Upgrade</dt><dd className="[overflow-wrap:anywhere]">{st.facts?.programUpgradeable == null ? "unknown" : st.facts.programUpgradeable ? `upgradeable by ${st.facts.upgradeAuthority}` : "immutable"}</dd>
            {L && <><dt>Release</dt><dd>{days(L.duration)}</dd><dt>Cooldown</dt><dd>{days(L.cooldown)}</dd><dt>Current window ends</dt><dd>{Number(L.streamEnd) > 0 ? new Date(Number(L.streamEnd) * 1000).toUTCString() : "—"}</dd></>}
            <dt>Fee source</dt><dd className="[overflow-wrap:anywhere]">{st.feeSource ? <a className="font-mono text-xs underline" href={explorerAddr(st.feeSource.address, st.cluster)} target="_blank" rel="noreferrer">{st.feeSource.address} ↗</a> : "none"}</dd>
            {st.feeSource && <><dt>Pollen claimable</dt><dd>{wsol(st.feeSource.unclaimedForPool)}</dd></>}
          </dl>
          <p className="text-xs">The existing $FLEURI bonding-curve pool uses a config fleuri does not control, so its fees are not routed here. A Pollen vault can also be funded manually, so a received claim proves Pollen funding, not that it came from DBC/DAMM trading fees. Trading origin stays unverified unless individual route funding is proven.</p>
          <button type="button" className="btn btn-ink" disabled={dis || !wallet || !g.harvest} title={!g.harvest ? "Needs a ready program and fee source, a fresh read and a positive Pollen claimable balance" : ""} onClick={() => void act("harvest")}>Collect Pollen rewards</button>
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
        {!userId && <div className="space-y-2"><p className="text-sm">Open a workspace so prepared transactions can be recovered.</p><button className="btn btn-ink" disabled={!!busy} onClick={() => void run("Opening…", onOpenWorkspace)}>Open workspace</button></div>}
        {!wallet ? <WalletButtons avail={wallets} busy={busy} action="Connect" onPick={(k) => void run("Connecting…", async () => { const a = await api.connect(k); switchWallet({ kind: k, address: a }); })} />
          : <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="[overflow-wrap:anywhere]">Wallet <span className="font-mono text-xs">{wallet.address}</span></span><button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => switchWallet(null)}>Disconnect</button></div>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><dt className="text-xs">Wallet FLEURI</dt><dd>{st.wallet === wallet.address ? fl(st.balances?.fleuri) : "…"}</dd></div>
              <div><dt className="text-xs">Active stake</dt><dd>{pos ? fl(pos.active) : st.wallet === wallet.address ? "none" : "…"}</dd></div>
              <div><dt className="text-xs">Claimable now</dt><dd data-testid="claimable">{pos?.claimable != null ? wsol(pos.claimable) : "—"}</dd></div>
              <div><dt className="text-xs">Pending withdrawal</dt><dd>{pos && BigInt(pos.pendingAmount) > 0n ? <>{fl(pos.pendingAmount)} · {pendingLeft != null ? countdown(pendingLeft) : "…"}</> : "none"}</dd></div>
            </dl>
            {!st.pool && <p>No pool to stake into yet.</p>}
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-col text-xs">Stake amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="hair w-40 bg-paper-light px-2 py-2 text-sm" placeholder="0.0" /></label>
              <button className="btn btn-red" disabled={dis || !g.stake || !amount} title={!g.stake ? "Blocked until all readiness checks pass" : ""} onClick={() => { try { void act("stake", toUnits(amount)); } catch (e) { setErr((e as Error).message); } }}>Stake</button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-col text-xs">Unstake amount<input inputMode="decimal" value={unAmount} onChange={(e) => setUnAmount(e.target.value)} className="hair w-40 bg-paper-light px-2 py-2 text-sm" placeholder="0.0" /></label>
              <button className="btn btn-ink" disabled={dis || !g.exits || !pos || BigInt(pos.pendingAmount) > 0n || !unAmount} title={pos && BigInt(pos.pendingAmount) > 0n ? "One pending withdrawal at a time" : ""} onClick={() => { try { void act("request_unstake", toUnits(unAmount)); } catch (e) { setErr((e as Error).message); } }}>Request unstake</button>
              <button className="btn btn-paper" disabled={dis || !g.exits || !pos || BigInt(pos.pendingAmount) === 0n} onClick={() => void act("cancel_unstake")}>Cancel unstake</button>
              <button className="btn btn-paper" disabled={dis || !g.exits || pendingLeft == null || pendingLeft > 0} onClick={() => void act("withdraw")}>Withdraw</button>
              <button className="btn btn-red" disabled={dis || !g.claim} onClick={() => void act("claim")}>Claim wSOL</button>
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
