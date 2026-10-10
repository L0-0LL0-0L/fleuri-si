// Botanist field report: one paid, point-in-time inspection, sold via x402 V2 "exact" on Solana
// mainnet. Fleuri never holds payer keys; a documented facilitator (PayAI by default) co-signs as
// fee payer and broadcasts. We verify locally before AND confirm the on-chain credit after
// settlement, and only then deliver.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { HTTPFacilitatorClient, encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { canonicalize, hex, sha256Hex, utf8 } from "@/pq/canonical";
import { BOTANIST_ASSET, DEFAULT_PRICE, QUOTE_TTL_S, USDC_DECIMALS, X402_NETWORK, jobMemo, receipt, requestHash, sameRequirement, settledCredit, verifyExactTransaction, type Requirement } from "@/pq/botanist";
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

const requirementOf = (j: any): Requirement => ({ scheme: "exact", network: j.network, asset: j.asset, amount: String(j.amount), payTo: j.pay_to, maxTimeoutSeconds: QUOTE_TTL_S, extra: { feePayer: j.fee_payer, memo: j.memo } });
const paymentRequired = (j: any, error?: string) => ({ x402Version: 2, ...(error ? { error } : {}), resource: { url: j.resource, description: `Botanist field report for mint ${j.mint}`, mimeType: "application/json" }, accepts: [requirementOf(j)] });

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

async function findJob(id: string, token: string) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await (await db()).from("botanist_jobs").select("*").eq("id", id).eq("capability_hash", sha256Hex(utf8(token))).maybeSingle();
  return data;
}

/** POST /api/public/botanist/report — x402 V2 resource. */
export async function handleBotanist(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > 2000) return json(413, { error: "Request too large." });
  let body: any; try { body = JSON.parse(text || "{}"); } catch { return json(400, { error: "Invalid JSON." }); }
  const sig = request.headers.get("PAYMENT-SIGNATURE");
  if (sig && sig.length > 6000) return json(413, { error: "Payment header too large." });
  const admin = await db();

  // Resume an existing job (capability token required; never a list or public lookup).
  if (body.jobId) {
    const j = await findJob(String(body.jobId), String(body.token ?? ""));
    if (!j) return json(404, { error: "Unknown job or wrong retrieval token." });
    if (j.report) return delivered(j);
    if (!sig && !j.payment_hash) {
      if (new Date(j.quote_expires_at).getTime() < Date.now()) return json(410, { error: "Quote expired. Start a new report; nothing was charged." });
      return json(402, paymentRequired(j), { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(j) as any) });
    }
    return settleAndDeliver(admin, j, sig);
  }

  // New quote.
  const mint = String(body.mint ?? "").trim();
  if (!isSolanaAddress(mint)) return json(400, { error: "Enter a valid Solana mint address." });
  const ready = await botanistReadiness();
  if (!ready.ready || !ready.payTo || !ready.feePayer) return json(503, { error: "Botanist checkout is not ready.", checks: ready.checks });
  const clientHash = sha256Hex(utf8(`${request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "?"}:botanist`));
  const { count } = await admin.from("botanist_jobs").select("id", { count: "exact", head: true }).eq("client_hash", clientHash).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((count ?? 0) >= RATE_PER_HOUR) return json(429, { error: "Too many quotes this hour." });
  const id = crypto.randomUUID(); const tokenBytes = crypto.getRandomValues(new Uint8Array(32)); const token = hex(tokenBytes);
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const memo = jobMemo(id, nonce); const resource = `${sol.solEnv().origin}/api/public/botanist/report`;
  const row = { id, request_hash: requestHash(id, mint, ready.price, ready.payTo, memo, resource), capability_hash: sha256Hex(utf8(token)), client_hash: clientHash, mint, network: X402_NETWORK, asset: BOTANIST_ASSET, amount: ready.price, pay_to: ready.payTo, memo, fee_payer: ready.feePayer, resource, quote_expires_at: new Date(Date.now() + QUOTE_TTL_S * 1000).toISOString() };
  const { data: j, error } = await admin.from("botanist_jobs").insert(row).select("*").single();
  if (error) return json(500, { error: "Could not create quote." });
  const pr = paymentRequired(j);
  return json(402, { ...pr, jobId: id, token }, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as any) });
}

