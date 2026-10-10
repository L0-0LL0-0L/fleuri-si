// PQ launchpad server functions. Owner actions require the authenticated Cloud session.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const id = z.string().uuid();
const b64s = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safe = async (fn: () => Promise<any>): Promise<{ ok: true; data: any } | { ok: false; error: string }> => {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    console.error("[pq]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
};

export const getPqReadiness = createServerFn({ method: "GET" }).handler(async () => {
  const { readiness } = await import("./solana.server");
  return safe(() => readiness());
});

export const pqChallenge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, publicKey: b64s(4096) }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.issueChallenge(context.userId, data.wallet, data.publicKey));
  });

export const pqRegister = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ challengeId: id, publicKey: b64s(4096), walletSignature: b64s(200), pqSignature: b64s(6000) }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.registerIdentity(context.userId, data));
  });

export const pqPrepareAnchor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ identityId: id }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.prepareAnchor(context.userId, data.identityId));
  });

export const pqSubmit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ preparationId: id, transaction: b64s(4000) }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.submitPrepared(context.userId, data.preparationId, data.transaction));
  });

export const pqConfirm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ preparationId: id }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.confirmPrepared(context.userId, data.preparationId));
  });

export const pqRetry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ preparationId: id }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.retryPrepared(context.userId, data.preparationId));
  });

export const pqMine = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [identities, launches, preparations] = await Promise.all([
      context.supabase.from("pq_identities").select("id,wallet,cluster,key_hash,registration_hash,status,anchor_signature,anchor_slot,created_at").eq("owner_id", context.userId).order("created_at", { ascending: false }),
      context.supabase.from("launches").select("id,passport_id,pool,base_mint,lifecycle,signature,cluster,created_at,passports(manifest_hash,manifest)").eq("owner_id", context.userId).order("created_at", { ascending: false }),
      (context.supabase as any).from("chain_preparations").select("id,kind,cluster,subject,signature,submitted_at,expires_at,confirmed_at").eq("owner_id", context.userId).not("submitted_at", "is", null).is("confirmed_at", null).order("created_at", { ascending: false }).limit(20),
    ]);
    if (identities.error) return { ok: false as const, error: identities.error.message };
    if (launches.error || preparations.error) return {ok: false as const, error: (launches.error || preparations.error)!.message};
    return { ok: true as const, data: { identities: identities.data ?? [], launches: (launches.data ?? []) as any[], preparations: preparations.data ?? [] } };
  });

export const pqStartLaunch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ identityId: id, baseMint: addr }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.startLaunch(context.userId, data.identityId, data.baseMint));
  });

export const pqPinImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ data: b64s(1_400_000), mime: z.string().max(40) }).strict().parse(d))
  .handler(async ({ data }) => {
    const s = await import("./pq.server");
    return safe(() => s.pinImage(data.data, data.mime));
  });

export const pqPrepareLaunch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ passport: z.unknown() }).strict().refine(v => JSON.stringify(v).length <= 40_000, "Passport too large").parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.prepareLaunch(context.userId, data.passport));
  });

export const pqPrepareMigration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ launchId: id }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.prepareMigration(context.userId, data.launchId));
  });

export const pqPrepareConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, config: addr, draft: z.unknown() }).strict().refine(v => JSON.stringify(v).length <= 4000, "Draft too large").parse(d))
  .handler(async ({ data, context }) => {
    const s = await import("./pq.server");
    return safe(() => s.prepareConfig(context.userId, { wallet: data.wallet, config: data.config, draft: data.draft }));
  });

export const pqRefreshLifecycle = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ launchId: id }).strict().parse(d))
  .handler(async ({ data }) => {
    const s = await import("./pq.server");
    return safe(() => s.refreshLifecycle(data.launchId));
  });

export const pqVerify = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ passport: z.unknown().optional(), hash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict().refine(v => (v.passport !== undefined) !== (v.hash !== undefined), "Provide a passport or hash").parse(d))
  .handler(async ({ data }) => {
    if (data.passport && JSON.stringify(data.passport).length > 40_000) return { ok: false as const, error: "Passport too large." };
    const s = await import("./pq.server");
    return safe(() => s.verifyPublic(data));
  });

export const pqPublicLaunches = createServerFn({ method: "GET" }).handler(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  const pub = createClient(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
  });
  const r = await (pub as any).from("launches").select("id,pool,base_mint,lifecycle,cluster,created_at,passports(manifest_hash,manifest)").order("created_at", { ascending: false }).limit(30);
  return r.error ? { ok: false as const, error: r.error.message } : { ok: true as const, data: r.data as any[] };
});

// Agent-drafted launch proposals: public read, owner reviews and signs by hand.
export const pqLaunchProposals = createServerFn({ method: "GET" }).handler(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  const pub = createClient(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
  });
  const r = await (pub as any).from("launch_proposals").select("id,created_at,agent_handle,name,symbol,tagline,reason,status").eq("status", "pending").order("created_at", { ascending: false }).limit(20);
  return r.error ? { ok: false as const, error: r.error.message } : { ok: true as const, data: r.data as any[] };
});

export const pqSetProposalStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id, status: z.enum(["dismissed", "launched"]) }).strict().parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const r = await (supabaseAdmin as any).from("launch_proposals").update({ status: data.status }).eq("id", data.id).eq("status", "pending");
    return r.error ? { ok: false as const, error: r.error.message } : { ok: true as const, data: true };
  });
