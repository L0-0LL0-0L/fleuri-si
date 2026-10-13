import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader, SandboxBadge } from "@/components/bits";
import { Panel, downloadBlob } from "@/components/pq/ui";
import { SealedFlower } from "@/components/bloom/SealedFlower";
import { BloomTrustNote, Countdown, phaseLabel } from "@/components/bloom/bits";
import { BloomVerifier } from "@/components/bloom/BloomVerifier";
import { EVENT_INFO, MANIFEST_FORMAT, type BloomEvent, type EntryResult, type RoundOutput } from "@/domain/bloom";
import { SCENARIO_INFO, policyHash, type Scenario } from "@/domain/greenhouse";
import type { Archetype } from "@/domain/types";
import { bloomAttach, bloomBundle, bloomMine, bloomProposals, bloomRound, bloomSubmit } from "@/lib/bloom.functions";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/blind-bloom/$id")({
  loader: ({ params }) => bloomRound({ data: { id: params.id } }),
  head: () => ({
    meta: [
      { title: "Blind Bloom round — fleuri" },
      { name: "description", content: "One sealed-strategy sandbox round: commitments, hidden seed reveal, paired comparisons, Brier scores and a replayable evidence bundle." },
      { property: "og:title", content: "Blind Bloom round — fleuri" },
      { property: "og:description", content: "Sealed vSOL sandbox strategies revealed and scored against the same frozen market and hidden stress tape." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  errorComponent: ({ error }) => <EmptyState title="Round could not load" body={(error as Error).message} action={<Link to="/blind-bloom" className="btn btn-paper">All rounds</Link>} />,
  component: RoundPage,
});

const ARCH: Archetype[] = ["pollinator", "gardener", "weed", "botanist", "compost"];
const f2 = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(2));
const newId = () => crypto.randomUUID();

function RoundPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  if (!data.ok) return <EmptyState title="Round not found" body={data.error} action={<Link to="/blind-bloom" className="btn btn-paper">All rounds</Link>} />;
  const { round: r, entries } = data;
  const offset = Date.parse(data.serverNow) - Date.now();
  const open = r.status === "open" && Date.parse(r.commit_closes_at) > Date.parse(data.serverNow);
  const revealed = !!r.seed_reveal;
  const out = r.output as RoundOutput | null;
  return (
    <div className="space-y-6">
      <PageHeader title={`Round ${r.seq}: ${r.title}`} kicker="Blind Bloom"><SandboxBadge /></PageHeader>
      <Link to="/blind-bloom" className="text-sm underline">← All rounds</Link>
      <ol className="grid grid-cols-3 gap-2 text-center text-xs" aria-label="Round phases">
        {[["Commit", open], ["Reveal", !open && r.status !== "scored" && r.status !== "failed"], ["Scores", r.status === "scored" || r.status === "failed"]].map(([l, on]) => (
          <li key={String(l)} className={`hair p-2 font-bold ${on ? "bg-poppy text-paper-light" : "bg-paper-light"}`} aria-current={on ? "step" : undefined}>{String(l)}</li>
        ))}
      </ol>
      <p className="chip">{phaseLabel(r.status, r.commit_closes_at, offset)}</p>
      {open && <p className="text-sm">Commit phase closes in <Countdown to={r.commit_closes_at} offset={offset} /> (server time, {new Date(r.commit_closes_at).toUTCString()}).</p>}
      {!open && r.status === "open" && <button type="button" className="btn btn-ink" onClick={() => router.invalidate()}>Reveal and score now</button>}
      {r.status === "evaluating" && <button type="button" className="btn btn-paper" onClick={() => router.invalidate()}>Check evaluation progress</button>}
      <BloomTrustNote />

      <Panel title="Fixed rules (set before the round opened)">
        <p className="text-sm">{r.rules.summary}</p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 text-sm">
          {r.rules.scenarios.map((s: Scenario) => <li key={s} className="hair bg-paper-light p-2"><strong>{SCENARIO_INFO[s].label}.</strong> {SCENARIO_INFO[s].detail}</li>)}
        </ul>
        <p className="mt-2 text-sm">Compute budget: {r.rules.scenarios.length} scenarios × {r.rules.repetitions} repetitions × {r.rules.cycles} cycles per entry, run twice (sealed settings and the agent's unchanged base policy) plus one buy-and-hold baseline, on {r.market.coins.length} frozen coins. At most {r.rules.maxEntries} entries.</p>
        <p className="mt-2 text-sm"><strong>Scoring:</strong> ranked by mean paired return difference vs buy & hold over every scenario run, then lower Brier score. Forecasts are scored with the Brier score (mean squared error of your probability vs what happened, 0 is perfect, always-50% scores 0.25). Sample counts are shown; no confidence intervals are claimed.</p>
        <dl className="mt-2 grid gap-1 text-xs num break-all">
          <div><dt className="inline font-bold">Seed commitment: </dt><dd className="inline">{r.seed_commit}</dd></div>
          <div><dt className="inline font-bold">Revealed seed: </dt><dd className="inline">{r.seed_reveal ?? "sealed until the deadline"}</dd></div>
          <div><dt className="inline font-bold">Rules hash: </dt><dd className="inline">{r.rules_hash}</dd></div>
          <div><dt className="inline font-bold">Frozen market hash: </dt><dd className="inline">{r.market_hash}</dd></div>
        </dl>
      </Panel>

      {open && <SealEditor roundId={r.id} events={r.rules.events} onDone={() => router.invalidate()} />}

      <Panel title={`Sealed entries (${entries.length})`}>
        {entries.length === 0 ? <p className="text-sm">No sealed entries yet.</p> : (
          <ul className="flex flex-wrap gap-3">
            {entries.map((e: any) => <li key={e.id}><SealedFlower commit={e.commit} revealed={revealed} label={`Entry by ${e.agent_id}`} /><p className="text-center text-[11px]">{e.agent_id}</p></li>)}
          </ul>
        )}
        <p className="mt-2 text-xs">Commitments are published as soon as an entry is sealed. Strategies stay hidden until the deadline.</p>
      </Panel>

      {r.status === "failed" && <div role="alert" className="hair bg-paper-light p-3 text-sm"><strong>Evaluation failed:</strong> {r.error}. The seed and every commitment are still published below; no scores were produced.</div>}
      {out && <Scoreboard out={out} entries={entries} />}
      <MyEntries roundId={r.id} scored={r.status === "scored"} />

      <Panel title="Evidence bundle">
        <p className="text-sm">The bundle contains only what is public now: rules, frozen market, seed commitment and commitments, plus — after the deadline — the revealed seed, sealed strategies, outputs and checksums. Failed and invalid entries are included.</p>
        <button type="button" className="btn btn-red mt-2" onClick={async () => {
          const b = await bloomBundle({ data: { id: r.id } });
          if (!b.ok) { toast.error(b.error); return; }
          downloadBlob(new Blob([b.bundle], { type: "application/json" }), `blind-bloom-round-${r.seq}.json`);
        }}>Download bundle</button>
        <div className="mt-4"><BloomVerifier /></div>
        <p className="mt-2 text-xs">CLI: <code className="num">bun scripts/verify-bloom.ts blind-bloom-round-{r.seq}.json</code></p>
      </Panel>
    </div>
  );
}

function Scoreboard({ out, entries }: { out: RoundOutput; entries: any[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rank = new Map(out.ranking.map((id, i) => [id, i + 1]));
  const rows = [...out.entries].sort((a, b) => (rank.get(a.entryId) ?? 999) - (rank.get(b.entryId) ?? 999));
  return (
    <Panel title="Scoreboard">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs"><th className="p-1">#</th><th className="p-1">Agent</th><th className="p-1">n</th><th className="p-1">vs buy & hold (mean ± sd, pts)</th><th className="p-1">Brier</th><th className="p-1">Policy versions</th><th className="p-1"></th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.entryId} className="border-t border-ink align-top">
                <td className="p-1 num">{rank.get(e.entryId) ?? "—"}</td>
                <td className="p-1">{e.agentId}{e.status === "invalid" && <p className="text-xs text-destructive">Invalid: {e.reason}</p>}</td>
                <td className="p-1 num">{e.n}</td>
                <td className="p-1 num">{e.overallVsBaseline ? `${f2(e.overallVsBaseline.mean)} ± ${f2(e.overallVsBaseline.sd)}` : "—"}</td>
                <td className="p-1 num">{f2(e.brier)} <span className="text-xs">(ref {f2(e.referenceBrier)})</span></td>
                <td className="p-1 num text-[11px]">base {e.basePolicyHash.slice(0, 8)} → sealed {e.sealedPolicyHash?.slice(0, 8) ?? "—"}</td>
                <td className="p-1">{e.status === "scored" && <button type="button" className="btn btn-paper" aria-expanded={openId === e.entryId} onClick={() => setOpenId(openId === e.entryId ? null : e.entryId)}>{openId === e.entryId ? "Hide" : "Details"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openId && <EntryDetail e={out.entries.find((x) => x.entryId === openId)!} />}
      <p className="mt-2 text-xs">{entries.length} sealed, {out.entries.filter((e) => e.status === "scored").length} scored, {out.entries.filter((e) => e.status === "invalid").length} invalid. Every entry is listed; no seeds or runs are hand-picked.</p>
    </Panel>
  );
}

function EntryDetail({ e }: { e: EntryResult }) {
  return (
    <div className="mt-3 space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left"><th className="p-1">Scenario</th><th className="p-1">n</th><th className="p-1">Sealed return %</th><th className="p-1">Base policy %</th><th className="p-1">Buy & hold %</th><th className="p-1">Wins vs B&H</th><th className="p-1">Wins vs base</th><th className="p-1">Max drawdown %</th><th className="p-1">Attempts / rejected / faulted</th></tr></thead>
          <tbody>{e.scenarios.map((s) => (
            <tr key={s.scenario} className="border-t border-ink">
              <td className="p-1">{SCENARIO_INFO[s.scenario].label}</td><td className="p-1 num">{s.n}</td><td className="p-1 num">{f2(s.sealedReturn.mean)}</td><td className="p-1 num">{f2(s.baseReturn.mean)}</td><td className="p-1 num">{f2(s.baselineReturn.mean)}</td>
              <td className="p-1 num">{s.winsVsBaseline}/{s.n}</td><td className="p-1 num">{s.winsVsBasePolicy}/{s.n}</td><td className="p-1 num">{f2(s.maxDrawdown.max)}</td><td className="p-1 num">{s.attempts} / {s.rejections} / {s.faults}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 text-xs">
        {e.events.map((x) => <li key={x.event} className="hair bg-paper-light p-2"><strong>{EVENT_INFO[x.event].label}</strong>: forecast {x.forecast}%, happened {x.hits}/{x.n}, Brier {f2(x.brier)}</li>)}
      </ul>
    </div>
  );
}

function SealEditor({ roundId, events, onDone }: { roundId: string; events: BloomEvent[]; onDone: () => void }) {
  const { state, userId, store } = useGarden();
  const mine = useMemo(() => (state?.owner ? Object.values(state.agents).filter((a) => a.ownerId === state.owner!.id && a.status !== "archived") : []), [state]);
  const [agentId, setAgentId] = useState("");
  const agent = mine.find((a) => a.id === agentId) ?? mine[0];
  const [arch, setArch] = useState<Archetype>("gardener");
  const [risk, setRisk] = useState(3);
  const [preds, setPreds] = useState<Record<string, number>>(() => Object.fromEntries(events.map((e) => [e, 50])));
  const [requestId, setRequestId] = useState(newId);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (agent) { setArch(agent.archetype); setRisk(agent.risk); } }, [agent?.id]);
  if (!userId || !state?.owner) return (
    <Panel title="Seal a strategy">
      <p className="text-sm">Open a workspace to enter one of your own agents. Entry is free and works before any token bonds.</p>
      <button type="button" className="btn btn-red mt-2" onClick={() => void store.startSandbox().catch((e: Error) => toast.error(e.message))}>Open a workspace to enter</button>
    </Panel>
  );
  if (!mine.length) return (
    <Panel title="Seal a strategy"><p className="text-sm">You have no active agents yet.</p><Link to="/me" className="btn btn-red mt-2">Create an agent</Link></Panel>
  );
  const submit = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const manifest = { format: MANIFEST_FORMAT, agentId: agent.id, basePolicyHash: policyHash(agent), settings: { archetype: arch, risk }, predictions: Object.fromEntries(events.map((e) => [e, Math.round(preds[e] ?? 50)])) };
      const r = await bloomSubmit({ data: { roundId, requestId, manifest } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(r.created ? `Sealed. Commitment ${r.commit.slice(0, 10)}… is now public.` : "Already sealed with this exact strategy.");
      setRequestId(newId()); onDone();
    } catch { toast.error("Could not reach the server. Your request id is kept, so retrying is safe."); }
    finally { setBusy(false); }
  };
  return (
    <Panel title="Seal a strategy">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-bold">Your agent
          <select className="hair mt-1 block w-full bg-paper-light p-2 font-normal" value={agent?.id ?? ""} onChange={(e) => { setAgentId(e.target.value); setRequestId(newId()); }}>
            {mine.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">Sealed archetype (engine setting)
          <select className="hair mt-1 block w-full bg-paper-light p-2 font-normal" value={arch} onChange={(e) => { setArch(e.target.value as Archetype); setRequestId(newId()); }}>
            {ARCH.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">Sealed risk: <span className="num">{risk}</span>
          <input type="range" min={1} max={5} step={1} value={risk} onChange={(e) => { setRisk(Number(e.target.value)); setRequestId(newId()); }} className="mt-1 block w-full accent-[var(--poppy)]" />
        </label>
      </div>
      <p className="mt-2 text-xs">These settings change the rules engine's trade weights and sizing. Your saved agent is not modified; its current policy ({agent ? policyHash(agent).slice(0, 10) : ""}…) is frozen as the base for the paired comparison.</p>
      <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
        <legend className="text-sm font-bold">Your forecasts (probability across every scenario run)</legend>
        {events.map((e) => (
          <label key={e} className="hair bg-paper-light p-2 text-xs">{EVENT_INFO[e].label}: <span className="num font-bold">{preds[e]}%</span>
            <input type="range" min={0} max={100} step={1} value={preds[e]} onChange={(x) => { setPreds({ ...preds, [e]: Number(x.target.value) }); setRequestId(newId()); }} className="block w-full accent-[var(--poppy)]" aria-describedby={`ev-${e}`} />
            <span id={`ev-${e}`} className="block">{EVENT_INFO[e].detail}</span>
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn btn-red mt-3" disabled={busy || !agent} onClick={submit}>{busy ? "Sealing…" : "Seal strategy"}</button>
      <p className="mt-1 text-xs">Sealed entries cannot be edited. One entry per agent policy version, up to 3 per round.</p>
    </Panel>
  );
}

function MyEntries({ roundId, scored }: { roundId: string; scored: boolean }) {
  const { userId } = useGarden();
  const [rows, setRows] = useState<any[] | null>(null);
  const [link, setLink] = useState<{ entry: any; proposals: any[] } | null>(null);
  useEffect(() => {
    let live = true; setRows(null); setLink(null);
    if (userId) bloomMine().then((r) => { if (live) setRows(r.ok ? r.entries.filter((e: any) => e.round_id === roundId) : []); }).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [userId, roundId]);
  if (!userId || !rows?.length) return null;
  return (
    <Panel title="Your sealed entries (only you can see these settings before the deadline)">
      <ul className="space-y-2 text-sm">
        {rows.map((e) => (
          <li key={e.id} className="hair bg-paper-light p-2">
            <p><strong>{e.agent_id}</strong> · {e.manifest.settings.archetype}, risk {e.manifest.settings.risk} · forecasts {Object.entries(e.manifest.predictions).map(([k, v]) => `${EVENT_INFO[k as BloomEvent].label} ${v}%`).join(", ")}</p>
            <p className="num text-[11px] break-all">commit {e.commit}</p>
            {scored && <button type="button" className="btn btn-paper mt-1" onClick={async () => {
              const p = await bloomProposals({ data: { agentId: e.agent_id } });
              if (!p.ok) { toast.error(p.error); return; }
              setLink({ entry: e, proposals: (p.proposals ?? []).filter((x: any) => x.origin_policy_hash === e.base_policy_hash) });
            }}>Link as launch-proposal evidence</button>}
          </li>
        ))}
      </ul>
      {link && (
        <div className="mt-3 text-sm">
          {link.proposals.length === 0 ? <p>No launch proposals were drafted by this agent with the same policy version.</p> : (
            <ul className="space-y-1">{link.proposals.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">{p.name} (${p.symbol}) · {p.status}
                <button type="button" className="btn btn-ink" onClick={async () => { const r = await bloomAttach({ data: { proposalId: p.id, entryId: link.entry.id } }); r.ok ? toast.success("Linked as evidence. Approval still needs your human review on the launchpad.") : toast.error(r.error); }}>Link</button>
              </li>))}</ul>
          )}
          <button type="button" className="btn btn-paper mt-2" onClick={() => setLink(null)}>Close</button>
        </div>
      )}
    </Panel>
  );
}
