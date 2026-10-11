// PQ launchpad server functions. Owner actions require the authenticated Cloud session.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { FLEURI_MINT, FLEURI_POOL } from "@/lib/token";
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
  const r = await (pub as any).from("launch_proposals").select("id,created_at,agent_handle,name,symbol,tagline,reason,status,origin_agent_id,origin_policy_hash,origin_mode").eq("status", "pending").order("created_at", { ascending: false }).limit(20);
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

// Public live data for a real launched token (read from chain; never sandbox data).
export const pqTokenPage = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ mint: addr }).parse(d))
  .handler(async ({ data }) => safe(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    const pub = createClient(process.env["SUPABASE_URL"]!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
    });
    const r = await (pub as any).from("launches").select("id,pool,base_mint,lifecycle,cluster,creator_wallet,signature,created_at,damm_v2_pool,passports(manifest_hash,manifest,metadata_uri)").eq("base_mint", data.mint).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    if (!r.data) {
      // The $FLEURI token launched directly on Meteora, outside fleuri's launchpad,
      // so it has no launch record or passport. Its verified pool is still known,
      // so the page shows live chain figures with that stated plainly.
      if (data.mint !== FLEURI_MINT) return { launch: null };
      const { connection, readTokenMetadata } = await import("./solana.server");
      const meta = await readTokenMetadata(connection(), data.mint).catch(() => null);
      return {
        launch: null,
        chain: await readChain(FLEURI_POOL, data.mint),
        tokenMeta: meta ? { name: meta.name, symbol: meta.symbol, uri: meta.uri } : null,
      };
    }
    return { launch: r.data, chain: await readChain(r.data.pool, data.mint) };
  }));

/** Live chain read for a known DBC pool; missing figures stay missing. */
async function readChain(pool: string, mintAddr: string) {
  const { connection, readPool, readTokenMint } = await import("./solana.server");
  const { PublicKey } = await import("@solana/web3.js");
  const conn = connection();
  const [p, mint, largest] = await Promise.all([
    readPool(conn, pool).catch(() => null),
    readTokenMint(conn, mintAddr).catch(() => null),
    conn.getTokenLargestAccounts(new PublicKey(mintAddr)).then((x) => x.value).catch(() => []),
  ]);
  let curvePriceSol: number | null = null;
  if (p?.sqrtPrice && mint) { const sp = Number(BigInt(p.sqrtPrice)) / 2 ** 64; curvePriceSol = sp * sp * 10 ** (mint.decimals - 9); }
  let usdPrice: number | null = null;
  try { const j: any = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${mintAddr}`, { signal: AbortSignal.timeout(6000) })).json(); usdPrice = j?.[mintAddr]?.usdPrice ?? null; } catch { /* price unavailable */ }
  const supply = mint ? Number(mint.supply) / 10 ** mint.decimals : null;
  return {
    readable: !!p,
    pool,
    curvePriceSol, usdPrice, supply, decimals: mint?.decimals ?? null,
    raisedSol: p ? Number(p.quoteReserve) / 1e9 : null,
    thresholdSol: p ? Number(p.migrationQuoteThreshold) / 1e9 : null,
    isMigrated: p?.isMigrated === 1, dammV2Pool: p?.dammV2Confirmed ? p.dammV2Pool : null,
    topHolders: largest.slice(0, 10).map((a: any) => ({ address: a.address.toBase58(), amount: Number(a.uiAmount ?? 0) })),
  };
}


// Living passport: current dated observations beside the immutable signed promises (public).
export const pqLiving = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(d))
  .handler(async ({ data }) => { const s = await import("./living.server"); return safe(() => s.observeLiving(data.hash)); });

// Portable evidence bundle export (public; verification stays free).
export const pqExportBundle = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(d))
  .handler(async ({ data }) => { const s = await import("./living.server"); return safe(() => s.exportBundle(data.hash)); });

// ---------- Pollen (Meteora Dynamic Fee Sharing) ----------
const pollenCall = <T,>(fn: (pl: typeof import("./pollen.server"), save: any) => Promise<T>) => safe(async () => { const [pl, pq] = await Promise.all([import("./pollen.server"), import("./pq.server")]); return fn(pl, pq.savePrep); });
const amountText = z.string().max(24);
export const pollenList = createServerFn({ method: "GET" }).handler(async () => safe(async () => (await import("./pollen.server")).listVaults()));
export const pollenInspect = createServerFn({ method: "POST" }).inputValidator((d: unknown) => z.object({ vault: addr }).strict().parse(d)).handler(async ({ data }) => safe(async () => (await import("./pollen.server")).inspect(data.vault)));
export const pollenForLaunch = createServerFn({ method: "POST" }).inputValidator((d: unknown) => z.object({ launchId: id, signer: addr.nullable() }).strict().parse(d)).handler(async ({ data }) => safe(async () => (await import("./pollen.server")).forLaunch(data.launchId, data.signer)));
export const pollenPrepareCreate = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, base: addr, terms: z.object({ mint: addr, recipients: z.array(z.object({ address: addr, bps: z.number().int() }).strict()).max(5) }).strict() }).strict().parse(d))
  .handler(async ({ data, context }) => pollenCall((pl, save) => pl.prepareCreate(save, context.userId, data)));
export const pollenPrepareFund = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, vault: addr, amount: amountText }).strict().parse(d))
  .handler(async ({ data, context }) => pollenCall((pl, save) => pl.prepareFund(save, context.userId, data)));
export const pollenPrepareClaim = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, vault: addr }).strict().parse(d))
  .handler(async ({ data, context }) => pollenCall((pl, save) => pl.prepareClaim(save, context.userId, data)));
export const pollenPrepareRoute = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, vault: addr, launchId: id }).strict().parse(d))
  .handler(async ({ data, context }) => pollenCall((pl, save) => pl.prepareRoute(save, context.userId, data)));
export const pollenImport = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ vault: addr }).strict().parse(d))
  .handler(async ({ data, context }) => safe(async () => (await import("./pollen.server")).importVault(context.userId, data.vault)));
export const pollenAssociate = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ vault: addr, launchId: id }).strict().parse(d))
  .handler(async ({ data, context }) => safe(async () => (await import("./pollen.server")).associate(context.userId, data.vault, data.launchId)));

export const botanistInfo = createServerFn({ method: "GET" }).handler(() => safe(async () => {
  const { botanistReadiness } = await import("./botanist.server");
  const { connection } = await import("./solana.server");
  const r = await botanistReadiness();
  let blockhash: string | null = null;
  try { blockhash = (await connection().getLatestBlockhash("confirmed")).blockhash; } catch { /* readiness shows RPC */ }
  return { ...r, blockhash };
}));

// ---------- Pollen Staking ----------
export const stakingState = createServerFn({ method: "POST" }).inputValidator((d: unknown) => z.object({ wallet: addr.nullable() }).strict().parse(d))
  .handler(async ({ data }) => safe(async () => (await import("./staking.server")).readState(data.wallet)));
export const stakingPrepare = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ wallet: addr, action: z.enum(["stake", "request_unstake", "cancel_unstake", "withdraw", "claim", "harvest"]), amount: z.string().regex(/^[1-9][0-9]{0,19}$/).optional() }).strict().parse(d))
  .handler(async ({ data, context }) => safe(async () => { const [st, pq] = await Promise.all([import("./staking.server"), import("./pq.server")]); return st.prepare(pq.savePrep, context.userId, data); }));
