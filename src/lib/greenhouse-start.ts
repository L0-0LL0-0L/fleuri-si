// Greenhouse trial start/recovery orchestration. Pure apart from the injected db client, so it is unit-testable.
type GMod = typeof import("@/domain/greenhouse");
type StartResult = { ok: true; data: { id: string; status: string; recovered: boolean } } | { ok: false; error: string };
/** Pure orchestration (testable with a fake db): lookup → claim lease → compute → fenced finalize. */
export async function startTrial(G: GMod, db: any, owner: string, data: { requestId: string; config: any }, live: () => Promise<any>): Promise<StartResult> {
  const config = G.normalizeConfig(data.config);
  const found = await db.from("greenhouse_runs").select("id,status,input,input_hash").eq("owner_id", owner).eq("request_id", data.requestId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  let input: unknown, ih: string;
  if (found.data) {
    if (!G.sameConfig(config, found.data.input?.config)) return { ok: false, error: "This request id was already used with different trial settings." };
    if (found.data.status !== "running") return { ok: true, data: { id: found.data.id, status: found.data.status, recovered: true } };
    input = found.data.input; ih = found.data.input_hash; // frozen; never rebuilt from live data
  } else {
    const g = await live(); // public ecosystem only: no owner row is loaded
    const policies = config.agentIds.map((id: string) => { const a = g.agents[id]; if (!a) throw new Error("One of the selected agents no longer exists."); return G.snapshotPolicy(a); });
    const fresh = G.makeInput(config, G.freezeMarket(g, Date.now()), policies);
    input = fresh; ih = G.inputHash(fresh);
  }
  const claim = await db.rpc("greenhouse_claim_lease", { _owner: owner, _request: data.requestId, _engine: (input as any).engineVersion, _agents: (input as any).config.agentIds, _input: input, _input_hash: ih });
  if (claim.error) throw new Error(claim.error.message);
  const row = claim.data as { id: string; status: string; acquired: boolean; lease: string | null; attempts: number; input: unknown; input_hash: string };
  if (!row.acquired) return { ok: true, data: { id: row.id, status: row.status, recovered: !!found.data || row.attempts > 1 } };
  const lease = row.lease!;
  const failRun = async (reason: string) => { await db.rpc("greenhouse_fail_lease", { _id: row.id, _owner: owner, _lease: lease, _reason: reason.slice(0, 300) }); };
  let restored;
  try { restored = G.restoreInput(row.input, row.input_hash); } // the STORED row, even if a concurrent creator won
  catch (e) { await failRun(`Stored inputs rejected: ${(e as Error).message}`); return { ok: false, error: (e as Error).message }; }
  let output;
  try { output = G.runTrial(restored); } catch (e) { await failRun((e as Error).message); return { ok: false, error: (e as Error).message }; }
  const oh = G.outputHash(output);
  const fin = await db.rpc("greenhouse_finalize_lease", { _id: row.id, _owner: owner, _lease: lease, _input_hash: row.input_hash, _output: output, _output_hash: oh, _content_hash: G.contentHash(row.input_hash, oh) });
  if (fin.error) throw new Error(fin.error.message); // stale lease / terminal failure: leave the row to its current owner
  return { ok: true, data: { id: row.id, status: "done", recovered: row.attempts > 1 } };
}

