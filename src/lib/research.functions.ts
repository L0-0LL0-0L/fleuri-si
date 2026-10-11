// Research Receipt server functions. Owner comes only from the authenticated session.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const uuid = z.string().uuid();
const b64s = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const fail = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message.replace(/^.*?ERROR:\s*/, "").slice(0, 300) : "Something went wrong." });
const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
const LIST = "id,status,manifest_hash,published,anchor_status,created_at,signed_at,run_id,manifest";

function publicClient() {
  return import("@supabase/supabase-js").then(({ createClient }) => {
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    return createClient(process.env["SUPABASE_URL"]!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
    });
  });
}
async function origin() { return (await import("./solana.server")).solEnv().origin; }

export const rrPrepare = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: uuid, runId: uuid, identityId: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const s = await import("./research.server"); return { ok: true as const, data: await s.prepareReceipt(await admin(), context.userId, data, await origin()) }; } catch (e) { return fail(e); } });

export const rrSign = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, publicKey: b64s(4096), signature: b64s(6000) }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const s = await import("./research.server"); return { ok: true as const, data: await s.submitReceiptSignature(await admin(), context.userId, data) }; } catch (e) { return fail(e); } });

/** The caller's own receipts (drafts included). */
export const rrMine = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await (await admin()).from("research_receipts").select(LIST).eq("owner_id", context.userId).order("created_at", { ascending: false }).limit(50);
    return r.error ? fail(new Error(r.error.message)) : { ok: true as const, data: (r.data as any[]).map((x) => ({ id: x.id, status: x.status, manifest_hash: x.manifest_hash, published: x.published, anchor_status: x.anchor_status, created_at: x.created_at, signed_at: x.signed_at, run_id: x.run_id, issuer: x.manifest?.issuer?.keyHash ?? null, agents: x.manifest?.trial?.policies?.map((p: any) => p.handle) ?? [] })) };
  });

/** Owner detail (any status) — scoped by authenticated owner. */
export const rrGet = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const { PUBLIC_COLS, exportBundle } = await import("./research.server");
    const r = await (await admin()).from("research_receipts").select(`${PUBLIC_COLS},run_id`).eq("id", data.id).eq("owner_id", context.userId).maybeSingle();
    if (r.error) return fail(new Error(r.error.message));
    if (!r.data) return { ok: false as const, error: "Not one of your receipts." };
    const row = r.data as any;
    return { ok: true as const, data: { ...row, mine: true, bundle: row.status === "signed" ? exportBundle(row) : null } };
  });

/** Public read: only published signed receipts, via RLS on the publishable key. */
export const rrPublic = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data }) => {
    const { PUBLIC_COLS, exportBundle } = await import("./research.server");
    const db = await publicClient();
    const r = await (db as any).from("research_receipts").select(PUBLIC_COLS).eq("id", data.id).maybeSingle();
    if (r.error) return fail(new Error(r.error.message));
    if (!r.data || r.data.status !== "signed" || !r.data.published) return { ok: false as const, error: "This receipt is not published." };
    const row = r.data as any;
    return { ok: true as const, data: { ...row, mine: false, bundle: exportBundle(row) } };
  });

export const rrPublish = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, published: z.boolean() }).strict().parse(d))
  .handler(async ({ data, context }) => { const r = await (await admin()).rpc("research_set_published", { _owner: context.userId, _id: data.id, _published: data.published }); return r.error ? fail(new Error(r.error.message)) : { ok: true as const, data: r.data as { published: boolean } }; });

export const rrPrepareAnchor = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const s = await import("./pq.server"); return { ok: true as const, data: await s.prepareReceiptAnchor(context.userId, data.id) }; } catch (e) { return fail(e); } });

/** Fully verified, caller-owned receipt evidence for these runs (proposal review). */
export const rrForRuns = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ runIds: z.array(uuid).max(50) }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const s = await import("./research.server"); return { ok: true as const, data: await s.verifiedEvidenceForRuns(await admin(), context.userId, data.runIds) }; } catch (e) { return fail(e); } });

/** Owner-only exact draft recovery by id (another device / lost local storage). */
export const rrResume = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const s = await import("./research.server"); return { ok: true as const, data: await s.resumeDraft(await admin(), context.userId, data.id) }; } catch (e) { return fail(e); } });
