import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Panel, downloadBlob } from "@/components/pq/ui";
import { CopyLink } from "@/components/bits";
import { SCENARIO_INFO, BASELINE_COINS, START_CAPITAL, bundleFromStored, verifyBundle, SUPPORTED_ENGINES, type ReplayStatus, type RunResult, type Scenario, type Scorecard, type TrialInput, type TrialOutput } from "@/domain/greenhouse";
import { cn } from "@/lib/utils";

export interface TrialRow {
  id: string; status: string; engine_version: string; agent_ids: string[]; input: TrialInput; output: TrialOutput | null;
  input_hash: string; output_hash: string | null; content_hash: string | null; published: boolean; created_at: string; finished_at: string | null; error: string | null; mine?: boolean;
}

const f2 = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const short = (h: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

export function ExecutionModeNote() {
  return (
    <div className="hair space-y-1 bg-paper-deep p-3 text-xs">
      <p className="font-semibold">Execution mode · rules engine (no AI)</p>
      <p>Trials replay the garden's current scheduled rules engine — the same <code>runCycle</code> and bonding-curve maths the scheduler uses. That engine chooses actions from each agent's <strong>archetype and risk level only</strong>. Free-text strategy and persona are recorded in the frozen policy (and change its hash) but are <strong>not evaluated</strong> by the rules engine; optional manual AI cycles are not part of trials. No AI calls, no credit spend, no model training.</p>
      <p>Everything is a vSOL sandbox stress model on a frozen copy of the public garden market. It is not Meteora mainnet execution and not a forecast.</p>
    </div>
  );
}

function Bar({ v, max, tone, label, lo, hi }: { v: number; max: number; tone: string; label: string; lo?: number; hi?: number }) {
  const pos = (x: number) => 50 + (Math.max(-max, Math.min(max, x)) / max) * 50;
  const a = pos(Math.min(0, v)), b = pos(Math.max(0, v));
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
      <span className="truncate font-mono">{label}</span>
      <span className="relative h-4 bg-paper-deep" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px bg-ink/50" />
        <span className={cn("absolute inset-y-0.5", tone)} style={{ left: `${a}%`, width: `${Math.max(0.5, b - a)}%` }} />
        {lo != null && hi != null && <span className="absolute top-1/2 h-px bg-ink" style={{ left: `${pos(lo)}%`, width: `${Math.max(0.5, pos(hi) - pos(lo))}%` }} />}
      </span>
      <span className="num text-right">{f2(v)}</span>
    </div>
  );
}

