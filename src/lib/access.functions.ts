// Pollen Access server functions. All authenticated; writes only through service-role SQL functions.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { addr } from "./observatory.functions";

const safe = (e: unknown) => {
  const m = e instanceof Error ? e.message : "";
  return { ok: false as const, error: (e as any)?.kind ? m : "Pollen Access could not be checked right now.", kind: ((e as any)?.kind ?? "other") as string, blockers: ((e as any)?.blockers ?? []) as string[] };
};

/** Policy, today's usage and server-verified eligibility for the signed-in owner. */
export const accessStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ fresh: z.boolean().optional() }).strict().parse(d ?? {}))
  .handler(async ({ data, context }) => {
    try {
      const A = await import("./access.server"); const P = await import("@/pq/access");
      const deps = await A.defaultDeps(); const now = Date.now(); const day = P.utcDay(now);
      const [el, used] = await Promise.all([A.eligibility(deps, context.userId, !!data.fresh), A.usage(deps.db, context.userId, day)]);
      return { ok: true as const, data: { policyVersion: P.ACCESS_POLICY_VERSION, policy: P.ACCESS_POLICY, day, resetsAt: new Date(P.nextResetUtc(now)).toISOString(), used, eligibility: el } };
    } catch (e) { return safe(e); }
  });

/** Redeem one research credit for a saved, owner-private Botanist report. Idempotent per requestId. */
export const accessRedeemReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: z.string().uuid(), mint: addr }).strict().parse(d))
  .handler(async ({ data, context }) => {
    try {
      const A = await import("./access.server");
      const deps = await A.defaultDeps();
      return { ok: true as const, data: await A.redeemReport(deps, context.userId, data, async (mint) => { const B = await import("./botanist.server"); const R = await import("./botanist-report"); return R.buildReport(B.reportDeps(), mint); }) };
    } catch (e) { return safe(e); }
  });

/** The owner's saved reports (RLS: owner-only). */
export const accessReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await (context.supabase as any).from("access_reports").select("id,mint,digest,report,created_at").order("created_at", { ascending: false }).limit(20);
    if (r.error) return { ok: false as const, error: "Reports could not be read." };
    return { ok: true as const, data: r.data as { id: string; mint: string; digest: string; report: any; created_at: string }[] };
  });
