// Botanist payment orchestration (x402 v2 exact). Pure: every side effect is an injected dependency,
// so quote/payment/recovery transitions are tested without a network or a live database.
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { QUOTE_TTL_S, receipt, sameRequirement, settledCredit, verifyExactTransaction, type Requirement } from "@/pq/botanist";
import { canonicalize, sha256Hex, utf8 } from "@/pq/canonical";

export type Out = { status: number; body: any; headers?: Record<string, string> };
export type Job = Record<string, any>;
export type ConfirmedTx = Parameters<typeof settledCredit>[0] & { slot: number };
export type FlowDeps = {
  rpc: (fn: "botanist_claim_payment" | "botanist_record_candidate" | "botanist_mark_settled" | "botanist_mark_failed" | "botanist_store_report", args: Record<string, unknown>) => Promise<Job>;
  noteError: (id: string, error: string) => Promise<void>;
  facilitator: (url: string, idempotencyKey: string) => { verify: (p: any, r: any) => Promise<any>; settle: (p: any, r: any) => Promise<any> };
  defaultFacilitator: string;
  /** One confirmed-commitment read; null if not (yet) visible. May throw on RPC timeout. */
  getTx: (signature: string) => Promise<ConfirmedTx | null>;
  /** Finds a landed transaction whose message hash equals the accepted payment (lost facilitator response). */
  findByMessage: (job: Job) => Promise<string | null>;
  buildReport: (mint: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  confirmPolls?: number;
};

export const requirementOf = (j: Job): Requirement => (j as any).accepted ?? ({ scheme: "exact", network: j.network, asset: j.asset, amount: String(j.amount), payTo: j.pay_to, maxTimeoutSeconds: QUOTE_TTL_S, extra: { feePayer: j.fee_payer, memo: j.memo } });
/** Frozen at quote time so identical-body /settle retries stay identical after settings or code changes. */
export const resourceOf = (j: Job) => (j as any).resource_info ?? { url: j.resource, description: `Botanist field report for mint ${j.mint}`, mimeType: "application/json" };
/**
 * The off-chain retrieval capability (job id + raw token) is advertised to the capability holder in the
 * 402's requirement extra, so generic x402 clients echo it back in PAYMENT-SIGNATURE.accepted. It is never
 * stored in plaintext (only capability_hash), never part of the frozen requirement sent to the facilitator,
 * and never on chain — the public memo is NOT authorization.
 */
export const withCapability = (r: Requirement, j: Job, token?: string): Requirement => token ? ({ ...r, extra: { ...r.extra, botanistJob: j.id, botanistCapability: token } } as any) : r;
export const paymentRequired = (j: Job, error?: string, token?: string) => ({ x402Version: 2, ...(error ? { error } : {}), resource: resourceOf(j), accepts: [withCapability(requirementOf(j), j, token)] });
/** Every real 402 carries the PAYMENT-REQUIRED header. */
export const r402 = (j: Job, error?: string, extra: Record<string, unknown> = {}, token?: string): Out => {
  const pr = paymentRequired(j, error, token);
  return { status: 402, body: { ...pr, ...extra, jobId: j.id, expiresAt: j.quote_expires_at, mint: j.mint }, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as any) } };
};
const FREE = /free_tier|quota|allowance/i;
const PENDING = /pending|timeout|timed out|not.?confirmed|blockhash/i;

export function delivered(j: Job): Out {
  const rc = receipt({ ...j, amount: String(j.amount) } as any, j.report);
  return { status: 200, body: { status: "report_ready", jobId: j.id, mint: j.mint, report: j.report, receipt: rc },
    headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: j.settle_signature, network: j.network, payer: j.payer } as any) } };
}

async function confirm(d: FlowDeps, j: Job, signature: string) {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (d.confirmPolls ?? 6); i++) {
    let t: ConfirmedTx | null = null;
    try { t = await d.getTx(signature); } catch { t = null; }
    if (t) { const c = settledCredit(t, requirementOf(j), j.payment_hash); return c.ok ? { kind: "ok" as const, slot: t.slot } : (c as any).mismatch ? { kind: "mismatch" as const, reason: c.reason } : c.terminal ? { kind: "failed" as const, reason: c.reason } : { kind: "pending" as const, reason: c.reason }; }
    if (i + 1 < (d.confirmPolls ?? 6)) await sleep(1500);
  }
  return { kind: "pending" as const, reason: "Settlement is not yet visible on chain." };
}

