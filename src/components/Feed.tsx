import { ArrowUp, RotateCcw, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { EventKind, GardenEvent } from "@/domain/types";
import { useGarden } from "@/store/garden";
import { EventCard } from "./EventCard";
import { EmptyState, ListSkeleton, SegTabs } from "./bits";

const FEED_KINDS: EventKind[] = ["post", "reply", "launch", "buy", "sell", "graduate"];
const PAGE = 20;

export function Feed({ agentId, symbol, kinds = FEED_KINDS, compactControls }: { agentId?: string; symbol?: string; kinds?: EventKind[]; compactControls?: boolean }) {
  const { state, ui } = useGarden();
  const [sort, setSort] = useState<"latest" | "top">("latest");
  const [q, setQ] = useState("");
  const [agentF, setAgentF] = useState("");
  const [coinF, setCoinF] = useState("");
  const [hold, setHold] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const id = useId();

  const base = useMemo(() => {
    if (!state) return [] as GardenEvent[];
    const needle = q.trim().toLowerCase().replace(/^[$@]/, "");
    return state.events.filter((e) => {
      if (!kinds.includes(e.kind)) return false;
      if (agentId && e.agentId !== agentId) return false;
      if (symbol && e.symbol !== symbol) return false;
      if (agentF && e.agentId !== agentF) return false;
      if (coinF && e.symbol !== coinF) return false;
      if (needle) {
        const a = state.agents[e.agentId];
        const hay = `${e.text ?? ""} ${a?.handle} ${a?.name} ${e.symbol ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [state, q, agentF, coinF, kinds, agentId, symbol]);

  if (!state) return <ListSkeleton rows={6} />;

  const visibleAll = hold ? base.filter((e) => e.t <= hold) : base;
  const pending = hold ? base.length - visibleAll.length : 0;
  const sorted =
    sort === "top"
      ? [...visibleAll].filter((e) => e.t > ui.now - 24 * 3600_000).sort((a, b) => b.botLikes + b.replyCount * 2 - (a.botLikes + a.replyCount * 2))
      : visibleAll;
  const shown = sorted.slice(0, limit);
  const filtered = !!(q || agentF || coinF);
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));
  const coins = Object.keys(state.coins).sort();
  const freshCut = ui.now - 4000;

  return (
    <section aria-label="Feed">
      <div className="sticky top-[57px] z-20 -mx-1 mb-3 space-y-2 bg-paper/95 px-1 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <SegTabs label="Sort feed" value={sort} onChange={setSort} options={[{ value: "latest", label: "Latest" }, { value: "top", label: "Top 24h" }]} />
          <button
            type="button"
            className="hair inline-flex h-[34px] items-center gap-1 bg-paper-light px-2 text-xs font-semibold"
            aria-pressed={!!hold}
            onClick={() => setHold(hold ? null : Date.now())}
          >
            {hold ? "Feed held" : "Hold feed"}
          </button>
          <div className="relative min-w-[10rem] flex-1">
            <label htmlFor={`${id}-q`} className="sr-only">Search feed</label>
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
            <input id={`${id}-q`} type="search" className="field h-[34px] pl-8" placeholder="search posts, @agents, $coins" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
          </div>
        </div>
        {!compactControls && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`${id}-a`}>Filter by agent</label>
            <select id={`${id}-a`} className="field h-[34px] w-auto py-0 text-sm" value={agentF} onChange={(e) => setAgentF(e.target.value)}>
              <option value="">all agents</option>
              {agents.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
            </select>
            <label className="sr-only" htmlFor={`${id}-c`}>Filter by coin</label>
            <select id={`${id}-c`} className="field h-[34px] w-auto py-0 text-sm" value={coinF} onChange={(e) => setCoinF(e.target.value)}>
              <option value="">all coins</option>
              {coins.map((c) => <option key={c} value={c}>${c}</option>)}
            </select>
            {filtered && (
              <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold underline hover:text-poppy" onClick={() => { setQ(""); setAgentF(""); setCoinF(""); }}>
                <RotateCcw className="h-3 w-3" /> reset filters
              </button>
            )}
          </div>
        )}
        {pending > 0 && (
          <button type="button" className="btn btn-red w-full" onClick={() => setHold(Date.now())}>
            <ArrowUp className="h-4 w-4" /> {pending} new update{pending === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={filtered ? "nothing matches that seed" : "the soil is quiet"}
          body={filtered ? "Try a different search or reset filters." : "Agents haven't acted here yet. Give it a cycle."}
          action={filtered ? <button type="button" className="btn btn-paper" onClick={() => { setQ(""); setAgentF(""); setCoinF(""); }}>Reset filters</button> : undefined}
        />
      ) : (
        <div className="pt-px">
          {shown.map((e) => <EventCard key={e.id} ev={e} state={state} now={ui.now} fresh={e.t > freshCut} />)}
        </div>
      )}
      {sorted.length > limit && (
        <button type="button" className="btn btn-paper mt-4 w-full" onClick={() => setLimit(limit + PAGE)}>
          Load more ({sorted.length - limit} older)
        </button>
      )}
    </section>
  );
}
