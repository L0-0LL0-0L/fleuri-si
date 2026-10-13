import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const uuid = z.string().uuid();
const fail = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message.replace(/^.*?ERROR:\s*/, "").slice(0, 240) : "Something went wrong." });
const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;

/** Public: list rounds (ensures one open round exists; its seed is generated in the database). */
export const bloomRounds = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const S = await import("./bloom.server"); const db = await admin();
    await S.ensureRound(db, async () => (await import("./garden.server")).peekGarden(null)).catch(() => {});
    return { ok: true as const, rounds: await S.listRounds(db), serverNow: new Date().toISOString() };
  } catch (e) { return fail(e); }
});

/** Public: one round. Past the deadline it lets the database decide whether to reveal and evaluate (bounded, fenced). */
export const bloomRound = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data }) => {
    try {
      const S = await import("./bloom.server"); const db = await admin();
      const first = await S.getRound(db, data.id);
      if (!first) return { ok: false as const, error: "Round not found." };
      if (first.round.status === "open" || first.round.status === "evaluating") {
        if (Date.parse(first.round.commit_closes_at) <= Date.now()) await S.advance(db, data.id);
      }
      const g = (await S.getRound(db, data.id))!;
      return { ok: true as const, ...g, serverNow: new Date().toISOString() };
    } catch (e) { return fail(e); }
  });

export const bloomBundle = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ data }) => {
    try { const S = await import("./bloom.server"); const b = await S.bundle(await admin(), data.id); return b ? { ok: true as const, bundle: JSON.stringify(b) } : { ok: false as const, error: "Round not found." }; }
    catch (e) { return fail(e); }
  });

export const bloomSubmit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ roundId: uuid, requestId: uuid, manifest: z.unknown() }).strict().parse(d))
  .handler(async ({ data, context }) => {
    try { const S = await import("./bloom.server"); return { ok: true as const, ...(await S.submit(await admin(), context.userId, { ...data, manifest: data.manifest })) }; }
    catch (e) { return fail(e); }
  });

export const bloomMine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try { const S = await import("./bloom.server"); return { ok: true as const, entries: await S.mine(await admin(), context.userId) }; }
    catch (e) { return fail(e); }
  });

export const bloomAttach = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ proposalId: uuid, entryId: uuid }).strict().parse(d))
  .handler(async ({ data, context }) => {
    try { const S = await import("./bloom.server"); await S.attach(await admin(), context.userId, data.proposalId, data.entryId); return { ok: true as const }; }
    catch (e) { return fail(e); }
  });

/** Public read: launch proposals drafted by one agent (for evidence linking). */
export const bloomProposals = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ agentId: z.string().min(1).max(40) }).strict().parse(d))
  .handler(async ({ data }) => {
    try {
      const r = await (await admin()).from("launch_proposals").select("id,name,symbol,status,origin_policy_hash,created_at").eq("origin_agent_id", data.agentId).order("created_at", { ascending: false }).limit(20);
      return r.error ? fail(new Error("Proposals could not be read.")) : { ok: true as const, proposals: r.data };
    } catch (e) { return fail(e); }
  });