const pending = (j: Job, detail: string): Out => ({ status: 202, body: { status: "pending", detail: `${detail} Resume this job later — the same signed payment is reused and you will not be asked to pay again.`, jobId: j.id } });

/** Accept (first time) or resume a payment, settle, confirm the exact credit, then deliver. */
/** Callers MUST have authorized the job with its capability (body token or header capability) first. */
export async function settleAndDeliver(d: FlowDeps, job: Job, sig: string | null, token?: string): Promise<Out> {
  let j = job;
  if (j.report) return delivered(j);
  if (j.status === "failed") return { status: 410, body: { error: `This payment did not settle on chain (${j.error ?? "failed"}). Nothing was credited; start a new quote.`, jobId: j.id, terminal: true } };
  const req = requirementOf(j);
  const facUrl = j.facilitator ?? d.defaultFacilitator;

  if (sig) {
    let payload: any;
    try { payload = decodePaymentSignatureHeader(sig); } catch { return { status: 400, body: { error: "PAYMENT-SIGNATURE could not be decoded." } }; }
    const txB64 = String(payload?.payload?.transaction ?? "");
    if (j.payment_hash) {
      // Already accepted: only the identical bytes may resume. No re-verification, no new lock.
      if (txB64 !== j.payment_tx_b64) return { status: 409, body: { error: "This job already has a different accepted payment. Resume with the saved one.", jobId: j.id } };
    } else {
      if (payload.x402Version !== 2 || !sameRequirement(req, payload.accepted)) return r402(j, "Payment does not match the frozen quote.", {}, token);
      if (new Date(j.quote_expires_at).getTime() <= Date.now()) return { status: 410, body: { error: "Quote expired. Start a new report; nothing was charged." } };
      let local; try { local = verifyExactTransaction(txB64, req); } catch (e) { return r402(j, (e as Error).message, {}, token); }
      // Facilitator verification (incl. simulation) BEFORE binding, so a bad first payload can't lock the job.
      const durable = { x402Version: 2, resource: resourceOf(j), accepted: req, payload: { transaction: txB64 } };
      let v: any;
      try { v = await d.facilitator(facUrl, j.request_hash).verify(durable, req); } catch { return { status: 502, body: { error: "Facilitator unreachable while verifying. Nothing was accepted or charged; try again.", jobId: j.id } }; }
      if (!v?.isValid) {
        const why = `${v?.invalidReason ?? ""} ${v?.invalidMessage ?? ""}`;
        if (FREE.test(why)) return { status: 503, body: { error: "The payment facilitator's free allowance is used up right now. Nothing was charged; retry later.", jobId: j.id } };
        return r402(j, `Payment rejected by facilitator: ${v?.invalidMessage ?? v?.invalidReason ?? "invalid"}`, {}, token);
      }
      try { j = await d.rpc("botanist_claim_payment", { _id: j.id, _cap: j.capability_hash, _payment_hash: local.paymentHash, _tx: txB64, _payer: local.payer }); }
      catch (e) { const m = (e as Error).message; return { status: 409, body: { error: /duplicate|unique/i.test(m) ? "This payment is already bound to another job." : m, jobId: j.id } }; }
    }
  }
  if (!j.payment_tx_b64) return r402(j, undefined, {}, token);

  if (!j.settle_signature) {
    // 1) Known candidate first (even if its blockhash has expired). 2) Recover a lost response from chain.
    let candidate: string | null = j.candidate_signature ?? null;
    if (!candidate) { try { candidate = await d.findByMessage(j); } catch { candidate = null; } if (candidate) j = await d.rpc("botanist_record_candidate", { _id: j.id, _sig: candidate }); }
    if (!candidate) {
      const durable = { x402Version: 2, resource: resourceOf(j), accepted: req, payload: { transaction: j.payment_tx_b64 } };
      let s: any;
      try { s = await d.facilitator(facUrl, j.request_hash).settle(durable, req); }
      catch { await d.noteError(j.id, "Facilitator settle call failed or timed out"); return pending(j, "The facilitator did not answer; the payment may or may not have been broadcast."); }
      const why = `${s?.errorReason ?? ""} ${s?.errorMessage ?? ""}`;
      if (s?.transaction) { candidate = String(s.transaction); j = await d.rpc("botanist_record_candidate", { _id: j.id, _sig: candidate }); }
      if (!s?.success && !candidate) {
        await d.noteError(j.id, `Settlement: ${why.trim() || "unknown"}`.slice(0, 300));
        if (FREE.test(why)) return { status: 503, body: { error: "The payment facilitator's free allowance is used up right now. Your signed payment was NOT broadcast; resume later with the same job.", jobId: j.id } };
        if (PENDING.test(why)) return pending(j, "Settlement is pending at the facilitator.");
        return { status: 502, body: { error: `Settlement failed: ${why.trim() || "unknown"}. Resume reuses this same payment; you will not be charged twice.`, jobId: j.id } };
      }
    }
    const c = await confirm(d, j, candidate!);
    if (c.kind === "pending") return pending(j, c.reason);
    if (c.kind === "mismatch") { await d.noteError(j.id, c.reason); return { status: 502, body: { error: `The facilitator reported a transaction that is not your accepted payment, so no report is delivered for it. Your accepted payment is unchanged; resume later.`, jobId: j.id } }; }
    if (c.kind === "failed") { await d.rpc("botanist_mark_failed", { _id: j.id, _reason: c.reason }); return { status: 410, body: { error: `${c.reason} No report is delivered for it.`, jobId: j.id, terminal: true } }; }
    j = await d.rpc("botanist_mark_settled", { _id: j.id, _sig: candidate, _slot: c.slot });
  }
  try {
    const report = await d.buildReport(j.mint);
    const text = canonicalize(report as any); JSON.stringify(report);
    j = await d.rpc("botanist_store_report", { _id: j.id, _report: report, _digest: sha256Hex(utf8(text)) });
    return delivered(j);
  } catch (e) {
    await d.noteError(j.id, `Report generation: ${(e as Error).message.slice(0, 200)}`);
    return { status: 503, body: { error: "Payment is settled; the report could not be generated yet. Resume this job — no new charge.", jobId: j.id, settled: true } };
  }
}

