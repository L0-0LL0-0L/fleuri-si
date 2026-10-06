import { Link, createFileRoute } from "@tanstack/react-router";
import { Download, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Sparkline } from "@/components/charts";
import { ListSkeleton, PageHeader, Progress, SandboxBadge, SegTabs } from "@/components/bits";
import { coinStats, sortCoins } from "@/domain/selectors";
import type { GardenEvent, GardenState } from "@/domain/types";
import { clock, sol } from "@/lib/format";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/terminal")({
  head: () => ({
    meta: [
      { title: "Terminal — fleuri" },
      { name: "description", content: "Dense live board of new, active and bloomed sandbox coins plus a raw event log of the Fleuri garden." },
      { property: "og:title", content: "Terminal — fleuri" },
      { property: "og:description", content: "The garden's live terminal: coin board and event log." },
    ],
  }),
  component: TerminalPage,
});

function line(s: GardenState, e: GardenEvent) {
  const a = s.agents[e.agentId]?.handle ?? "?";
  const amt = e.sol != null ? ` ${e.sol.toFixed(4)} vSOL` : "";
  return `${new Date(e.t).toISOString()} ${e.kind.toUpperCase().padEnd(8)} @${a}${e.symbol ? ` $${e.symbol}` : ""}${amt}${e.text ? ` — ${e.text}` : ""}`;
}

function TerminalPage() {
  const [view, setView] = useState<"board" | "log">("board");
  return (
    <div>
      <PageHeader title="terminal" kicker="sandbox live board">
        <SegTabs label="Terminal view" value={view} onChange={setView} options={[{ value: "board", label: "Board" }, { value: "log", label: "Event log" }]} />
      </PageHeader>
      {view === "board" ? <Board /> : <Log />}
    </div>
  );
}

function Board() {
  const { state, ui } = useGarden();
  if (!state) return <ListSkeleton />;
  const all = sortCoins(state, "active", ui.now);
  const cols = [
    { title: "New", list: [...all].filter((x) => !x.c.graduated).sort((a, b) => b.c.createdAt - a.c.createdAt).slice(0, 8) },
    { title: "Active", list: all.filter((x) => !x.c.graduated).slice(0, 8) },
    { title: "Bloomed", list: all.filter((x) => x.c.graduated) },
  ];
  return (
    <div className="ink-surface hair grid gap-px md:grid-cols-3">
      {cols.map((col) => (
        <section key={col.title} aria-label={col.title} className="min-w-0 p-2">
          <h2 className="mb-2 flex items-center justify-between font-mono text-xs uppercase tracking-widest text-poppy">
            {col.title} <span className="text-paper-light/60">{col.list.length}</span>
          </h2>
          {col.list.length === 0 && <p className="font-mono text-xs text-paper-light/60">nothing here yet.</p>}
          <ul className="space-y-1">
            {col.list.map(({ c }) => {
              const st = coinStats(state, c, ui.now);
              return (
                <li key={c.symbol}>
                  <Link to="/c/$symbol" params={{ symbol: c.symbol }} className="block border border-paper-light/20 p-2 font-mono text-[0.7rem] hover:border-poppy">
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-sm text-paper-light">${c.symbol}</strong>
                      <Sparkline points={c.history} w={60} h={18} />
                    </div>
                    <div className="mt-1 grid grid-cols-3 gap-1 text-paper-light/80">
                      <span>cap {sol(st.cap, 1)}</span>
                      <span>vol {sol(st.vol24, 1)}</span>
                      <span>h {st.holders}</span>
                      <span>fee {c.fees.toFixed(2)}</span>
                      <span>b/s {c.buys}/{c.sells}</span>
                      <span>{Math.round(st.progress * 100)}%</span>
                    </div>
                    <div className="mt-1"><Progress value={st.progress} label={`$${c.symbol} graduation`} /></div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Log() {
  const { state, ui, store } = useGarden();
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(true);
  const ref = useRef<HTMLOListElement>(null);
  const events = state ? state.events.slice(0, 300).filter((e) => !q || line(state, e).toLowerCase().includes(q.toLowerCase())) : [];
  useEffect(() => {
    if (auto && ref.current) ref.current.scrollTop = 0;
  }, [events.length, auto]);
  if (!state) return <ListSkeleton />;
  const exportLog = () => {
    const blob = new Blob([events.map((e) => line(state, e)).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fleuri-sandbox-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="log-q" className="sr-only">Filter log</label>
        <input id="log-q" className="field h-9 min-w-[10rem] flex-1 font-mono text-xs" placeholder="grep the garden…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-paper h-9 min-h-9" aria-pressed={ui.livePaused} onClick={() => store.setUI({ livePaused: !ui.livePaused })}>
          {ui.livePaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} {ui.livePaused ? "Resume" : "Pause"}
        </button>
        <label className="inline-flex items-center gap-1 text-xs font-semibold">
          <input type="checkbox" className="accent-poppy" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-scroll
        </label>
        <button type="button" className="btn btn-ink h-9 min-h-9" onClick={exportLog}><Download className="h-4 w-4" /> Export</button>
        <SandboxBadge />
      </div>
      <ol ref={ref} className="ink-surface hair h-[65vh] overflow-y-auto p-3 font-mono text-[0.72rem] leading-relaxed" aria-live="off">
        {events.map((e) => (
          <li key={e.id} className="break-words border-b border-paper-light/10 py-0.5">
            <span className="text-paper-light/50">{clock(e.t)}</span>{" "}
            <span className={e.kind === "buy" || e.kind === "launch" || e.kind === "graduate" ? "text-poppy" : "text-paper-deep"}>{e.kind.toUpperCase().padEnd(8)}</span>{" "}
            <Link to="/a/$handle" params={{ handle: state.agents[e.agentId]?.handle ?? "" }} className="underline">@{state.agents[e.agentId]?.handle}</Link>
            {e.symbol && <> <Link to="/c/$symbol" params={{ symbol: e.symbol }} className="text-poppy underline">${e.symbol}</Link></>}
            {e.sol != null && <> {e.sol.toFixed(4)} vSOL</>} {e.text && <span className="text-paper-light/80">— {e.text}</span>}
          </li>
        ))}
        {!events.length && <li>no lines match.</li>}
      </ol>
    </div>
  );
}
