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
      return { ok: true as const, data: await redeemReport(deps, context.userId, data, async (mint) => { const B = await import("./botanist.server"); const R = await import("./botanist-report"); return R.buildReport(B.reportDeps(), mint); }) };
    } catch (e) { return safe(e); }
  });

/** Testable redeem flow (same code the endpoint runs). */
export async function redeemReport(deps: import("./access.server").AccessDeps, owner: string, data: { requestId: string; mint: string }, build: (mint: string) => Promise<unknown>) {
  const A = await import("./access.server");
  const { canonicalize, sha256Hex, utf8 } = await import("@/pq/canonical");
  const key = `report:${data.requestId}`;
  const existing = async () => {
    const r = await deps.db.from("access_reservations").select("id").eq("owner_id", owner).eq("action", "research_report").eq("request_key", key).maybeSingle();
    const x = r.data ? await deps.db.from("access_reports").select("id,mint,created_at").eq("reservation_id", r.data.id).maybeSingle() : { data: null };
    if (!x.data) throw new A.AccessError("busy", "That report is still being prepared.");
    if (x.data.mint !== data.mint) throw new A.AccessError("other", "This request id was already used for a different mint.");
    return { id: x.data.id as string, replay: true };
  };
  const r = await A.reserve(deps, owner, "research_report", key);
  if (r.replay) { if (r.status === "consumed") return existing(); throw new A.AccessError("busy", "That report is already being prepared."); }
  try {
    const report = JSON.parse(JSON.stringify(await build(data.mint)));
    const digest = sha256Hex(utf8(canonicalize(report)));
    const s = await deps.db.rpc("access_save_report", { _owner: owner, _reservation: r.id, _mint: data.mint, _report: report, _digest: digest });
    if (s.error) throw new Error("The report could not be saved.");
    return { id: s.data.id as string, replay: false };
  } catch (e) {
    await A.finish(deps, owner, r.id, false).catch(() => {});
    throw new A.AccessError("other", "The report could not be created; your credit was refunded.");
  }
}

/** The owner's saved reports (RLS: owner-only). */
export const accessReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await (context.supabase as any).from("access_reports").select("id,mint,digest,report,created_at").order("created_at", { ascending: false }).limit(20);
    if (r.error) return { ok: false as const, error: "Reports could not be read." };
    return { ok: true as const, data: r.data as { id: string; mint: string; digest: string; report: any; created_at: string }[] };
  });
