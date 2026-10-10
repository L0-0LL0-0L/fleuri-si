// Botanist field report: one paid, point-in-time inspection, sold via x402 V2 "exact" on Solana
// mainnet. Fleuri never holds payer keys; a documented facilitator (PayAI by default) co-signs as
// fee payer and broadcasts. We verify locally before AND confirm the on-chain credit after
// settlement, and only then deliver.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { r402, requirementOf, resourceOf, resolveHeaderJob, settleAndDeliver, type FlowDeps, type Out } from "./botanist-flow";
import { buildReport, type ReportDeps } from "./botanist-report";
import { hex, sha256Hex, utf8 } from "@/pq/canonical";
import { BOTANIST_ASSET, DEFAULT_PRICE, QUOTE_TTL_S, USDC_DECIMALS, X402_NETWORK, jobMemo, requestHash, settledCredit } from "@/pq/botanist";
import { isSolanaAddress } from "@/pq/registration";
import { DBC_PROGRAM_ID, type Check } from "@/pq/passport";
import { readAnyMint, readUpgradeAuthority, readTokenMetadata, readDbcConfig, readPool } from "@/pq/chain-read";
import * as sol from "./solana.server";

const db = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
const RATE_PER_HOUR = 20;

export function botanistEnv() {
  const payTo = process.env["BOTANIST_PAY_TO"] || null;
  const price = BigInt(process.env["BOTANIST_PRICE_BASE_UNITS"] || DEFAULT_PRICE.toString());
  const facilitator = (process.env["X402_FACILITATOR_URL"] || "https://facilitator.payai.network").replace(/\/$/, "");
  return { payTo, price, facilitator };
}

