import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const uuid = z.string().uuid();
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const fail = async (e: unknown) => {
  const { clean } = await import("./graft.server");
  return { ok: false as const, error: e instanceof Error ? clean(e.message) : "Something went wrong." };
};
const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
const S = () => import("./graft.server");

const terms = z.object({
  agentId: z.string().min(1).max(40), poolKind: z.enum(["dbc", "damm_v2"]), pool: b58,
  tools: z.array(z.enum(["watchtower.dbc_pool", "damm_v2.pool_account"])).min(1).max(2),
  hours: z.number().int().min(1).max(720), runsPerDay: z.number().int().min(1).max(3),
  evidenceTtlSecs: z.number().int().min(60).max(3600), maxObservationAgeSecs: z.number().int().min(10).max(3600),
  purchaseService: z.enum(["botanist.report"]).nullable(), purchaseMaxAtomic: z.string().regex(/^(0|[1-9]\d{0,9})$/), note: z.string().max(280),
}).strict();

export const graftMine = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  try { return { ok: true as const, mandates: await (await S()).listMine(await admin(), context.userId) }; } catch (e) { return fail(e); }
});

export const graftCreate = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: uuid, terms }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).createDraft(await admin(), context.userId, data)) }; } catch (e) { return fail(e); } });

/** Owner detail (signed in) — private by default. */
export const graftDetail = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const r = await (await S()).detail(await admin(), data.id, context.userId); return r ? { ok: true as const, ...r } : { ok: false as const, error: "Mandate not found." }; } catch (e) { return fail(e); } });

/** Public read only for mandates the owner explicitly shared. */
export const graftShared = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data }) => { try { const r = await (await S()).detail(await admin(), data.id, null); return r ? { ok: true as const, ...r } : { ok: false as const, error: "This mandate is private or does not exist." }; } catch (e) { return fail(e); } });

export const graftBundle = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => { try { const s = await S(); const r = await s.detail(await admin(), data.id, context.userId); return r ? { ok: true as const, bundle: JSON.stringify(s.toBundle(r), null, 1) } : { ok: false as const, error: "Mandate not found." }; } catch (e) { return fail(e); } });

export const graftTransition = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, to: z.enum(["review", "revoked", "completed"]) }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).transition(await admin(), context.userId, data.id, data.to)) }; } catch (e) { return fail(e); } });

export const graftApprove = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, draftHash: hex }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).approve(await admin(), context.userId, data.id, data.draftHash)) }; } catch (e) { return fail(e); } });

export const graftShare = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, shared: z.boolean() }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).setShared(await admin(), context.userId, data.id, data.shared)) }; } catch (e) { return fail(e); } });

export const graftRun = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ mandateId: uuid, requestId: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).run(await admin(), context.userId, data)) }; } catch (e) { return fail(e); } });

export const graftPropose = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ mandateId: uuid, requestId: uuid, service: z.enum(["botanist.report"]), mint: b58, maxAtomic: z.string().regex(/^[1-9]\d{0,9}$/), minutes: z.number().int().min(5).max(1440), purpose: z.string().min(1).max(200) }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).propose(await admin(), context.userId, data)) }; } catch (e) { return fail(e); } });

export const graftDecide = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, hash: hex, approve: z.boolean() }).strict().parse(d))
  .handler(async ({ data, context }) => { try { return { ok: true as const, ...(await (await S()).decide(await admin(), context.userId, data.id, data.hash, data.approve)) }; } catch (e) { return fail(e); } });
