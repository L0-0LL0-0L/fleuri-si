// Living passport: dated current chain observations next to the original signed promises.
import { useEffect, useState } from "react";
import { CheckList, Panel, downloadBlob, explorerAddr } from "@/components/pq/ui";
import { pqExportBundle, pqLiving } from "@/lib/pq.functions";

const GROUPS: [string, string][] = [["promise-kept", "Signed promises · current state"], ["lifecycle", "Lifecycle"], ["program", "Program control"], ["liquidity", "Liquidity evidence"]];
export function LivingPanel({ hash, cluster }: { hash: string; cluster: string }) {
  const [r, setR] = useState<any>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function load() { setBusy(true); setErr(""); try { const x = await pqLiving({ data: { hash } }); if (!x.ok) throw new Error(x.error); setR(x.data); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  async function exportIt() { setErr(""); const x = await pqExportBundle({ data: { hash } }); if (!x.ok) { setErr(x.error); return; } downloadBlob(new Blob([JSON.stringify(x.data, null, 2)], { type: "application/json" }), `fleuri-evidence-${hash.slice(0, 16)}.json`); }
  useEffect(() => { void load(); }, [hash]);
  return <Panel title="Living passport · observed now">
    <p className="text-sm">The signed passport above never changes. These are fresh reads of the chain, dated by slot, so you can see whether its promises still hold.</p>
    {busy && !r && <p role="status" className="text-sm">Reading current chain state…</p>}
    {err && <p role="alert" className="text-sm text-poppy-deep">{err}</p>}
    {r?.note && <p className="text-sm">{r.note}</p>}
    {r?.slot && <p className="font-mono text-xs">Observation started at slot {r.slot} (reads span a few slots) · {new Date(r.observedAt).toUTCString()}</p>}
    {r && GROUPS.map(([g, t]) => { const f = r.facts.filter((x: any) => x.group === g); return f.length ? <div key={g} className="space-y-1"><h3 className="font-mono text-[0.65rem] uppercase">{t}</h3><CheckList label={t} checks={f} /><p className="flex flex-wrap gap-2 text-xs">{f.filter((x: any) => x.evidence).map((x: any) => <a key={x.id} className="underline" href={explorerAddr(x.evidence, cluster)} target="_blank" rel="noreferrer">{x.label} evidence ↗</a>)}</p></div> : null; })}
    {!!r?.history?.length && <div><h3 className="font-mono text-[0.65rem] uppercase">Lifecycle changes, as first observed</h3><ol className="text-sm">{r.history.map((h: any, i: number) => <li key={i}>{h.kind.replace(/_/g, " ")} · first observed by fleuri at slot {h.observed_slot}, {new Date(h.observed_at).toUTCString()} (not the event's own transaction) · <span className="font-mono text-xs break-all">{JSON.stringify(h.facts)}</span></li>)}</ol></div>}
    <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-paper" disabled={busy} onClick={() => void load()}>Observe again</button><button type="button" className="btn btn-ink" onClick={() => void exportIt()}>Download evidence bundle</button></div>
    <p className="text-xs">Verify the bundle anywhere with your own RPC on the Verify page, or offline-first with <span className="font-mono">bun scripts/verify-bundle.ts</span>. Memo transactions anchor hashes; Solana itself does not check ML-DSA signatures.</p>
  </Panel>;
}