export function TrialReport({ row, handles, onPublish }: { row: TrialRow; handles: Record<string, string>; onPublish?: (published: boolean) => Promise<void> }) {
  const out = row.output;
  const input = row.input;
  const [replay, setReplay] = useState<ReplayStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const name = (id: string) => (id === "baseline" ? "buy & hold" : `@${input.policies.find((p) => p.agentId === id)?.handle ?? handles[id] ?? id}`);
  const [sel, setSel] = useState({ agent: input.config.agentIds[0], scenario: input.config.scenarios[0] as Scenario, rep: 0 });
  const trace: RunResult | undefined = useMemo(() => out ? (sel.agent === "baseline" ? out.baselines : out.runs).find((r) => r.agentId === sel.agent && r.scenario === sel.scenario && r.rep === sel.rep) : undefined, [out, sel]);
  if (!out) return <Panel title="Trial result"><p className="text-sm">{row.status === "failed" ? `This trial failed: ${row.error ?? "unknown error"}. No result was saved.` : "This trial has not finished. Nothing is shown until a result is durably saved."}</p></Panel>;
  const maxAbs = Math.max(5, ...out.scorecards.flatMap((s) => [Math.abs(s.returnPct.min), Math.abs(s.returnPct.max)]), ...out.baselines.map((b) => Math.abs(b.returnPct)));
  // The stored row's ORIGINAL checksum claims travel with the bundle; replay verifies all of them.
  const bundle = () => bundleFromStored(row);
  const supported = SUPPORTED_ENGINES.includes(input.engineVersion as any);
  async function doReplay() {
    setBusy("Replaying frozen inputs…");
    try { await new Promise((r) => setTimeout(r, 30)); setReplay(verifyBundle(bundle())); }
    catch (e) { setReplay({ status: "invalid", detail: (e as Error).message }); }
    finally { setBusy(null); }
  }
  return (
    <div className="space-y-4">
      <Panel title="Trial evidence">
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <div><dt className="inline font-semibold">Engine:</dt> <dd className="inline font-mono">{input.engineVersion} · {input.scenarioVersion}</dd></div>
          <div><dt className="inline font-semibold">Seed:</dt> <dd className="inline font-mono">{input.config.seed}</dd></div>
          <div><dt className="inline font-semibold">Sample:</dt> <dd className="inline">{input.config.repetitions} repetition(s) × {input.config.cycles} cycles per scenario</dd></div>
          <div><dt className="inline font-semibold">Market frozen:</dt> <dd className="inline">{new Date(input.market.frozenAt).toISOString().replace("T", " ").slice(0, 16)} UTC · {input.market.coins.length} coins</dd></div>
          <div className="break-all"><dt className="inline font-semibold">Input hash:</dt> <dd className="inline font-mono">{short(row.input_hash)}</dd></div>
          <div className="break-all"><dt className="inline font-semibold">Content hash:</dt> <dd className="inline font-mono">{short(row.content_hash)}</dd></div>
        </dl>
        <ul className="space-y-1 text-xs">{input.policies.map((p) => <li key={p.agentId} className="break-words"><strong>@{p.handle}</strong> · {p.archetype}, risk {p.risk} · policy <span className="font-mono">{short(p.policyHash)}</span></li>)}</ul>
        <p className="text-xs text-ink-soft">SHA-256 checksums detect edits; they are not signatures, and nothing here is anchored on chain.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-ink" disabled={!!busy || !supported} onClick={() => void doReplay()}>{busy ?? (supported ? "Replay & verify" : "Replay unavailable")}</button>
          <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(bundle(), null, 1)], { type: "application/json" }), `greenhouse-${row.id.slice(0, 8)}.json`)}>Download evidence bundle</button>
          {row.mine && onPublish && <button type="button" className={cn("btn", row.published ? "btn-paper" : "btn-red")} disabled={!!busy} onClick={() => { setBusy(row.published ? "Unpublishing…" : "Publishing…"); onPublish(!row.published).then(() => toast.success(row.published ? "Report is private again" : "Report published"), (e) => toast.error((e as Error).message)).finally(() => setBusy(null)); }}>{row.published ? "Make private" : "Publish report"}</button>}
          {row.published && <CopyLink path={`/greenhouse/r/${row.id}`} label="Copy public link" />}
        </div>
        <p className="text-xs">{row.published ? "Published: anyone with the link can read this sanitized report." : row.mine ? "Private: only your workspace can see this report until you publish it." : ""}</p>
        {!supported && <p className="hair bg-paper-deep p-2 text-xs">Recorded with engine {input.engineVersion}, which this build does not support. The original records can still be downloaded unchanged, but they cannot be replayed or relabelled here.</p>}
        {replay && <p role="status" className={cn("hair p-2 text-sm", replay.status === "verified" ? "bg-sprout text-paper-light" : "bg-poppy-deep text-paper-light")}><strong className="uppercase">{replay.status}</strong> — {replay.detail}</p>}
      </Panel>

      <Panel title="Comparison · mean return on net liquidation value">
        <p className="text-xs text-ink-soft">Bar = mean across repetitions; thin line = min–max range. Baseline = buy & hold under the same tape.</p>
        {input.config.scenarios.map((sc) => {
          const cards = out.scorecards.filter((c) => c.scenario === sc);
          const base = out.baselines.filter((b) => b.scenario === sc).map((b) => b.returnPct);
          const bm = base.reduce((a, b) => a + b, 0) / (base.length || 1);
          return (
            <div key={sc} className="space-y-1">
              <p className="text-xs font-semibold">{SCENARIO_INFO[sc].label}</p>
              {cards.map((c) => <Bar key={c.agentId} label={name(c.agentId)} v={c.returnPct.mean} lo={c.returnPct.min} hi={c.returnPct.max} max={maxAbs} tone={c.returnPct.mean >= 0 ? "bg-sprout" : "bg-poppy"} />)}
              <Bar label="buy & hold" v={bm} lo={Math.min(...base)} hi={Math.max(...base)} max={maxAbs} tone="bg-ink" />
            </div>
          );
        })}
      </Panel>

      {input.config.scenarios.map((sc) => <ScenarioCard key={sc} scenario={sc} cards={out.scorecards.filter((c) => c.scenario === sc)} baselines={out.baselines.filter((b) => b.scenario === sc)} name={name} />)}

      <Panel title="Action & event trace">
        <div className="flex flex-wrap gap-2 text-sm">
          <select aria-label="Participant" className="field" value={sel.agent} onChange={(e) => setSel({ ...sel, agent: e.target.value })}>{[...input.config.agentIds, "baseline"].map((id) => <option key={id} value={id}>{name(id)}</option>)}</select>
          <select aria-label="Scenario" className="field" value={sel.scenario} onChange={(e) => setSel({ ...sel, scenario: e.target.value as Scenario })}>{input.config.scenarios.map((s) => <option key={s} value={s}>{SCENARIO_INFO[s].label}</option>)}</select>
          <select aria-label="Repetition" className="field" value={sel.rep} onChange={(e) => setSel({ ...sel, rep: Number(e.target.value) })}>{Array.from({ length: input.config.repetitions }, (_, i) => <option key={i} value={i}>repetition {i + 1}</option>)}</select>
        </div>
        {trace && <>
          <p className="text-xs">Return {f2(trace.returnPct)} · max drawdown {trace.maxDrawdownPct.toFixed(2)}% · {trace.attempts} economic attempts ({trace.successes} ok, {trace.rejections} rejected, {trace.faults} injected faults)</p>
          <ol className="hair max-h-80 divide-y divide-ink/10 overflow-y-auto bg-paper text-xs">
            {trace.trace.map((t, i) => {
              const shocks = out.tapes[`${sel.scenario}:${sel.rep}`]?.filter((s) => s.cycle === t[0] && s.kind !== "fault") ?? [];
              const lastOfCycle = trace.trace[i + 1]?.[0] !== t[0];
              return (
                <li key={i} className="grid grid-cols-[2.5rem_minmax(0,1fr)_5rem] gap-2 p-1.5">
                  <span className="font-mono text-ink-soft">#{t[0] + 1}</span>
                  <span className="min-w-0 break-words">
                    <strong>{t[1]}</strong>{t[3] && <> ${t[3]}</>}{t[4] != null && <> · {t[4].toFixed(4)} vSOL</>}
                    <span className={cn("ml-1 font-mono uppercase", t[2] === "ok" ? "text-sprout" : t[2] === "idle" ? "text-ink-soft" : "text-poppy-deep")}>{t[2]}</span>
                    {t[5] && <span className="block text-ink-soft">{t[5]}</span>}
                    {shocks.map((s, j) => <span key={j} className="block text-poppy-deep">tape: {s.kind === "liquidity" ? `${(s.magnitude * 100).toFixed(0)}% of $${s.symbol} reserves withdrawn` : `outside seller removed ${(s.magnitude * 100).toFixed(1)}% of $${s.symbol} vSOL`}</span>)}
                  </span>
                  <span className="num text-right">{lastOfCycle ? trace.nlv[t[0]]?.toFixed(4) : <span className="text-ink-soft">same cycle ↓</span>}</span>
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-ink-soft">Right column: net liquidation value (vSOL) after that cycle — shown once on the cycle's last row when several actions share a cycle (e.g. the baseline's three entry buys).</p>
        </>}
      </Panel>
    </div>
  );
}

function ScenarioCard({ scenario, cards, baselines, name }: { scenario: Scenario; cards: Scorecard[]; baselines: RunResult[]; name: (id: string) => string }) {
  const b = baselines.map((x) => x.returnPct);
  return (
    <Panel title={`Scorecard · ${SCENARIO_INFO[scenario].label}`}>
      <p className="text-xs text-ink-soft">{SCENARIO_INFO[scenario].detail}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-xs">
          <thead><tr className="border-b border-ink/30"><th className="p-1">Participant</th><th className="p-1">Return mean (min…max, sd)</th><th className="p-1">Max drawdown mean (worst)</th><th className="p-1">vs baseline (paired)</th><th className="p-1">Attempts · ok/rej/fault</th><th className="p-1">Success</th><th className="p-1">n</th></tr></thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.agentId} className="border-b border-ink/10">
                <td className="p-1 font-semibold">{name(c.agentId)}</td>
                <td className="num p-1">{f2(c.returnPct.mean)} ({f2(c.returnPct.min)}…{f2(c.returnPct.max)}, {c.returnPct.sd.toFixed(2)})</td>
                <td className="num p-1">{c.maxDrawdownPct.mean.toFixed(2)}% ({c.maxDrawdownPct.max.toFixed(2)}%)</td>
                <td className="num p-1">{f2(c.vsBaselinePct.mean)} ({f2(c.vsBaselinePct.min)}…{f2(c.vsBaselinePct.max)})</td>
                <td className="num p-1">{c.attempts} · {c.successes}/{c.rejections}/{c.faults}</td>
                <td className="num p-1">{c.successRate == null ? "unavailable (0 attempts)" : `${c.successRate.toFixed(1)}%`}</td>
                <td className="num p-1">{c.returnPct.n}</td>
              </tr>
            ))}
            <tr><td className="p-1 font-semibold">buy & hold</td><td className="num p-1">{f2(b.reduce((x, y) => x + y, 0) / (b.length || 1))} ({f2(Math.min(...b))}…{f2(Math.max(...b))})</td><td className="num p-1">{(baselines.reduce((x, y) => x + y.maxDrawdownPct, 0) / (baselines.length || 1)).toFixed(2)}%</td><td className="p-1">—</td><td className="num p-1">{baselines.reduce((x, y) => x + y.attempts, 0)}</td><td className="p-1">—</td><td className="num p-1">{b.length}</td></tr>
          </tbody>
        </table>
      </div>
      {cards.some((c) => c.returnPct.n < 5) && <p className="text-xs">Small sample: {cards[0]?.returnPct.n} repetition(s). Treat differences as anecdotal — this is not a safety rating, an approval, graduation readiness or a yield estimate.</p>}
    </Panel>
  );
}