async function facilitatorFeePayer(url: string) {
  const r = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Facilitator /supported returned ${r.status}.`);
  const j: any = await r.json();
  const k = (j.kinds ?? []).find((k: any) => k.x402Version === 2 && k.scheme === "exact" && k.network === X402_NETWORK);
  const fp = k?.extra?.feePayer;
  if (!fp || !isSolanaAddress(fp)) throw new Error("Facilitator does not advertise x402 v2 exact on Solana mainnet with a fee payer.");
  return fp as string;
}

export async function botanistReadiness(): Promise<{ ready: boolean; checks: Check[]; price: string; payTo: string | null; facilitator: string; feePayer: string | null }> {
  const e = botanistEnv(); const env = sol.solEnv(); const checks: Check[] = [];
  const push = (id: string, label: string, ok: boolean | null, detail: string) => checks.push({ id, label, status: ok === null ? "unavailable" : ok ? "pass" : "fail", detail });
  push("cluster", "Solana mainnet", env.cluster === "mainnet-beta", env.cluster ?? "not set");
  push("price", "Fixed price", e.price > 0n && e.price <= 100_000_000n, `${Number(e.price) / 10 ** USDC_DECIMALS} USDC (${e.price} base units)`);
  let feePayer: string | null = null;
  try { feePayer = await facilitatorFeePayer(e.facilitator); push("facilitator", "x402 facilitator", true, `${new URL(e.facilitator).host} · fee payer ${feePayer.slice(0, 6)}…`); }
  catch (x) { push("facilitator", "x402 facilitator", false, (x as Error).message); }
  try {
    const conn = sol.connection(); await sol.assertGenesis(conn, "mainnet-beta");
    const m = await readAnyMint(conn, BOTANIST_ASSET);
    push("usdc", "Circle USDC mint", m.program === "spl-token" && m.decimals === USDC_DECIMALS, `${m.program} · ${m.decimals} decimals`);
    if (!e.payTo || !isSolanaAddress(e.payTo)) push("payto", "Service payout address", false, "BOTANIST_PAY_TO is not set — the owner must supply a public wallet address.");
    else {
      const ata = getAssociatedTokenAddressSync(new PublicKey(BOTANIST_ASSET), new PublicKey(e.payTo), true);
      const info = await conn.getParsedAccountInfo(ata);
      const p: any = (info.value?.data as any)?.parsed?.info;
      push("payto", "Payout USDC account", !!p && p.mint === BOTANIST_ASSET && p.owner === e.payTo, p ? `${ata.toBase58()} exists` : `USDC account ${ata.toBase58()} does not exist yet — open it once from the payout wallet (any wallet app can, by receiving USDC). Fleuri does not assume the facilitator pays its rent.`);
    }
  } catch (x) { push("rpc", "Mainnet RPC", false, (x as Error).message); }
  return { ready: checks.every((c) => c.status === "pass"), checks, price: e.price.toString(), payTo: e.payTo, facilitator: e.facilitator, feePayer };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
const out = (o: Out) => json(o.status, o.body, o.headers);

async function findJob(id: string, token: string) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await (await db()).from("botanist_jobs").select("*").eq("id", id).eq("capability_hash", sha256Hex(utf8(token))).maybeSingle();
  return data;
}

function flowDeps(admin: any): FlowDeps {
  const conn = sol.connection();
  const getTx = async (sig: string) => {
    const t: any = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return t ? { slot: t.slot, meta: t.meta, transaction: { message: t.transaction.message } } : null;
  };
  return {
    rpc: async (fn, args) => { const { data, error } = await admin.rpc(fn, args); if (error) throw new Error(error.message); return data; },
    noteError: async (id, e) => { await admin.from("botanist_jobs").update({ error: e.slice(0, 300) }).eq("id", id); },
    facilitator: (url, key) => new HTTPFacilitatorClient({ url, createAuthHeaders: async () => ({ settle: { "Idempotency-Key": key } }) }) as any,
    defaultFacilitator: botanistEnv().facilitator,
    getTx,
    findByMessage: async (j) => {
      const ata = getAssociatedTokenAddressSync(new PublicKey(j.asset), new PublicKey(j.pay_to), true);
      const since = Math.floor(new Date(j.created_at).getTime() / 1000) - 60;
      const sigs = (await conn.getSignaturesForAddress(ata, { limit: 25 }, "confirmed")).filter((x) => !x.err && (x.blockTime ?? since) >= since);
      for (const x of sigs) { const t = await getTx(x.signature); if (t && settledCredit(t, requirementOf(j), j.payment_hash).ok) return x.signature; }
      return null;
    },
    buildReport: (mint) => buildReport(reportDeps(), mint),
  };
}

export function reportDeps(): ReportDeps {
  const conn = sol.connection();
  return {
    getSlot: () => conn.getSlot("confirmed"), cluster: sol.solEnv().cluster ?? "unknown", dbcProgram: DBC_PROGRAM_ID,
    readAnyMint: (m) => readAnyMint(conn, m), readTokenMetadata: (m) => readTokenMetadata(conn, m), readUpgradeAuthority: (p) => readUpgradeAuthority(conn, p),
    largestAccounts: async (m) => (await conn.getTokenLargestAccounts(new PublicKey(m))).value.map((a) => ({ address: a.address.toBase58(), amount: a.amount })),
    findLaunch: async (m) => { const { data, error } = await (await db()).from("launches").select("pool,config,creator_wallet,lifecycle,damm_v2_pool,signature,passports(manifest_hash,manifest)").eq("base_mint", m).maybeSingle(); if (error) throw new Error(error.message); return data; },
    readPool: (p) => readPool(conn, p), readDbcConfig: (c) => readDbcConfig(conn, c),
  };
}

/** POST /api/public/botanist/report — x402 V2 resource. */
export async function handleBotanist(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > 2000) return json(413, { error: "Request too large." });
  let body: any; try { body = JSON.parse(text || "{}"); } catch { return json(400, { error: "Invalid JSON." }); }
  const sig = request.headers.get("PAYMENT-SIGNATURE");
  if (sig && sig.length > 6000) return json(413, { error: "Payment header too large." });
  const admin = await db();

  // Generic x402 retry of the original POST {mint}: recover the exact quoted job from its payment.
  if (sig && !body.jobId) {
    const r = await resolveHeaderJob(sig, body, `${sol.solEnv().origin}/api/public/botanist/report`, (id, token) => findJob(id, token));
    if (!("job" in r)) return out(r);
    return out(await settleAndDeliver(flowDeps(admin), r.job, sig, r.token));
  }

  // Resume an existing job (capability token required; never a list or public lookup).
  if (body.jobId) {
    const j = await findJob(String(body.jobId), String(body.token ?? ""));
    if (!j) return json(404, { error: "Unknown job or wrong retrieval token." });
    if (!sig && !j.payment_hash && !j.report) {
      if (new Date(j.quote_expires_at).getTime() < Date.now()) return json(410, { error: "Quote expired. Start a new report; nothing was charged.", expired: true });
      return out(r402(j, undefined, {}, String(body.token)));
    }
    return out(await settleAndDeliver(flowDeps(admin), j, sig, String(body.token)));
  }

  // New quote.
  const mint = String(body.mint ?? "").trim();
  if (!isSolanaAddress(mint)) return json(400, { error: "Enter a valid Solana mint address." });
  const ready = await botanistReadiness();
  if (!ready.ready || !ready.payTo || !ready.feePayer) return json(503, { error: "Botanist checkout is not ready.", checks: ready.checks });
  // Validate before quoting so nobody pays for a non-mint or uninitialized account.
  try { await readAnyMint(sol.connection(), mint); } catch (e) { return json(422, { error: `Not an inspectable SPL mint: ${(e as Error).message}` }); }
  const clientHash = sha256Hex(utf8(`${request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "?"}:botanist`));
  const { count } = await admin.from("botanist_jobs").select("id", { count: "exact", head: true }).eq("client_hash", clientHash).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((count ?? 0) >= RATE_PER_HOUR) return json(429, { error: "Too many quotes this hour." });
  const id = crypto.randomUUID(); const tokenBytes = crypto.getRandomValues(new Uint8Array(32)); const token = hex(tokenBytes);
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const memo = jobMemo(id, nonce); const resource = `${sol.solEnv().origin}/api/public/botanist/report`;
  const row = { id, request_hash: requestHash(id, mint, ready.price, ready.payTo, memo, resource), capability_hash: sha256Hex(utf8(token)), client_hash: clientHash, mint, network: X402_NETWORK, asset: BOTANIST_ASSET, amount: ready.price, pay_to: ready.payTo, memo, fee_payer: ready.feePayer, facilitator: ready.facilitator, resource, quote_expires_at: new Date(Date.now() + QUOTE_TTL_S * 1000).toISOString() } as any;
  row.accepted = requirementOf(row); row.resource_info = resourceOf(row);
  const { data: j, error } = await admin.from("botanist_jobs").insert(row).select("*").single();
  if (error) return json(500, { error: "Could not create quote." });
  const o = r402(j, undefined, {}, token); return json(402, { ...o.body, token }, o.headers);
}

