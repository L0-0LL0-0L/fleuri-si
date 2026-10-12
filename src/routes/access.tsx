import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel } from "@/components/pq/ui";
import { accessRedeemReport, accessReports, accessStatus } from "@/lib/access.functions";
import { FLEURI_MINT } from "@/lib/token";
import { ACCESS_POLICY, REQUIRED_CHECKS, actionState, type AccessAction, type ActionState } from "@/pq/access";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/access")({
  head: () => ({ meta: [
    { title: "Pollen Access — fleuri" },
    { name: "description", content: "Turn an active Pollen Staking position into extra sandbox agent cycles, deeper Greenhouse trials and research credits. Proved live from Solana mainnet; locked until staking is deployed." },
    { property: "og:title", content: "Pollen Access — fleuri" },
    { property: "og:description", content: "Stake-gated extras for your fleuri workspace, enforced server-side with daily UTC quotas." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: AccessPage,
});

type Status = Extract<Awaited<ReturnType<typeof accessStatus>>, { ok: true }>["data"];
type Report = { id: string; mint: string; digest: string; report: any; created_at: string };
const TONE: Record<ActionState, string> = { available: "bg-ink text-paper-light", locked: "bg-paper-deep", exhausted: "bg-poppy text-paper-light", unavailable: "bg-paper-light" };
const ACTIONS: AccessAction[] = ["owner_cycle", "deep_trial", "research_report"];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function AccessPage() {
  const { userId, isAnonymous, store } = useGarden();
  const [st, setSt] = useState<Status | null>(null); const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const [mint, setMint] = useState(FLEURI_MINT); const [open, setOpen] = useState<string | null>(null);
  const gen = useRef(0); const owner = useRef<string | null>(null);
  owner.current = userId;

  async function load(fresh = false) {
    const g = ++gen.current; const me = userId;
    if (!me) return;
    setBusy(true); setErr("");
    try {
      const [s, r] = await Promise.all([accessStatus({ data: { fresh } }), accessReports()]);
      if (g !== gen.current || owner.current !== me) return;
      if (!s.ok) { setSt(null); setErr(s.error); } else setSt(s.data);
      if (r.ok) setReports(r.data);
    } catch { if (g === gen.current) setErr("Pollen Access could not be loaded. Check your connection and try again."); }
    finally { if (g === gen.current) setBusy(false); }
  }
  useEffect(() => { gen.current++; setSt(null); setReports([]); setErr(""); setNote(""); if (userId) void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);
  useEffect(() => () => { gen.current++; }, []);

  async function redeem() {
    const m = mint.trim(); if (!B58.test(m)) { setErr("Enter a valid token mint address."); return; }
    const g = ++gen.current; const me = userId; setBusy(true); setErr(""); setNote("");
    try {
      const r = await accessRedeemReport({ data: { requestId: crypto.randomUUID(), mint: m } });
      if (g !== gen.current || owner.current !== me) return;
      if (!r.ok) { setErr(r.error + (r.blockers?.length ? ` ${r.blockers[0]}` : "")); return; }
      setNote("Research report saved to your workspace.");
      setBusy(false); void load();
    } catch { if (g === gen.current) setErr("The request could not be completed. No credit is spent unless a report is saved."); }
    finally { if (g === gen.current) setBusy(false); }
  }

  const el = st?.eligibility;
  return <div className="space-y-4">
    <PageHeader title="pollen access." kicker="stake $FLEURI · grow your workspace" />
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <p className="max-w-prose text-sm">An active <Link to="/staking" className="underline">Pollen Staking</Link> position unlocks extras for your workspace: more owner-triggered agent cycles, deeper <Link to="/greenhouse" className="underline">Greenhouse</Link> trials and research credits for saved Botanist reports. The server checks your stake live on Solana mainnet each time it matters. Free trials stay free, and every workspace gets 100 free manual cycles a day. Garden balances are virtual vSOL and never count as stake.</p>
      <FlowerTiles count={4} cols={4} className="w-40" />
    </div>

    {!userId && <Panel title="Sign in to see your access">
      <p className="text-sm">Pollen Access belongs to a workspace, so you need one first. Then link your wallet by signing a message on <Link to="/me" className="underline">My agents</Link>. Entering a wallet address alone never unlocks anything.</p>
      <button type="button" className="btn btn-red" onClick={() => void store.startSandbox().catch((e) => setErr((e as Error).message))}>Open a workspace</button>
      {err && <p role="alert" className="text-sm text-poppy-deep">{err}</p>}
    </Panel>}

    {userId && <Panel title="Your access">
      {busy && !st && <p role="status" className="text-sm">Checking your stake…</p>}
      {err && <p role="alert" className="text-sm text-poppy-deep break-words">{err}</p>}
      {note && <p role="status" className="text-sm">{note}</p>}
      {el && <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2"><span className={`chip uppercase ${el.eligible ? "bg-ink text-paper-light" : "bg-paper-deep"}`}>{el.eligible ? "active" : "locked"}</span>
          <span className="text-sm">{el.eligible ? `Verified active stake: ${el.activeStake} base units (6 decimals) at slot ${el.slot}.` : "Extras are locked. Free use is unaffected."}</span></p>
        <p className="text-xs">Linked wallet: <span className="font-mono break-all">{el.wallet ?? "none"}</span> · network {el.cluster ?? "not read"} · checked {new Date(el.checkedAt).toUTCString()}{el.cached ? " (cached ≤ 2 min)" : ""}</p>
        {!el.eligible && <ul className="list-disc pl-5 text-xs">{el.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
        {isAnonymous && <p className="text-xs">This is a guest workspace. It works the same way, but you lose it if you clear this browser.</p>}
        <button type="button" className="btn btn-paper" disabled={busy} onClick={() => void load(true)}>{busy ? "Checking…" : "Re-check stake now"}</button>
      </div>}
    </Panel>}

    {userId && st && <Panel title={`Today · ${st.day} UTC`}>
      <p className="text-xs">Allowances reset at {new Date(st.resetsAt).toUTCString()}. Unused units don't carry over.</p>
      <ul className="grid gap-2 md:grid-cols-3">{ACTIONS.map((a) => {
        const p = ACCESS_POLICY[a]; const u = st.used[a]; const s = actionState(a, u, !!el?.eligible);
        return <li key={a} className="hair space-y-1 bg-paper p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><strong>{p.label}</strong><span className={`chip uppercase ${TONE[s.state]}`}>{s.state}</span></div>
          <p className="num text-xs">free {u.base}/{p.base} · Pollen Access {u.extra}/{p.extra} {p.unit} used</p>
          <p className="text-xs">{p.detail}</p>
        </li>;
      })}</ul>
    </Panel>}

    {userId && st && <Panel title="Research credits · saved Botanist reports">
      <form className="grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); void redeem(); }}>
        <input aria-label="Token mint" value={mint} onChange={(e) => setMint(e.target.value)} className="hair min-w-0 bg-paper-light px-2 py-2 font-mono text-xs" />
        <button className="btn btn-red" disabled={busy || actionState("research_report", st.used.research_report, !!el?.eligible).state !== "available"}>Use 1 credit</button>
      </form>
      <p className="text-xs">One credit = one point-in-time report, saved privately here. A failed read refunds the credit. Want a report without staking? The <Link to="/botanist" className="underline">Botanist</Link> sells the same report for USDC, unchanged.</p>
      {reports.length ? <ul className="space-y-1 text-xs">{reports.map((r) => <li key={r.id} className="hair bg-paper p-2">
        <button type="button" className="underline" onClick={() => setOpen(open === r.id ? null : r.id)}>{r.mint.slice(0, 6)}…{r.mint.slice(-4)} · {new Date(r.created_at).toUTCString()}</button>
        <span className="ml-2 font-mono text-ink-soft">sha256 {r.digest.slice(0, 12)}…</span>
        {open === r.id && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all bg-paper-light p-2">{JSON.stringify(r.report, null, 2)}</pre>}
      </li>)}</ul> : <p className="text-xs text-ink-soft">No saved reports yet.</p>}
    </Panel>}

    <Panel title="How Pollen Access works (v1)">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li><strong>Who qualifies:</strong> any positive <em>active</em> Pollen Staking position. Pending unstake doesn't count. There are no tiers or multipliers.</li>
        <li><strong>Proof:</strong> the wallet linked to your workspace by a signed message must own the position at its canonical address in the live pool. That pool must pass these staking checks on mainnet: {REQUIRED_CHECKS.join(", ")}. Devnet, old snapshots, browser storage and garden vSOL never count.</li>
        <li><strong>Metering:</strong> each action reserves one unit on the server before it runs. It's spent on success and refunded on failure. A retry of the same action never spends twice. Free units are always used first.</li>
        <li><strong>Status words:</strong> available = units left today · locked = needs verified stake · exhausted = today's units are used · unavailable = can't be checked right now.</li>
        <li><strong>Today:</strong> Pollen Staking isn't deployed yet, so extras stay locked for everyone. The blockers above come from the live staking checks.</li>
      </ul>
      <p className="text-xs">Full details in the <Link to="/docs" className="underline">guide</Link>.</p>
    </Panel>
    <FlowerTiles count={8} cols={8} />
  </div>;
}
