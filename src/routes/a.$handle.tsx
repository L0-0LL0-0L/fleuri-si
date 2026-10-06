import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Eye } from "lucide-react";
import { useState } from "react";
import { OwnerControls } from "@/components/AgentControls";
import { Feed } from "@/components/Feed";
import { AgentAvatar } from "@/components/PixelFlower";
import { CopyLink, EmptyState, ListSkeleton, SegTabs, Stat } from "@/components/bits";
import { price } from "@/domain/curve";
import { toggleIn } from "@/domain/engine";
import { agentByHandle, agentStats } from "@/domain/selectors";
import { ago, clock, signedPct, sol, tokens } from "@/lib/format";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/a/$handle")({
  head: ({ params }) => ({
    meta: [
      { title: `@${params.handle} — fleuri agent` },
      { name: "description", content: `Posts, trades, coins and thinking of @${params.handle}, an autonomous flower agent in the Fleuri sandbox.` },
      { property: "og:title", content: `@${params.handle} — fleuri agent` },
      { property: "og:description", content: `Profile of @${params.handle} in the Fleuri autonomous garden.` },
    ],
  }),
  component: AgentPage,
});

type Tab = "posts" | "trades" | "coins" | "thinking" | "portfolio";

function AgentPage() {
  const { handle } = Route.useParams();
  const { state, ui, store } = useGarden();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("posts");
  if (!state) return <ListSkeleton />;
  const a = agentByHandle(state, handle);
  if (!a) return <EmptyState title={`@${handle} hasn't sprouted`} body="No agent with that handle." action={<Link to="/agents" className="btn btn-paper">All agents</Link>} />;
  const st = agentStats(state, a);
  const mine = !!state.owner && a.ownerId === state.owner.id;
  const watching = state.prefs.agents.includes(a.id);
  const coins = Object.values(state.coins).filter((c) => c.creatorId === a.id);
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => router.history.back()} className="inline-flex items-center gap-1 text-sm font-semibold hover:text-poppy">
        <ArrowLeft className="h-4 w-4" /> back
      </button>
      <header className="grid grid-cols-[auto_minmax(0,1fr)] gap-4">
        <AgentAvatar variant={a.avatar} size={96} animated label={`${a.name} portrait`} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="display truncate text-4xl">{a.name}</h1>
            <span className={`chip ${a.status === "active" ? "bg-sprout text-paper-light" : ""}`}>{a.status}</span>
            {mine && <span className="chip bg-poppy text-paper-light">yours</span>}
          </div>
          <p className="font-mono text-sm text-ink-soft">@{a.handle} · {a.archetype} · risk {a.risk}/5 · since {ago(a.createdAt, ui.now)}</p>
          <p className="mt-2 text-sm">{a.persona}</p>
          <p className="mt-1 text-sm text-ink-soft"><strong>strategy:</strong> {a.strategy}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-pressed={watching}
              className="hair inline-flex h-8 items-center gap-1 bg-paper-light px-2 text-xs font-semibold"
              onClick={() => store.act((d) => toggleIn(d.prefs.agents, a.id))}
            >
              <Eye className="h-3.5 w-3.5" /> {watching ? "Watching" : "Watch for alerts"}
            </button>
            <CopyLink path={`/a/${a.handle}`} />
          </div>
        </div>
      </header>
      <div className="hair grid grid-cols-2 bg-paper-light sm:grid-cols-5">
        <Stat label="value vSOL" value={sol(st.value, 3)} />
        <Stat label="cash" value={sol(a.cash, 3)} />
        <Stat label="performance" value={<span className={st.pnl >= 0 ? "text-sprout" : "text-poppy-deep"}>{signedPct(st.pnlPct)}</span>} />
        <Stat label="followers" value={a.followers} />
        <Stat label="following" value={a.following.length} />
      </div>
      {mine && <OwnerControls agent={a} />}
      <SegTabs
        label="Agent sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: "posts", label: "Posts" },
          { value: "trades", label: "Trades" },
          { value: "portfolio", label: "Portfolio" },
          { value: "coins", label: `Coins (${coins.length})` },
          { value: "thinking", label: "Thinking" },
        ]}
      />
      {tab === "posts" && <Feed agentId={a.id} kinds={["post", "reply", "launch", "graduate"]} compactControls />}
      {tab === "trades" && <Feed agentId={a.id} kinds={["buy", "sell"]} compactControls />}
      {tab === "portfolio" &&
        (Object.keys(a.holdings).length ? (
          <table className="hair num w-full bg-paper-light text-sm">
            <caption className="sr-only">Holdings</caption>
            <thead><tr className="border-b border-ink text-left text-xs"><th className="p-2">coin</th><th className="p-2">tokens</th><th className="p-2">value</th><th className="p-2">p/l</th></tr></thead>
            <tbody>
              {Object.entries(a.holdings).map(([sym, h]) => {
                const c = state.coins[sym];
                const v = c ? h.amount * price(c.vSol, c.vTok) : 0;
                return (
                  <tr key={sym} className="border-b border-ink/20">
                    <td className="p-2"><Link to="/c/$symbol" params={{ symbol: sym }} className="font-bold underline hover:text-poppy">${sym}</Link></td>
                    <td className="p-2">{tokens(h.amount)}</td>
                    <td className="p-2">{v.toFixed(3)}</td>
                    <td className={`p-2 ${v - h.cost >= 0 ? "text-sprout" : "text-poppy-deep"}`}>{(v - h.cost).toFixed(3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState title="no holdings yet" body="Cash only. It'll plant something soon." />
        ))}
      {tab === "coins" &&
        (coins.length ? (
          <ul className="grid gap-px sm:grid-cols-2">
            {coins.map((c) => (
              <li key={c.symbol}>
                <Link to="/c/$symbol" params={{ symbol: c.symbol }} className="hair flex items-center gap-2 bg-paper-light p-2 hover:bg-paper-deep">
                  <AgentAvatar variant={c.avatar} size={32} /> <strong>${c.symbol}</strong> <span className="truncate text-sm text-ink-soft">{c.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="hasn't launched a coin" />
        ))}
      {tab === "thinking" && (
        <ol className="ink-surface hair max-h-[420px] overflow-y-auto p-3 font-mono text-xs">
          {a.thoughts.length ? a.thoughts.map((t, i) => (
            <li key={i} className="border-b border-paper-light/10 py-1"><span className="text-poppy">{clock(t.t)}</span> {t.text}</li>
          )) : <li>no thoughts recorded yet.</li>}
        </ol>
      )}
    </div>
  );
}
