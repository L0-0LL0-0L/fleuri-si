import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ConfigSchema } from "@/domain/greenhouse";

const uuid = z.string().uuid();
const LIST_COLS = "id,status,engine_version,agent_ids,input_hash,output_hash,content_hash,published,published_at,attempts,error,created_at,finished_at";
const FULL_COLS = `${LIST_COLS},input,output`;
const fail = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message.replace(/^.*?ERROR:\s*/, "").slice(0, 240) : "Something went wrong." });

function publicClient() {
  return import("@supabase/supabase-js").then(({ createClient }) => {
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    return createClient(process.env["SUPABASE_URL"]!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
    });
  });
}

/**
 * Start or recover a trial. Idempotent per (owner, requestId). The stored request is looked up
 * FIRST, so recovery never reads live agents/market. Only the caller that acquires the lease
 * computes and finalizes; finalize/fail are fenced by that lease token.
 */
export const ghStart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: uuid, config: ConfigSchema }).strict().parse(d))
  .handler(async ({ data, context }) => {
    try {
      const G = await import("@/domain/greenhouse");
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      return await startTrial(G, supabaseAdmin as any, context.userId, data, async () => (await import("./garden.server")).peekGarden(null));
    } catch (e) { return fail(e); }
  });

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

/** The caller's own runs. owner_id isn't exposed through the Data API, so scope with the service role after authentication. */
export const ghMyRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const r = await (supabaseAdmin as any).from("greenhouse_runs").select(LIST_COLS).eq("owner_id", context.userId).order("created_at", { ascending: false }).limit(30);
    return r.error ? fail(new Error(r.error.message)) : { ok: true as const, data: r.data as any[] };
  });

/** A run the caller may read: their own (RLS) or any published one. */
export const ghRun = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const r = await (context.supabase as any).from("greenhouse_runs").select(FULL_COLS).eq("id", data.id).maybeSingle();
    if (r.error) return fail(new Error(r.error.message));
    if (!r.data) return { ok: false as const, error: "Trial not found, or it is private to another workspace." };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mine = await (supabaseAdmin as any).from("greenhouse_runs").select("id").eq("id", data.id).eq("owner_id", context.userId).maybeSingle();
    return { ok: true as const, data: { ...r.data, mine: !!mine.data } };
  });

/** Public read: published reports only (RLS on the publishable key). */
export const ghPublicRun = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data }) => {
    const db = await publicClient();
    const r = await (db as any).from("greenhouse_runs").select(FULL_COLS).eq("id", data.id).maybeSingle();
    if (r.error) return fail(new Error(r.error.message));
    return r.data ? { ok: true as const, data: { ...r.data, mine: false } } : { ok: false as const, error: "This trial report is not published." };
  });

export const ghPublish = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, published: z.boolean() }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const r = await supabaseAdmin.rpc("greenhouse_set_published", { _id: data.id, _owner: context.userId, _published: data.published });
    return r.error ? fail(new Error(r.error.message)) : { ok: true as const, data: { published: (r.data as any).published as boolean } };
  });

export const ghAttach = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ proposalId: uuid, runId: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const r = await supabaseAdmin.rpc("greenhouse_attach_evidence", { _owner: context.userId, _proposal: data.proposalId, _run: data.runId });
    return r.error ? fail(new Error(r.error.message)) : { ok: true as const, data: r.data as any };
  });

/** The caller's own evidence for these proposals (owner RLS). */
export const ghEvidence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ proposalIds: z.array(uuid).max(50) }).strict().parse(d))
  .handler(async ({ data, context }) => {
    if (!data.proposalIds.length) return { ok: true as const, data: [] as any[] };
    const r = await (context.supabase as any).from("greenhouse_evidence").select("id,proposal_id,run_id,origin_agent_id,run_policy_hash,proposal_policy_hash,engine_version,content_hash,repetitions,scenarios,attached_at").in("proposal_id", data.proposalIds).order("attached_at", { ascending: false });
    return r.error ? fail(new Error(r.error.message)) : { ok: true as const, data: r.data as any[] };
  });
