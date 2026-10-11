import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { EmptyState, ListSkeleton, PageHeader, SandboxBadge } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel } from "@/components/pq/ui";
import { ExecutionModeNote, MetricDefinitions, TrialReport, type TrialRow } from "@/components/greenhouse/TrialReport";
import { LIMITS, SCENARIOS, SCENARIO_INFO, verifyBundle, type ReplayStatus, type Scenario } from "@/domain/greenhouse";
import { ghMyRuns, ghPublish, ghRun, ghStart } from "@/lib/greenhouse.functions";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";
import { clearPending, createFence, readPending, writePending, type Pending } from "@/lib/greenhouse-session";

export const Route = createFileRoute("/greenhouse/")({
  validateSearch: z.object({ agent: z.string().max(20).optional(), run: z.string().uuid().optional() }),
  head: () => ({
    meta: [
      { title: "Greenhouse Trials — fleuri" },
      { name: "description", content: "Stress-test garden agents' rules strategies under identical vSOL sandbox conditions, compare with buy & hold and replay the evidence." },
      { property: "og:title", content: "Greenhouse Trials — fleuri" },
      { property: "og:description", content: "Deterministic vSOL sandbox stress tests with scorecards, baselines and replayable evidence bundles." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Greenhouse,
});


function Greenhouse() {
  const { agent: preselect, run: runParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { state, userId, store } = useGarden();
  const [picked, setPicked] = useState<string[]>([]);
  const [seed, setSeed] = useState(20261011);
  const [reps, setReps] = useState(3);
  const [cycles, setCycles] = useState(30);
  const [scen, setScen] = useState<Scenario[]>([...SCENARIOS]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<any[] | null>(null);
  const [current, setCurrent] = useState<TrialRow | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [filter, setFilter] = useState("");
  const [imported, setImported] = useState<ReplayStatus | null>(null);

  const agents = state ? Object.values(state.agents).filter((a) => a.status !== "archived").sort((a, b) => a.handle.localeCompare(b.handle)) : [];
  const handles = Object.fromEntries(agents.map((a) => [a.id, a.handle]));
  const fence = useRef(createFence()).current;
  // Session change: drop every owner-scoped view and fence out late responses for the old owner.
  useEffect(() => {
    fence.bump();
    setCurrent(null); setRuns(null); setError(""); setBusy(null); setImported(null);
    setPending(readPending(userId, localStorage));
  }, [userId]);
  useEffect(() => {
    if (!state || !preselect) return;
    const a = Object.values(state.agents).find((x) => x.handle === preselect);
    if (a) setPicked((p) => (p.includes(a.id) ? p : [a.id, ...p].slice(0, LIMITS.agents)));
  }, [state?.version, preselect]);
  async function loadRuns(g = fence.current()) { if (!store.get().userId) return setRuns(null); const r = await ghMyRuns(); if (!fence.guard(g)) return; if (r.ok) setRuns(r.data); else setError(r.error); }
  useEffect(() => { void loadRuns(); }, [userId]);
  async function open(id: string, g = fence.current()) {
    setBusy("Loading trial…"); setError("");
    try { const r = await ghRun({ data: { id } }); if (!fence.guard(g)) return; if (!r.ok) throw new Error(r.error); setCurrent(r.data as TrialRow); void navigate({ search: (s) => ({ ...s, run: id }), replace: true }); }
    catch (e) { if (fence.guard(g)) setError((e as Error).message); } finally { if (fence.guard(g)) setBusy(null); }
  }
  useEffect(() => { if (userId && runParam && current?.id !== runParam) void open(runParam); }, [userId, runParam]);

  async function start(p: Pending) {
    const owner = userId; if (!owner) return;
    const g = fence.current();
    setBusy("Running trial on the server…"); setError("");
    writePending(owner, p, localStorage); setPending(p); // saved before the first request: reloads recover the same run
    try {
      const r = await ghStart({ data: p });
      if (!fence.guard(g)) return;
      if (!r.ok) throw new Error(r.error);
      if (r.data.status === "running") throw new Error("This trial is still running in another attempt. Nothing was recomputed; try recovering it in a minute.");
      clearPending(owner, localStorage); setPending(null);
      if (r.data.status === "failed") toast.error("That trial failed and was recorded as failed."); else toast.success(r.data.recovered ? "Recovered the saved trial" : "Trial saved");
      await loadRuns(g); await open(r.data.id, g);
    } catch (e) { if (fence.guard(g)) setError((e as Error).message); } finally { if (fence.guard(g)) setBusy(null); }
  }
  function submit() {
    if (!picked.length) return setError("Pick at least one agent.");
    if (!scen.length) return setError("Pick at least one scenario.");
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return setError("Seed must be a whole number from 0 to 4294967295.");
    void start({ requestId: crypto.randomUUID(), config: { agentIds: picked, seed, repetitions: reps, cycles, scenarios: scen } });
  }
  async function onImport(file: File) {
    if (file.size > LIMITS.bundleBytes) return setImported({ status: "invalid", detail: "Bundle is larger than the 2 MB limit." });
    setBusy("Verifying bundle…"); await new Promise((r) => setTimeout(r, 20));
    try { setImported(verifyBundle(await file.text())); } catch (e) { setImported({ status: "invalid", detail: (e as Error).message }); } finally { setBusy(null); }
  }

  if (!state) return <ListSkeleton />;
  const shown = agents.filter((a) => !filter || a.handle.includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      <PageHeader title="greenhouse" kicker="trials"><SandboxBadge /></PageHeader>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <p className="text-sm">Controlled stress tests of agent strategies. Every agent gets the same starting vSOL, the same frozen copy of the public garden market and the same external shocks, then is compared with a buy-and-hold baseline. Results are saved, replayable and private until you publish them.</p>
        <FlowerTiles count={8} cols={4} className="hidden sm:grid" start={3} />
      </div>
      <ExecutionModeNote />

      {!userId ? (
        <Panel title="Your workspace">
          <p className="text-sm">Open your sandbox workspace to run and save trials. Published reports can be read without one.</p>
          <button type="button" className="btn btn-ink" disabled={!!busy} onClick={() => { setBusy("Opening workspace…"); store.startSandbox().catch((e) => setError((e as Error).message)).finally(() => setBusy(null)); }}>{busy ?? "Open workspace"}</button>
        </Panel>
      ) : (
        <Panel title="Set up a trial">
          {pending && !busy && <div className="hair space-y-2 bg-paper-deep p-2 text-sm" role="status"><p>An unfinished trial from this browser was not confirmed as saved. Recovering re-uses the same request, so it returns the originally frozen run — never a new snapshot.</p><div className="flex flex-wrap gap-2"><button type="button" className="btn btn-red" onClick={() => void start(pending)}>Recover unfinished trial</button><button type="button" className="btn btn-paper" onClick={() => { clearPending(userId, localStorage); setPending(null); }}>Forget it</button></div></div>}
          {!agents.length ? <EmptyState title="no agents yet" body="The garden has no agents to trial." /> : <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Agents ({picked.length}/{LIMITS.agents})</legend>
              <input aria-label="Filter agents" className="field w-full sm:w-64" placeholder="filter by handle" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                {shown.map((a) => {
                  const on = picked.includes(a.id), full = !on && picked.length >= LIMITS.agents;
                  return <label key={a.id} className={cn("hair flex items-center gap-2 p-2 text-sm", on ? "bg-paper-deep" : "bg-paper", full && "opacity-50")}>
                    <input type="checkbox" checked={on} disabled={full} onChange={() => setPicked(on ? picked.filter((x) => x !== a.id) : [...picked, a.id])} />
                    <span className="min-w-0 truncate"><strong>@{a.handle}</strong> · {a.archetype}, risk {a.risk}{a.ownerId === state.owner?.id && " · yours"}</span>
                  </label>;
                })}
              </div>
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="text-sm font-semibold">Scenarios</legend>
              {SCENARIOS.map((s) => <label key={s} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={scen.includes(s)} onChange={() => setScen(scen.includes(s) ? scen.filter((x) => x !== s) : [...scen, s])} /><span><strong>{SCENARIO_INFO[s].label}</strong> — <span className="text-xs">{SCENARIO_INFO[s].detail}</span></span></label>)}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm font-semibold">Seed<input type="number" min={0} max={4294967295} className="field mt-1 w-full" value={seed} onChange={(e) => setSeed(Math.floor(Number(e.target.value)))} /></label>
              <label className="text-sm font-semibold">Repetitions (1–{LIMITS.reps})<input type="number" min={1} max={LIMITS.reps} className="field mt-1 w-full" value={reps} onChange={(e) => setReps(Math.min(LIMITS.reps, Math.max(1, Math.floor(Number(e.target.value) || 1))))} /></label>
              <label className="text-sm font-semibold">Cycles ({LIMITS.cyclesMin}–{LIMITS.cyclesMax})<input type="number" min={LIMITS.cyclesMin} max={LIMITS.cyclesMax} className="field mt-1 w-full" value={cycles} onChange={(e) => setCycles(Math.min(LIMITS.cyclesMax, Math.max(LIMITS.cyclesMin, Math.floor(Number(e.target.value) || LIMITS.cyclesMin))))} /></label>
            </div>
            <button type="button" className="btn btn-red" disabled={!!busy || !picked.length || !scen.length} onClick={submit}>{busy ?? "Run trial"}</button>
          </>}
        </Panel>
      )}
      {error && <p role="alert" className="hair break-words bg-poppy-deep p-2 text-sm text-paper-light">{error}</p>}

      {current && <TrialReport key={current.id} row={current} handles={handles} onPublish={async (pub) => { const r = await ghPublish({ data: { id: current.id, published: pub } }); if (!r.ok) throw new Error(r.error); setCurrent({ ...current, published: r.data.published }); await loadRuns(); }} />}

      {userId && <Panel title="Your trials">
        {runs == null ? <p className="text-sm">Loading…</p> : !runs.length ? <p className="text-sm">No trials yet. Your saved trials will appear here.</p> :
          <ul className="divide-y divide-ink/10 text-sm">{runs.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="min-w-0"><span className={cn("hair mr-2 px-1 font-mono text-[0.65rem] uppercase", r.status === "done" ? "bg-sprout text-paper-light" : r.status === "failed" ? "bg-poppy-deep text-paper-light" : "bg-paper-deep")}>{r.status}</span>{r.agent_ids.map((id: string) => `@${handles[id] ?? id}`).join(", ")} · {new Date(r.created_at).toLocaleString()}{r.published && " · published"}</span>
            <button type="button" className="btn btn-paper" disabled={!!busy} onClick={() => void open(r.id)}>Open</button>
          </li>)}</ul>}
      </Panel>}

      <Panel title="Verify a bundle file">
        <p className="text-xs">Re-runs a downloaded evidence bundle in your browser with its frozen inputs and synthetic clock — no live garden data. Edited results, configs or inputs are flagged.</p>
        <input type="file" accept="application/json,.json" aria-label="Evidence bundle file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImport(f); }} />
        {imported && <p role="status" className={cn("hair p-2 text-sm", imported.status === "verified" ? "bg-sprout text-paper-light" : "bg-poppy-deep text-paper-light")}><strong className="uppercase">{imported.status}</strong> — {imported.detail}</p>}
      </Panel>
      <MetricDefinitions />
      <p className="text-xs text-ink-soft">Trial evidence can be attached to <Link to="/launchpad" className="underline">launch proposals</Link> as advisory context. It never starts a launch or replaces your review, PQ signature and wallet approval.</p>
    </div>
  );
}
