import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ConfigSchema } from "@/domain/greenhouse";
import { startTrial } from "./greenhouse-start";

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
      const go = () => startTrial(G, supabaseAdmin as any, context.userId, data, async () => (await import("./garden.server")).peekGarden(null));
      if (!G.isDeep(data.config)) return await go(); // free (legacy-profile) trials stay unmetered
      const A = await import("./access.server");
      try {
        return await A.deepTrial(await A.defaultDeps(), context.userId, data.requestId, G.stableJson(G.normalizeConfig(data.config)), go);
      } catch (e) {
        if (e instanceof A.AccessError) return { ok: false as const, error: e.message, kind: e.kind, blockers: e.blockers };
        throw e;
      }
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