async function settleAndDeliver(admin: any, j: any, sig: string | null): Promise<Response> {
  const req = requirementOf(j);
  let payload: any = null;
  if (sig) {
    try { payload = decodePaymentSignatureHeader(sig); } catch { return json(400, { error: "PAYMENT-SIGNATURE could not be decoded." }); }
    if (payload.x402Version !== 2 || !sameRequirement(req, payload.accepted)) return json(402, paymentRequired(j, "Payment does not match the frozen quote."), { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(j, "mismatch") as any) });
    const txB64 = String(payload.payload?.transaction ?? "");
    let local; try { local = verifyExactTransaction(txB64, req); } catch (e) { return json(402, paymentRequired(j, (e as Error).message)); }
    // Atomic: one payment per job, one job per payment; signed bytes persisted before broadcast.
    const { data: claimed, error } = await admin.rpc("botanist_claim_payment", { _id: j.id, _cap: j.capability_hash, _payment_hash: local.paymentHash, _tx: txB64, _payer: local.payer });
    if (error) return json(409, { error: /duplicate|unique/i.test(error.message) ? "This payment is already bound to another job." : error.message });
    j = claimed;
  }
  if (!j.payment_tx_b64) return json(402, paymentRequired(j));
  // Rebuild from the DURABLE bytes, never from a newer header.
  payload = { x402Version: 2, resource: paymentRequired(j).resource, accepted: req, payload: { transaction: j.payment_tx_b64 } };
  const conn = sol.connection();
  if (!j.settle_signature) {
    const f = new HTTPFacilitatorClient({ url: botanistEnv().facilitator });
    try {
      const v = await f.verify(payload, req as any);
      if (!v.isValid) { await admin.from("botanist_jobs").update({ error: `Facilitator rejected: ${v.invalidReason ?? "invalid"}` }).eq("id", j.id); return json(402, { error: `Payment rejected by facilitator: ${v.invalidMessage ?? v.invalidReason}`, jobId: j.id }); }
      const s = await f.settle(payload, req as any);
      if (!s.success || !s.transaction) { await admin.from("botanist_jobs").update({ error: `Settlement failed: ${s.errorReason ?? "unknown"}` }).eq("id", j.id); return json(502, { error: `Settlement failed: ${s.errorMessage ?? s.errorReason}. Retry resumes this same payment; you will not be charged twice.`, jobId: j.id }); }
      const ok = await confirmCredit(conn, s.transaction, req);
      if (!ok.ok) return json(202, { status: "pending", detail: ok.reason, jobId: j.id });
      const { data, error } = await admin.rpc("botanist_mark_settled", { _id: j.id, _sig: s.transaction, _slot: ok.slot });
      if (error) return json(409, { error: error.message }); j = data;
    } catch (e) {
      await admin.from("botanist_jobs").update({ error: (e as Error).message.slice(0, 300) }).eq("id", j.id);
      return json(502, { error: "Facilitator unreachable. Retry with the same job — the same signed payment is reused.", jobId: j.id });
    }
  }
  try {
    const report = await buildReport(conn, j.mint, { slotHint: j.settled_slot });
    const { data, error } = await admin.rpc("botanist_store_report", { _id: j.id, _report: report, _digest: sha256Hex(utf8(canonicalize(report))) });
    if (error) throw new Error(error.message);
    return delivered(data);
  } catch (e) {
    await admin.from("botanist_jobs").update({ error: `Report generation: ${(e as Error).message.slice(0, 200)}` }).eq("id", j.id);
    return json(503, { error: "Payment is settled; the report could not be generated yet. Retry with the same job to resume — no new charge.", jobId: j.id, settled: true });
  }
}

async function confirmCredit(conn: any, signature: string, req: Requirement) {
  for (let i = 0; i < 12; i++) {
    const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) { const c = settledCredit(t.meta, req); return c.ok ? { ok: true as const, slot: t.slot } : { ok: false as const, reason: c.reason }; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false as const, reason: "Settlement not yet confirmed. Retry with the same job." };
}

