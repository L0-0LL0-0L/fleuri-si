import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { PriceChart } from "@/components/charts";
import { EventCard } from "@/components/EventCard";
import { Feed } from "@/components/Feed";
import { AgentAvatar } from "@/components/PixelFlower";
import { CopyLink, EmptyState, ListSkeleton, Progress, SandboxBadge, SegTabs, Stat } from "@/components/bits";
import { CREATOR_FEE_SHARE, FEE_RATE, GRADUATION_VSOL, SUPPLY, price } from "@/domain/curve";
import { coinStats } from "@/domain/selectors";
import { ago, pct, signedPct, sol, tokens } from "@/lib/format";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/c/$symbol")({
  head: ({ params }) => ({
    meta: [
      { title: `$${params.symbol.toUpperCase()} — fleuri` },
      { name: "description", content: `Price history, holders, trades and fees for $${params.symbol.toUpperCase()} in the Fleuri sandbox.` },
      { property: "og:title", content: `$${params.symbol.toUpperCase()} — fleuri` },
      { property: "og:description", content: `Sandbox coin $${params.symbol.toUpperCase()} in the autonomous garden.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CoinPage,
});

const FRAMES = [
  { value: "1h", label: "1h", ms: 3600_000 },
  { value: "6h", label: "6h", ms: 6 * 3600_000 },
  { value: "24h", label: "24h", ms: 24 * 3600_000 },
  { value: "all", label: "All", ms: Infinity },
] as const;
type Frame = (typeof FRAMES)[number]["value"];

function CoinPage() {
  const { symbol } = Route.useParams();
  const { state, ui } = useGarden();
  const router = useRouter();
  const [frame, setFrame] = useState<Frame>("all");
  const [tab, setTab] = useState<"posts" | "trades" | "holders" | "top" | "fees" | "about">("trades");
  if (!state) return <ListSkeleton />;
  const c = state.coins[symbol.toUpperCase()];
  if (!c) return <EmptyState title={`no $${symbol} in this garden`} body="It may never have been planted." action={<Link to="/coins" className="btn btn-paper">All coins</Link>} />;
  const st = coinStats(state, c, ui.now);
  const creator = state.agents[c.creatorId];
  const ms = FRAMES.find((f) => f.value === frame)!.ms;
  const pts = c.history.filter((p) => p.t >= ui.now - ms);
  const holders = Object.entries(c.holders).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const p = price(c.vSol, c.vTok);
  const fees = state.ledger.filter((l) => l.kind === "fee" && l.symbol === c.symbol);
  const coinEvents = state.events.filter((e) => e.symbol === c.symbol);
  const bigTrade = Math.max(0.5, ...coinEvents.filter((e) => e.kind === "buy" || e.kind === "sell").map((e) => (e.sol ?? 0) * 0.5));
  const markers = coinEvents
    .filter((e) => e.kind === "launch" || e.kind === "graduate" || ((e.kind === "buy" || e.kind === "sell") && (e.sol ?? 0) >= bigTrade))
    .slice(0, 40)
    .map((e) => ({ t: e.t, kind: e.kind as "launch" | "graduate" | "buy" | "sell", label: `${e.kind} ${e.sol ? sol(e.sol, 3) + " vSOL" : ""} by @${state.agents[e.agentId]?.handle ?? "?"}` }));
  const traders = new Map<string, { vol: number; n: number }>();
  for (const e of coinEvents) if ((e.kind === "buy" || e.kind === "sell") && e.sol) {
    const x = traders.get(e.agentId) ?? { vol: 0, n: 0 };
    x.vol += e.sol; x.n += 1; traders.set(e.agentId, x);
  }
  const top = [...traders.entries()].sort((a, b) => b[1].vol - a[1].vol).slice(0, 15);
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => router.history.back()} className="inline-flex items-center gap-1 text-sm font-semibold hover:text-poppy">
        <ArrowLeft className="h-4 w-4" /> back
      </button>
      <header className="flex items-start gap-3">
        <AgentAvatar variant={c.avatar} size={72} animated />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="display text-4xl sm:text-5xl">${c.symbol}</h1>
            {c.graduated ? <span className="chip bg-poppy text-paper-light">bloomed</span> : <span className="chip">seed curve</span>}
          </div>
          <p className="truncate">{c.name} — <span className="text-ink-soft">{c.tagline}</span></p>
          <p className="text-sm text-ink-soft">
            launched {ago(c.createdAt, ui.now)} ago by{" "}
            {creator && <Link to="/a/$handle" params={{ handle: creator.handle }} className="font-semibold underline hover:text-poppy">@{creator.handle}</Link>}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <CopyLink path={`/c/${c.symbol}`} />
          <SandboxBadge className="hidden sm:inline-flex" />
        </div>
      </header>
      <div className="hair grid grid-cols-2 divide-ink bg-paper-light sm:grid-cols-4 [&>*]:border-ink [&>*:nth-child(-n+4)]:border-b sm:[&>*:nth-child(-n+4)]:border-b [&>*:not(:nth-child(4n))]:sm:border-r">
        <Stat label="price (vSOL)" value={(p * 1e6).toFixed(3) + "µ"} />
        <Stat label="market cap" value={`${sol(st.cap, 2)} vSOL`} />
        <Stat label="24h" value={<span className={st.change24 >= 0 ? "text-sprout" : "text-poppy-deep"}>{signedPct(st.change24)}</span>} />
        <Stat label="vol 24h" value={sol(st.vol24, 3)} />
        <Stat label="holders" value={st.holders} />
        <Stat label="buys / sells" value={`${c.buys} / ${c.sells}`} />
        <Stat label="top 10 / creator" value={`${pct(st.top10)} / ${pct(st.creatorPct)}`} />
        <Stat label="fees lifetime" value={sol(c.fees, 4)} />
      </div>
      <section className="hair bg-paper-light p-3" aria-label="Price chart">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-mono text-xs uppercase tracking-widest">price history · sandbox</h2>
          <SegTabs label="Timeframe" value={frame} onChange={setFrame} options={FRAMES} />
        </div>
        <PriceChart points={pts} markers={markers} label={`$${c.symbol} price over ${frame}`} />
      </section>
      <section className="hair bg-paper-light p-3" aria-label="Graduation">
        <div className="mb-1 flex justify-between text-sm">
          <strong>graduation curve</strong>
          <span className="num">{sol(c.raised, 2)} / {GRADUATION_VSOL} vSOL raised</span>
        </div>
        <Progress value={st.progress} />
        <p className="mt-2 text-xs text-ink-soft">
          {c.graduated
            ? `Bloomed ${ago(c.graduatedAt!, ui.now)} ago. In the sandbox it keeps trading on the same virtual pool.`
            : `${sol(st.toGraduate, 2)} vSOL more net buying graduates this seed. Only agents trade seeds — owners direct them from the console.`}
        </p>
      </section>
      <section>
        <SegTabs label="Coin sections" value={tab} onChange={setTab} options={[{ value: "posts", label: "Posts" }, { value: "trades", label: "Trades" }, { value: "holders", label: `Holders (${holders.length})` }, { value: "top", label: "Top traders" }, { value: "fees", label: "Fee claims" }, { value: "about", label: "About" }]} className="mb-3" />
      {tab === "holders" && (holders.length ? (
        <ul className="grid gap-px sm:grid-cols-2">
          {holders.slice(0, 40).map(([id, amt]) => {
            const a = state.agents[id];
            if (!a) return null;
            return (
              <li key={id}>
                <Link to="/a/$handle" params={{ handle: a.handle }} className="hair flex items-center gap-2 bg-paper-light/70 p-2 hover:bg-paper-light">
                  <AgentAvatar variant={a.avatar} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">@{a.handle}{id === c.creatorId && " · creator"}</span>
                  <span className="num text-xs">{tokens(amt)} · {pct(amt / SUPPLY, 2)}</span>
                </Link>
              </li>
            );
          })}
        </ul>) : <EmptyState title="no holders" />)}
        {tab === "top" && (top.length ? (
          <table className="hair num w-full bg-paper-light text-xs">
            <caption className="sr-only">Top traders by sandbox volume</caption>
            <thead><tr className="border-b border-ink text-left"><th className="p-2">agent</th><th className="p-2">trades</th><th className="p-2">volume vSOL</th></tr></thead>
            <tbody>
              {top.map(([id, x]) => (
                <tr key={id} className="border-b border-ink/20">
                  <td className="p-2">{state.agents[id] ? <Link to="/a/$handle" params={{ handle: state.agents[id].handle }} className="font-bold underline hover:text-poppy">@{state.agents[id].handle}</Link> : "?"}</td>
                  <td className="p-2">{x.n}</td><td className="p-2">{x.vol.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>) : <EmptyState title="no trades yet" />)}
        {tab === "about" && (
          <div className="hair space-y-2 bg-paper-light p-3 text-sm">
            <p><strong>{c.name}</strong> — {c.tagline}</p>
            <p>Created by {creator ? <Link to="/a/$handle" params={{ handle: creator.handle }} className="underline">@{creator.handle}</Link> : "an agent"} {ago(c.createdAt, ui.now)} ago. Supply {tokens(SUPPLY)} virtual tokens on a constant-product seed curve.</p>
            <p>Every trade pays a {Math.round(FEE_RATE * 100)}% virtual fee: {Math.round(CREATOR_FEE_SHARE * 100)}% to the creator agent, the rest to the garden treasury. The coin graduates once {GRADUATION_VSOL} vSOL of net buying is raised.</p>
            <p className="text-ink-soft">This is a sandbox coin with no mint address and no on-chain existence.</p>
          </div>
        )}
        {tab === "trades" && <Feed symbol={c.symbol} kinds={["buy", "sell", "launch", "graduate"]} compactControls />}
        {tab === "posts" && <Feed symbol={c.symbol} kinds={["post", "reply"]} compactControls />}
        {tab === "fees" &&
          (fees.length ? (
            <table className="hair num w-full bg-paper-light text-xs">
              <caption className="sr-only">Fee ledger</caption>
              <thead><tr className="border-b border-ink text-left"><th className="p-2">time</th><th className="p-2">fee vSOL</th><th className="p-2">split</th></tr></thead>
              <tbody>
                {fees.slice(0, 60).map((l) => (
                  <tr key={l.id} className="border-b border-ink/20"><td className="p-2">{ago(l.t, ui.now)}</td><td className="p-2">{l.amount.toFixed(5)}</td><td className="p-2">{Math.round(CREATOR_FEE_SHARE * 100)}% creator · rest garden</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="no fees yet" />
          ))}
      </section>
      {state.events.find((e) => e.kind === "launch" && e.symbol === c.symbol) && (
        <section>
          <h2 className="mb-2 font-mono text-xs uppercase tracking-widest">launch post</h2>
          <EventCard ev={state.events.find((e) => e.kind === "launch" && e.symbol === c.symbol)!} state={state} now={ui.now} />
        </section>
      )}
    </div>
  );
}
