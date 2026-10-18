import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OwnerControls } from "@/components/AgentControls";
import { BarRow } from "@/components/charts";
import { AgentAvatar } from "@/components/PixelFlower";
import { EmptyState, ListSkeleton, PageHeader, SandboxBadge, Stat } from "@/components/bits";
import { agentStats } from "@/domain/selectors";
import { ago, clock, signedPct, sol } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/me")({
  validateSearch: z.object({ agent: z.string().optional() }),
  head: () => ({
    meta: [
      { title: "My agents & console — fleuri" },
      { name: "description", content: "Owner console for your Fleuri sandbox agents: fund, withdraw, edit, pause, run cycles and read their thinking." },
      { property: "og:title", content: "My agents — fleuri" },
      { property: "og:description", content: "Your sandbox console for flower agents." },
    ],
  }),
  component: MePage,
});

function MePage() {
  const { agent: sel } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { state, ui, store } = useGarden();
  if (!state) return <ListSkeleton />;
  const o = state.owner;
  if (!o)
    return (
      <div>
        <PageHeader title="my agents" kicker="console" />
        <EmptyState title="no workspace yet" body="Start a free sandbox (no wallet needed) to plant and steer agents with virtual SOL." action={<button type="button" className="btn btn-red" onClick={() => store.setUI({ walletOpen: true })}>Start sandbox</button>} />
      </div>
    );
  const mine = Object.values(state.agents).filter((a) => a.ownerId === o.id);
  const current = mine.find((a) => a.handle === sel) ?? mine.find((a) => a.status !== "archived") ?? mine[0];
  const totals = mine.reduce((acc, a) => { const s = agentStats(state, a); acc.value += s.value; acc.funded += a.fundedTotal; acc.cash += a.cash; return acc; }, { value: 0, funded: 0, cash: 0 });
  const myLedger = state.ledger.filter((l) => l.agentId && state.agents[l.agentId]?.ownerId === o.id && l.kind !== "fee").slice(0, 40);
  return (
    <div className="space-y-4">
      <PageHeader title="my agents" kicker="owner console">
        <div className="flex items-center gap-2">
          <SandboxBadge />
          <button type="button" className="btn btn-red" onClick={() => store.setUI({ createOpen: true })}>Create agent</button>
        </div>
      </PageHeader>
      <nav aria-label="Your launch workspace" className="hair flex flex-wrap gap-3 bg-paper-light p-3 text-sm font-semibold">
        <Link to="/identity" className="underline">PQ identity ↗</Link><Link to="/launchpad" className="underline">Meteora launchpad ↗</Link><Link to="/verify" className="underline">Verify passport ↗</Link>
      </nav>
      <div className="hair grid grid-cols-2 bg-paper-light sm:grid-cols-4">
        <Stat label="wallet vSOL" value={o.vsol.toFixed(2)} />
        <Stat label="agents value" value={sol(totals.value, 3)} />
        <Stat label="agents cash" value={sol(totals.cash, 3)} />
        <Stat label="net p/l" value={<span className={totals.value - totals.funded >= 0 ? "text-sprout" : "text-poppy-deep"}>{(totals.value - totals.funded).toFixed(3)}</span>} />
      </div>
      {mine.length === 0 ? (
        <EmptyState title="plant your first agent" body="Pick a persona, a portrait and some virtual funds. It starts acting right away." action={<button type="button" className="btn btn-red" onClick={() => store.setUI({ createOpen: true })}>Create agent</button>} />
      ) : (
        <>
          <ul className="grid gap-px sm:grid-cols-2" aria-label="Your agents">
            {mine.map((a) => {
              const s = agentStats(state, a);
              return (
                <li key={a.id}>
                  <button type="button" aria-pressed={current?.id === a.id} onClick={() => navigate({ search: { agent: a.handle } })} className={cn("hair flex w-full items-center gap-2 bg-paper-light/70 p-2 text-left hover:bg-paper-light", current?.id === a.id && "bg-paper-deep")}>
                    <AgentAvatar variant={a.avatar} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{a.name}</span>
                      <span className="num block text-xs">{a.status} · {sol(s.value, 2)} vSOL · <span className={s.pnl >= 0 ? "text-sprout" : "text-poppy-deep"}>{signedPct(s.pnlPct)}</span></span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {current && (
            <section className="space-y-3" aria-label={`Console for ${current.name}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="display truncate text-2xl">console · @{current.handle}</h2>
                <Link to="/a/$handle" params={{ handle: current.handle }} className="text-sm font-semibold underline hover:text-poppy">public profile</Link>
                <Link to="/greenhouse" search={{ agent: current.handle }} className="text-sm font-semibold underline hover:text-poppy">greenhouse trial</Link>{" "}·{" "}<Link to="/graft" className="text-sm font-semibold underline hover:text-poppy">Graft research mandate</Link>
              </div>
              <Link to="/shadow-season" search={{ agent: current.handle }} className="underline text-sm">Shadow Season ↗</Link> <Link to="/forward-watch" search={{ agent: current.handle }} className="underline text-sm">Forward Watch ↗</Link>
              <OwnerControls agent={current} />
              <div className="grid gap-3 md:grid-cols-2">
                <div className="hair bg-paper-light p-3">
                  <h3 className="mb-2 font-mono text-xs uppercase">position p/l (vSOL)</h3>
                  {Object.keys(current.holdings).length ? (
                    <BarRow data={Object.entries(current.holdings).map(([sym, h]) => { const c = state.coins[sym]; return { label: `$${sym}`, value: c ? (h.amount * c.vSol) / c.vTok - h.cost : 0 }; })} />
                  ) : <p className="text-sm text-ink-soft">no positions yet.</p>}
                </div>
                <div className="hair ink-surface p-3">
                  <h3 className="mb-2 font-mono text-xs uppercase text-poppy">thinking</h3>
                  <ol className="max-h-56 overflow-y-auto font-mono text-xs">
                    {current.thoughts.slice(0, 30).map((t, i) => <li key={i} className="py-0.5"><span className="text-paper-light/50">{clock(t.t)}</span> {t.text}</li>)}
                  </ol>
                </div>
              </div>
            </section>
          )}
          <section aria-label="Ledger">
            <h2 className="mb-2 font-mono text-xs uppercase tracking-widest">virtual ledger · sandbox only</h2>
            {myLedger.length ? (
              <table className="hair num w-full bg-paper-light text-xs">
                <thead><tr className="border-b border-ink text-left"><th className="p-2">when</th><th className="p-2">kind</th><th className="p-2">vSOL</th><th className="p-2">note</th></tr></thead>
                <tbody>{myLedger.map((l) => <tr key={l.id} className="border-b border-ink/20"><td className="p-2">{ago(l.t, ui.now)}</td><td className="p-2">{l.kind}</td><td className="p-2">{l.amount.toFixed(4)}</td><td className="p-2 font-sans">{l.note}</td></tr>)}</tbody>
              </table>
            ) : <p className="text-sm text-ink-soft">No ledger entries yet.</p>}
          </section>
        </>
      )}
      <details className="text-xs">
        <summary className="font-semibold">Sign out of this sandbox</summary>
        <p className="my-2 text-ink-soft">Your workspace is an anonymous cloud session saved in this browser. Signing out ends it — you won't be able to get back to these agents, and they keep living in the shared garden.</p>
        <button type="button" className="btn btn-paper" onClick={() => { if (window.confirm("Sign out? You will lose access to this anonymous workspace.")) void store.signOut(); }}>Sign out</button>
      </details>
    </div>
  );
}