export function MetricDefinitions() {
  return (
    <details className="hair bg-paper-light p-3 text-xs">
      <summary className="cursor-pointer font-semibold">Exact metric definitions</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li><strong>Start capital:</strong> every participant and the baseline start with exactly {START_CAPITAL} vSOL cash and no holdings, regardless of their live balances.</li>
        <li><strong>Net liquidation value (NLV):</strong> cash + for each holding, the vSOL received by selling the whole position into that coin's current curve (constant product, 1% fee, full price impact) — exactly what the engine's full sell pays, including the creator half of that fee when the participant created the coin (frozen market coins have no participant creator). It is lower than the mid-price value; positions are valued independently.</li>
        <li><strong>Return:</strong> (final NLV − {START_CAPITAL}) ÷ {START_CAPITAL}. <strong>Max drawdown:</strong> largest fall from a running NLV peak (starting at {START_CAPITAL}), as a % of that peak, sampled after each cycle.</li>
        <li><strong>Attempts:</strong> cycles where the engine chose buy, sell or launch. Posts, replies, follows and rests are not attempts. <strong>Success rate</strong> = successes ÷ attempts; shown as unavailable when there were no attempts.</li>
        <li><strong>Rejected</strong> = the engine refused the action (e.g. not enough vSOL). <strong>Fault</strong> = an injected execution failure; all economic effects are rolled back.</li>
        <li><strong>Baseline:</strong> buy & hold — {START_CAPITAL} vSOL split equally across the {BASELINE_COINS} deepest coins (largest vSOL reserve) of the frozen market, bought through the same engine at the first cycle without an injected fault, then held. Same fee, price impact and shock tape.</li>
        <li><strong>vs baseline:</strong> per repetition, agent return − baseline return in the same scenario and repetition; then mean/min/max.</li>
        <li><strong>Tape:</strong> shocks come from a separate random stream seeded only by seed, scenario and repetition, so every participant meets the same shocks in its own copy of the market.</li>
      </ul>
    </details>
  );
}
