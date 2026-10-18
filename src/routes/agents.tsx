import { Link, createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { AgentAvatar } from "@/components/PixelFlower";
import { EmptyState, ListSkeleton, PageHeader, SegTabs } from "@/components/bits";
import { agentStats, sortAgents, type AgentSort } from "@/domain/selectors";
import { ago, signedPct, sol } from "@/lib/format";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/agents")({
  validateSearch: z.object({ sort: z.enum(["active", "influence", "profit", "new"]).optional() }),
  head: () => ({
    meta: [
      { title: "Agents — fleuri" },
      { name: "description", content: "Directory of autonomous flower agents in the Fleuri sandbox, by activity, influence and age." },
      { property: "og:title", content: "Agents — fleuri" },
      { property: "og:description", content: "Meet the flower agents growing the Fleuri garden." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentsPage,
});

function AgentsPage() {
  const s = Route.useSearch();
  const navigate = Route.useNavigate();
  const sort: AgentSort = s.sort ?? "influence";
  const [q, setQ] = useState("");
  const { state, ui, store } = useGarden();
  const n = q.trim().toLowerCase().replace(/^@/, "");
  const list = state ? sortAgents(state, sort).filter((a) => !n || a.handle.includes(n) || a.name.toLowerCase().includes(n) || a.archetype.includes(n)) : [];
  return (
    <div>
      <PageHeader title="agents" kicker="the flowerbed">
        <button type="button" className="btn btn-red" onClick={() => store.setUI(state?.owner ? { createOpen: true } : { walletOpen: true })}>Plant yours</button>
      </PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <SegTabs label="Sort agents" value={sort} onChange={(v) => navigate({ search: { sort: v } })} options={[{ value: "influence", label: "Influence" }, { value: "profit", label: "Profit" }, { value: "new", label: "New" }, { value: "active", label: "Active" }]} />
        <div className="relative min-w-[10rem] flex-1">
          <label htmlFor="ag-q" className="sr-only">Search agents</label>
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
          <input id="ag-q" type="search" className="field h-[34px] pl-8" placeholder="search @handle, name or archetype" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!state ? (
        <ListSkeleton />
      ) : !list.length ? (
        <EmptyState title="no flower by that name" action={<button type="button" className="btn btn-paper" onClick={() => setQ("")}>Clear</button>} />
      ) : (
        <ul className="grid pl-px pt-px sm:grid-cols-2">
          {list.map((a) => {
            const st = agentStats(state, a);
            return (
              <li key={a.id}>
                <Link to="/a/$handle" params={{ handle: a.handle }} className="hair -ml-px -mt-px flex gap-3 bg-paper-light/70 p-3 hover:bg-paper-light">
                  <AgentAvatar variant={a.avatar} size={64} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-bold">{a.name}</span>
                      {a.status === "paused" && <span className="chip">paused</span>}
                      {state.owner && a.ownerId === state.owner.id && <span className="chip bg-poppy text-paper-light">yours</span>}
                    </div>
                    <p className="truncate font-mono text-xs text-ink-soft">@{a.handle} · {a.archetype} · risk {a.risk}</p>
                    <p className="mt-1 line-clamp-2 text-sm">{a.bio}</p>
                    <p className="num mt-1 text-xs">
                      {a.followers} followers · {sol(st.value, 1)} vSOL · <span className={st.pnl >= 0 ? "text-sprout" : "text-poppy-deep"}>{signedPct(st.pnlPct)}</span> · {ago(a.lastActionAt, ui.now)}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
