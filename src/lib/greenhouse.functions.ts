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
 * Start or recover a trial. Idempotent per (owner, requestId): the first call freezes the
 * public market + policy snapshots; every retry re-uses exactly those stored inputs.
 */
export const ghStart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: uuid, config: ConfigSchema }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    try {
      const G = await import("@/domain/greenhouse");
      const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
      const { peekGarden } = await import("./garden.server");
      const live = await peekGarden(null); // public ecosystem only: no owner row is loaded
      const policies = data.config.agentIds.map((id) => {
        const a = live.agents[id];
        if (!a) throw new Error("One of the selected agents no longer exists.");
        return G.snapshotPolicy(a);
      });
      const fresh = G.makeInput(data.config, G.freezeMarket(live, Date.now()), policies);
      const claim = await db.rpc("greenhouse_claim_run", { _owner: userId, _request: data.requestId, _engine: G.ENGINE_VERSION, _agents: fresh.config.agentIds, _input: fresh as any, _input_hash: G.inputHash(fresh) });
      if (claim.error) throw new Error(claim.error.message);
      const row = claim.data as any;
      if (row.status !== "running") return { ok: true as const, data: { id: row.id as string, status: row.status as string, recovered: true } };
      const stored = row.input as any;
      let input;
      try { input = G.makeInput(stored.config, stored.market, stored.policies); } catch (e) {
        await db.rpc("greenhouse_fail_run", { _id: row.id, _owner: userId, _reason: `Stored inputs invalid: ${(e as Error).message}` });
        throw e;
      }
      if (G.inputHash(input) !== row.input_hash) {
        await db.rpc("greenhouse_fail_run", { _id: row.id, _owner: userId, _reason: "Stored input hash mismatch" });
        throw new Error("Stored trial inputs failed their checksum.");
      }
      let output;
      try { output = G.runTrial(input); } catch (e) {
        await db.rpc("greenhouse_fail_run", { _id: row.id, _owner: userId, _reason: (e as Error).message });
        throw e;
      }
      const oh = G.outputHash(output);
      const fin = await db.rpc("greenhouse_finalize_run", { _id: row.id, _owner: userId, _input_hash: row.input_hash, _output: output as any, _output_hash: oh, _content_hash: G.contentHash(row.input_hash, oh) });
      if (fin.error) throw new Error(fin.error.message);
      return { ok: true as const, data: { id: row.id as string, status: "done", recovered: row.attempts > 1 } };
    } catch (e) { return fail(e); }
  });

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