function delivered(j: any) {
  const rc = receipt({ ...j, amount: String(j.amount) }, j.report);
  return json(200, { status: "report_ready", jobId: j.id, report: j.report, receipt: rc }, j.settle_signature ? { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: j.settle_signature, network: j.network, payer: j.payer } as any) } : {});
}

/** Point-in-time facts only. Unavailable is labelled, never inferred. */
export async function buildReport(conn: any, mint: string, _o: { slotHint?: number } = {}) {
  const slot = await conn.getSlot("confirmed"); const at = new Date().toISOString();
  const facts: Record<string, any> = {}; const unavailable: Record<string, string> = {};
  const m = await readAnyMint(conn, mint);
  facts.mint = { address: mint, program: m.program, decimals: m.decimals, supply: m.supply.toString(), mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority, mintAuthorityRevoked: !m.mintAuthority, freezeAuthorityRevoked: !m.freezeAuthority, token2022ExtensionBytes: m.extensionsBytes };
  try { const md: any = await readTokenMetadata(conn, mint); facts.metadata = md ? { name: md.name, symbol: md.symbol, uri: md.uri, updateAuthority: md.updateAuthority, isMutable: md.isMutable } : null; if (!md) unavailable.metadata = "No Metaplex metadata account."; }
  catch (e) { unavailable.metadata = (e as Error).message; }
  try { const tp = await readUpgradeAuthority(conn, m.program === "token-2022" ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); facts.tokenProgram = tp; } catch (e) { unavailable.tokenProgram = (e as Error).message; }
  try {
    const largest = await conn.getTokenLargestAccounts(new PublicKey(mint));
    const top = largest.value.slice(0, 10).map((a: any) => ({ account: a.address.toBase58(), amount: a.amount }));
    const sum = top.reduce((s: bigint, a: any) => s + BigInt(a.amount), 0n);
    facts.holders = { topAccounts: top, top10ShareBps: m.supply > 0n ? Number((sum * 10_000n) / m.supply) : null, note: "Token accounts, not people; pools and exchanges hold on behalf of many." };
  } catch (e) { unavailable.holders = `Largest accounts unavailable from RPC: ${(e as Error).message.slice(0, 120)}`; }
  const { data: launch } = await (await db()).from("launches").select("pool,config,creator_wallet,lifecycle,damm_v2_pool,signature,passports(manifest_hash,manifest)").eq("base_mint", mint).maybeSingle();
  if (launch) {
    const sig: any = launch.passports?.manifest;
    facts.fleuri = { passport: launch.passports?.manifest_hash, launchTx: launch.signature, recordedLifecycle: launch.lifecycle, signedCreator: launch.creator_wallet };
    try { const p: any = await readPool(conn, launch.pool); facts.dbc = { pool: launch.pool, currentCreator: p.creator, creatorChanged: p.creator !== launch.creator_wallet, migrated: p.isMigrated ?? null, quoteReserve: p.quoteReserve ?? null }; } catch (e) { unavailable.dbcPool = (e as Error).message; }
    try { const c: any = await readDbcConfig(conn, launch.config); facts.dbcConfig = { address: launch.config, feeClaimer: c.feeClaimer, signedFeeClaimer: sig?.fees?.feeClaimer, matchesSigned: c.feeClaimer === sig?.fees?.feeClaimer, migrationQuoteThreshold: c.migrationQuoteThreshold?.toString?.() ?? null }; } catch (e) { unavailable.dbcConfig = (e as Error).message; }
    try { facts.dbcProgram = await readUpgradeAuthority(conn, DBC_PROGRAM_ID); } catch (e) { unavailable.dbcProgram = (e as Error).message; }
  } else unavailable.protocol = "Not a fleuri launch: DBC config, signed promises and graduation are not applicable.";
  unavailable.lp = "LP position and lock state are not proven by this report; Meteora position accounts were not decoded.";
  return { format: "fleuri.botanist.report/v1", observedSlot: slot, observedAt: at, mint, facts, unavailable, disclaimer: "Point-in-time chain observations. Not an audit, not a safety rating and not financial advice." };
}
