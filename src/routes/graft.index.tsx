import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader } from "@/components/bits";
import { Panel } from "@/components/pq/ui";
import { GraftRibbon, GraftTrustNote, GraftVerifier, StatusChip } from "@/components/graft/bits";
import { useGarden } from "@/store/garden";
import { graftCreate, graftMine } from "@/lib/graft.functions";
import { FLEURI_POOL } from "@/lib/token";
import { LIMITS, TOOLS, isAddress, type PoolKind, type ToolId } from "@/domain/graft";

export const Route = createFileRoute("/graft/")({
  head: () => ({
    meta: [
      { title: "Graft research steward — fleuri" },
      { name: "description", content: "Approve a bounded, read-only research mandate for one exact agent version. The steward inspects a Meteora pool and saves a private, verifiable report." },
      { property: "og:title", content: "Graft research steward — fleuri" },
      { property: "og:description", content: "Owner-approved, read-only pool research tied to an exact agent version, with replayable evidence and no wallet access." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Hub,
});

const newId = () => crypto.randomUUID();

function Hub() {
  const { state, userId, store } = useGarden();
  const [rows, setRows] = useState<any[] | null>(null);
  const load = () => graftMine().then((r) => setRows(r.ok ? r.mandates : [])).catch(() => setRows([]));
  useEffect(() => { let live = true; setRows(null); if (userId) graftMine().then((r) => live && setRows(r.ok ? r.mandates : [])).catch(() => live && setRows([])); return () => { live = false; }; }, [userId]);
  return (
    <div className="space-y-6">
      <PageHeader title="Graft" kicker="Research steward · v1"><GraftRibbon className="h-12 w-12" /></PageHeader>
      <GraftTrustNote />
      {!userId || !state?.owner ? (
        <Panel title="Your mandates">
          <p className="text-sm">Open a workspace to draft a mandate for one of your own agents. It's free and works before any token bonds or any staking.</p>
          <button type="button" className="btn btn-red mt-2" onClick={() => void store.startSandbox().catch((e: Error) => toast.error(e.message))}>Open a workspace</button>
        </Panel>
      ) : (
        <>
          <Draft onDone={load} />
          <Panel title="Your mandates (private unless you share one)">
            {rows === null ? <p className="text-sm">Loading…</p> : rows.length === 0 ? <EmptyState title="No mandates yet" body="Draft one above, review it, then approve it." /> : (
              <ul className="space-y-2">
                {rows.map((m) => (
                  <li key={m.id} className="hair flex flex-wrap items-center gap-2 bg-paper p-2 text-sm">
                    <StatusChip s={m.status === "active" && Date.parse(m.expires_at) <= Date.now() ? "expired" : m.status} />
                    <span className="min-w-0 flex-1 break-all">@{state.agents[m.agent_id]?.handle ?? m.agent_id} · {m.draft.pool.kind === "dbc" ? "DBC" : "DAMM v2"} {m.draft.pool.address.slice(0, 6)}… · until {new Date(m.expires_at).toLocaleString()}</span>
                    <Link to="/graft/$id" params={{ id: m.id }} className="btn btn-paper">Open</Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
      <Panel title="Verify an evidence file locally"><GraftVerifier /></Panel>
    </div>
  );
}

function Draft({ onDone }: { onDone: () => void }) {
  const { state } = useGarden();
  const mine = useMemo(() => (state?.owner ? Object.values(state.agents).filter((a) => a.ownerId === state.owner!.id && a.status !== "archived") : []), [state]);
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState<PoolKind>("dbc");
  const [pool, setPool] = useState(FLEURI_POOL);
  const [hours, setHours] = useState(24);
  const [runs, setRuns] = useState(2);
  const [ttl, setTtl] = useState(300);
  const [age, setAge] = useState(120);
  const [buy, setBuy] = useState(false);
  const [max, setMax] = useState("1000000");
  const [note, setNote] = useState("");
  const [req, setReq] = useState(newId);
  const [busy, setBusy] = useState(false);
  const agent = mine.find((a) => a.id === agentId) ?? mine[0];
  const tool: ToolId = kind === "dbc" ? "watchtower.dbc_pool" : "damm_v2.pool_account";
  const fresh = <T,>(f: (v: T) => void) => (v: T) => { f(v); setReq(newId()); };
  if (!mine.length) return <Panel title="Draft a mandate"><p className="text-sm">You have no active agents yet.</p><Link to="/me" className="btn btn-red mt-2">Create an agent</Link></Panel>;
  const valid = isAddress(pool) && age <= ttl;
  const submit = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const r = await graftCreate({ data: { requestId: req, terms: { agentId: agent.id, poolKind: kind, pool, tools: [tool], hours, runsPerDay: runs, evidenceTtlSecs: ttl, maxObservationAgeSecs: age, purchaseService: buy ? "botanist.report" : null, purchaseMaxAtomic: buy ? max : "0", note } } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(r.created ? "Draft saved. Open it to review." : "This draft was already saved.");
      setReq(newId()); onDone();
    } catch { toast.error("Could not reach the server. Retrying with the same form is safe."); }
    finally { setBusy(false); }
  };
  const field = "hair mt-1 block w-full bg-paper-light p-2 font-normal";
  return (
    <Panel title="Draft a mandate">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-bold">Agent
          <select className={field} value={agent?.id ?? ""} onChange={(e) => fresh(setAgentId)(e.target.value)}>{mine.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}</select>
        </label>
        <label className="text-sm font-bold">Pool type
          <select className={field} value={kind} onChange={(e) => fresh(setKind)(e.target.value as PoolKind)}><option value="dbc">Meteora DBC (bonding curve)</option><option value="damm_v2">Meteora DAMM v2</option></select>
        </label>
        <label className="text-sm font-bold md:col-span-2">Pool address (mainnet)
          <input className={`${field} num`} value={pool} onChange={(e) => fresh(setPool)(e.target.value.trim())} aria-invalid={!isAddress(pool)} spellCheck={false} />
          {!isAddress(pool) && <span className="text-xs text-poppy-deep">Not a valid 32-byte Solana address.</span>}
          <span className="block text-xs font-normal">Prefilled with the $FLEURI bonding-curve pool. It was launched directly on Meteora, not through fleuri's launchpad.</span>
        </label>
        <p className="text-sm md:col-span-2"><strong>Approved tool:</strong> {TOOLS[tool].label}. No other tools can be added.</p>
        <label className="text-sm font-bold">Expires after <span className="num">{hours}</span> h
          <input type="range" min={1} max={LIMITS.maxDays * 24} value={hours} onChange={(e) => fresh(setHours)(Number(e.target.value))} className="mt-1 block w-full accent-[var(--poppy)]" />
        </label>
        <label className="text-sm font-bold">Runs per day: <span className="num">{runs}</span>
          <input type="range" min={1} max={LIMITS.maxRunsPerDay} value={runs} onChange={(e) => fresh(setRuns)(Number(e.target.value))} className="mt-1 block w-full accent-[var(--poppy)]" />
        </label>
        <label className="text-sm font-bold">Approval evidence TTL (seconds)
          <input type="number" min={60} max={3600} className={field} value={ttl} onChange={(e) => fresh(setTtl)(Number(e.target.value))} />
        </label>
        <label className="text-sm font-bold">Max observation age per run (seconds)
          <input type="number" min={10} max={ttl} className={field} value={age} onChange={(e) => fresh(setAge)(Number(e.target.value))} />
        </label>
        <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" checked={buy} onChange={(e) => fresh(setBuy)(e.target.checked)} className="mt-1" />
          <span>Allow the steward to <em>propose</em> a Botanist report purchase (USDC, paid only by you through the wallet checkout).</span></label>
        {buy && <label className="text-sm font-bold">Proposal cap (USDC atomic units, 6 decimals)
          <input className={`${field} num`} value={max} onChange={(e) => fresh(setMax)(e.target.value.replace(/\D/g, "").slice(0, 7))} />
        </label>}
        <label className="text-sm font-bold md:col-span-2">Note (optional)
          <input className={field} maxLength={280} value={note} onChange={(e) => fresh(setNote)(e.target.value)} />
        </label>
      </div>
      <p className="text-xs">Server limits: {LIMITS.ownerDailyJobs} runs per workspace per UTC day, {LIMITS.maxInflight} at once. Staking or evidence never raises these.</p>
      <button type="button" className="btn btn-red" disabled={busy || !valid} onClick={submit}>{busy ? "Checking the pool…" : "Save draft"}</button>
    </Panel>
  );
}