/**
 * Generic x402 clients retry the ORIGINAL request ({mint}) with PAYMENT-SIGNATURE and no jobId.
 * Authorization is the off-chain capability echoed in accepted.extra (botanistJob + botanistCapability),
 * checked against capability_hash BEFORE any job state or report is returned. The memo is public once the
 * payment lands, so it is only cross-checked, never used to authorize.
 */
export async function resolveHeaderJob(sig: string, body: any, resource: string, findByCapability: (id: string, token: string) => Promise<Job | null>): Promise<{ job: Job; token: string } | Out> {
  let p: any; try { p = decodePaymentSignatureHeader(sig); } catch { return { status: 400, body: { error: "PAYMENT-SIGNATURE could not be decoded." } }; }
  const x = p?.accepted?.extra ?? {};
  const id = x.botanistJob, token = x.botanistCapability;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token))
    return { status: 401, body: { error: "Payment does not carry this quote's retrieval capability. Retry with the PAYMENT-REQUIRED you were issued, or resume with jobId and token." } };
  const j = await findByCapability(id, token);
  if (!j) return { status: 404, body: { error: "Unknown job or wrong retrieval capability." } };
  if (x.memo !== j.memo) return { status: 409, body: { error: "This payment references a different quote.", jobId: j.id } };
  if (body?.mint !== undefined && String(body.mint).trim() !== j.mint) return { status: 409, body: { error: "This payment was quoted for a different mint.", jobId: j.id } };
  if (j.resource !== resource || (p.resource?.url && p.resource.url !== j.resource)) return { status: 409, body: { error: "This payment was quoted for a different resource.", jobId: j.id } };
  return { job: j, token };
}
