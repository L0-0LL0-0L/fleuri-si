import { sha256Hex, utf8 } from "@/pq/canonical";
// @vitest-environment node
// Botanist quote → payment → settlement → report orchestration, with in-memory chain/facilitator/DB fakes.
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { BOTANIST_ASSET, X402_NETWORK, createTransferCheckedInstruction, getAssociatedTokenAddressSync, verifyExactTransaction } from "@/pq/botanist";
import { b64 } from "@/pq/canonical";
import { r402, resolveHeaderJob, settleAndDeliver, requirementOf, type FlowDeps, type Job } from "./botanist-flow";

const fac = Keypair.generate(), payer = Keypair.generate(), payTo = Keypair.generate().publicKey.toBase58();
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const mkJob = (): Job => ({ id: crypto.randomUUID(), capability_hash: "c", network: X402_NETWORK, asset: BOTANIST_ASSET, amount: 500000, pay_to: payTo, fee_payer: fac.publicKey.toBase58(), memo: `fleuri-botanist:${crypto.randomUUID().replace(/-/g, "")}`, resource: "https://fleuri.test/api/public/botanist/report", mint: "So11111111111111111111111111111111111111112", status: "quoted", quote_expires_at: new Date(Date.now() + 600_000).toISOString() });
function payTx(j: Job, signer = payer, blockhash = "11111111111111111111111111111112") {
  const mint = new PublicKey(BOTANIST_ASSET);
  const m = new TransactionMessage({ payerKey: fac.publicKey, recentBlockhash: blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, signer.publicKey), mint, getAssociatedTokenAddressSync(mint, new PublicKey(payTo), true), signer.publicKey, 500_000n, 6),
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(j.memo) })] }).compileToV0Message();
  const vt = new VersionedTransaction(m); vt.sign([signer]); return { b64: b64(vt.serialize()), vt };
}
const header = (j: Job, tx: string) => encodePaymentSignatureHeader({ x402Version: 2, resource: { url: j.resource }, accepted: requirementOf(j), payload: { transaction: tx } } as any);
const landed = (vt: VersionedTransaction, j: Job, slot = 77) => { const c = verifyExactTransaction(b64(vt.serialize()), requirementOf(j)); const bal = (a: string) => [{ accountIndex: c.destIndex, mint: BOTANIST_ASSET, owner: payTo, uiTokenAmount: { amount: a } }]; return { slot, meta: { err: null, preTokenBalances: bal("0"), postTokenBalances: bal("500000") }, transaction: { message: vt.message } }; };

/** In-memory model of the atomic SQL transitions (the real SQL is covered by botanist-db.test). */
function world(j0: Job, o: Partial<{ verify: any; settle: () => Promise<any>; chain: Map<string, any>; rpcDown: () => boolean; reportFails: () => boolean }> = {}) {
  let j = { ...j0 }; const calls: string[] = []; const settles: { url: string; key: string; body: string }[] = []; const chain = o.chain ?? new Map<string, any>();
  const d: FlowDeps = {
    rpc: async (fn, a: any) => {
      calls.push(fn);
      if (fn === "botanist_claim_payment") { if (j.payment_hash && j.payment_hash !== a._payment_hash) throw new Error("different payment"); j = { ...j, status: "payment_submitted", payment_hash: a._payment_hash, payment_tx_b64: a._tx, payer: a._payer }; }
      if (fn === "botanist_record_candidate") { if (j.candidate_signature && j.candidate_signature !== a._sig) throw new Error("Different candidate"); j = { ...j, candidate_signature: a._sig, status: "settlement_pending" }; }
      if (fn === "botanist_mark_settled") { if (j.candidate_signature && j.candidate_signature !== a._sig) throw new Error("differs from candidate"); j = { ...j, status: "settled", settle_signature: a._sig, settled_slot: a._slot, settled_at: "t" }; }
      if (fn === "botanist_mark_failed") j = { ...j, status: "failed", error: a._reason };
      if (fn === "botanist_store_report") { if (!j.report) j = { ...j, status: "report_ready", report: a._report, report_digest: a._digest }; }
      return j;
    },
    noteError: async () => {},
    facilitator: (url, key) => ({ verify: async () => { calls.push("verify"); return o.verify ?? { isValid: true }; }, settle: async (p: any, r: any) => { calls.push("settle"); settles.push({ url, key, body: JSON.stringify({ p, r }) }); return o.settle ? o.settle() : { success: false, errorReason: "unknown" }; } }),
    defaultFacilitator: "https://fac.test",
    getTx: async (s) => { if (o.rpcDown?.()) throw new Error("RPC timeout"); return chain.get(s) ?? null; },
    findByMessage: async () => null,
    buildReport: async (mint) => { if (o.reportFails?.()) throw new Error("rpc"); return { format: "fleuri.botanist.report/v1", mint, supply: "1" }; },
    sleep: async () => {}, confirmPolls: 2,
  };
  return { d, calls, settles, get job() { return j; }, chain };
}

describe("botanist payment orchestration", () => {
  it("happy path: verify → bind → settle → record candidate → confirm exact credit → deliver", async () => {
    const j = mkJob(); const { b64: tx, vt } = payTx(j); const chain = new Map();
    const w = world(j, { chain, settle: async () => { chain.set("SIG1", landed(vt, j)); return { success: true, transaction: "SIG1" }; } });
    const r = await settleAndDeliver(w.d, j, header(j, tx));
    expect(r.status).toBe(200); expect(r.body.receipt.payment.transaction).toBe("SIG1"); expect(r.headers?.["PAYMENT-RESPONSE"]).toBeTruthy();
    expect(w.calls).toEqual(["verify", "botanist_claim_payment", "settle", "botanist_record_candidate", "botanist_mark_settled", "botanist_store_report"]);
  });
  it("a facilitator-rejected first payload does not lock the job and returns PAYMENT-REQUIRED", async () => {
    const j = mkJob(); const w = world(j, { verify: { isValid: false, invalidReason: "transaction_simulation_failed" } });
    const r = await settleAndDeliver(w.d, j, header(j, payTx(j).b64));
    expect(r.status).toBe(402); expect(r.headers?.["PAYMENT-REQUIRED"]).toBeTruthy(); expect(w.job.payment_hash).toBeUndefined();
    expect(w.calls).not.toContain("botanist_claim_payment");
  });
  it("a tampered signature is refused locally before the facilitator or the database", async () => {
    const j = mkJob(); const { vt } = payTx(j); vt.signatures[1] = new Uint8Array(64).fill(7);
    const w = world(j); const r = await settleAndDeliver(w.d, j, header(j, b64(vt.serialize())));
    expect(r.status).toBe(402); expect(r.headers?.["PAYMENT-REQUIRED"]).toBeTruthy(); expect(w.calls).toEqual([]);
  });
  it("settled but RPC timed out → pending; retry confirms the SAME candidate without re-verify/re-settle, then delivers", async () => {
    const j = mkJob(); const { b64: tx, vt } = payTx(j); const chain = new Map(); let down = true;
    const w = world(j, { chain, rpcDown: () => down, settle: async () => { chain.set("SIG2", landed(vt, j)); return { success: true, transaction: "SIG2" }; } });
    const r1 = await settleAndDeliver(w.d, j, header(j, tx));
    expect(r1.status).toBe(202); expect(w.job.candidate_signature).toBe("SIG2"); expect(w.job.settle_signature).toBeUndefined();
    down = false; const before = w.calls.length;
    const r2 = await settleAndDeliver(w.d, w.job, header(j, tx)); // same saved bytes resent
    expect(r2.status).toBe(200); expect(w.calls.slice(before)).toEqual(["botanist_mark_settled", "botanist_store_report"]);
    const r3 = await settleAndDeliver(w.d, w.job, null); expect(r3.body.report).toEqual(r2.body.report); // repeat delivery, no regeneration
  });
  it("settle succeeded but response lost → same-job retry replays /settle with the SAME body and Idempotency-Key, never re-verifies, recovers the receipt", async () => {
    const j = { ...mkJob(), request_hash: "rh-1" } as Job; const { b64: tx, vt } = payTx(j); const chain = new Map(); let n = 0;
    const w = world(j, { chain, settle: async () => { chain.set("SIG9", landed(vt, j)); if (n++ === 0) throw new Error("socket hang up"); return { success: true, transaction: "SIG9" }; } });
    const r1 = await settleAndDeliver(w.d, j, header(j, tx));
    expect(r1.status).toBe(202); expect(w.job.settle_signature).toBeUndefined();
    const before = w.calls.length;
    const r2 = await settleAndDeliver(w.d, w.job, header(j, tx));
    expect(r2.status).toBe(200); expect(r2.body.receipt.payment.transaction).toBe("SIG9");
    expect(w.calls.slice(before)).not.toContain("verify"); expect(w.calls.slice(before)).not.toContain("botanist_claim_payment");
    expect(w.settles).toHaveLength(2); expect(w.settles[0]).toEqual(w.settles[1]); expect(w.settles[0].key).toBe("rh-1");
  });
  it("frozen accepted requirement/resource/facilitator are reused even if defaults change after the quote", async () => {
    const base = mkJob(); const frozen = { ...requirementOf(base), maxTimeoutSeconds: 123 };
    const j = { ...base, request_hash: "rh-2", accepted: frozen, resource_info: { url: base.resource, description: "frozen", mimeType: "application/json" }, facilitator: "https://frozen.fac" } as any;
    const { b64: tx } = payTx(j); const w = world(j); w.d.defaultFacilitator = "https://changed.fac";
    await settleAndDeliver(w.d, j, header(j, tx));
    expect(w.settles[0].url).toBe("https://frozen.fac"); expect(JSON.parse(w.settles[0].body).r.maxTimeoutSeconds).toBe(123); expect(JSON.parse(w.settles[0].body).p.resource.description).toBe("frozen");
  });
  it("settlement_pending with a signature is persisted and treated as pending", async () => {
    const j = mkJob(); const w = world(j, { settle: async () => ({ success: false, errorReason: "settlement_pending", transaction: "SIG3" }) });
    const r = await settleAndDeliver(w.d, j, header(j, payTx(j).b64));
    expect(r.status).toBe(202); expect(w.job.candidate_signature).toBe("SIG3"); expect(w.job.status).toBe("settlement_pending");
  });
  it("a facilitator-reported transaction that is not the accepted message never delivers", async () => {
    const j = mkJob(); const { b64: tx } = payTx(j); const other = payTx(j, payer, "11111111111111111111111111111113"); const chain = new Map();
    const w = world(j, { chain, settle: async () => { chain.set("SIGX", landed(other.vt, j)); return { success: true, transaction: "SIGX" }; } });
    const r = await settleAndDeliver(w.d, j, header(j, tx));
    expect(r.status).toBe(502); expect(w.job.settle_signature).toBeUndefined(); expect(w.job.report).toBeUndefined();
  });
  it("a different payment on an accepted job is refused without asking the wallet again", async () => {
    const j = mkJob(); const w = world(j, { settle: async () => ({ success: false, errorReason: "timeout" }) });
    await settleAndDeliver(w.d, j, header(j, payTx(j).b64));
    const r = await settleAndDeliver(w.d, w.job, header(j, payTx(j, payer, "11111111111111111111111111111114").b64));
    expect(r.status).toBe(409); expect(w.calls.filter((c) => c === "verify")).toHaveLength(1);
  });
  it("free-tier exhaustion before broadcast is retryable and says nothing was broadcast", async () => {
    const j = mkJob(); const w = world(j, { settle: async () => ({ success: false, errorReason: "free_tier_exhausted" }) });
    const r = await settleAndDeliver(w.d, j, header(j, payTx(j).b64)); expect(r.status).toBe(503); expect(r.body.error).toMatch(/NOT broadcast/);
  });
  it("on-chain failure of the exact accepted message is terminal and never delivers", async () => {
    const j = mkJob(); const { b64: tx, vt } = payTx(j); const chain = new Map();
    const w = world(j, { chain, settle: async () => { const t = landed(vt, j); chain.set("SIGF", { ...t, meta: { ...t.meta, err: { InstructionError: [2, "x"] } } }); return { success: true, transaction: "SIGF" }; } });
    expect((await settleAndDeliver(w.d, j, header(j, tx))).status).toBe(410); expect(w.job.status).toBe("failed");
    expect((await settleAndDeliver(w.d, w.job, null)).status).toBe(410);
  });
  it("settled payment with a failing report build resumes to delivery without a new charge", async () => {
    const j = mkJob(); const { b64: tx, vt } = payTx(j); const chain = new Map(); let fail = true;
    const w = world(j, { chain, reportFails: () => fail, settle: async () => { chain.set("SIGR", landed(vt, j)); return { success: true, transaction: "SIGR" }; } });
    expect((await settleAndDeliver(w.d, j, header(j, tx))).body.settled).toBe(true);
    fail = false; const r = await settleAndDeliver(w.d, w.job, null); expect(r.status).toBe(200); expect(w.calls.filter((c) => c === "settle")).toHaveLength(1);
  });
  it("generic x402 client: 402 → signed-header retry of the ORIGINAL POST {mint} settles that exact job; replay and UI resume return the same receipt", async () => {
    const token = "ab".repeat(32); const j: Job = { ...mkJob(), capability_hash: sha256Hex(utf8(token)) }; const chain = new Map();
    // Only the capability holder receives this 402 (the quote response); it carries the off-chain capability.
    const pr: any = decodePaymentRequiredHeader(r402(j, undefined, {}, token).headers!["PAYMENT-REQUIRED"]);
    expect(pr.accepts[0].extra.botanistCapability).toBe(token); expect(pr.accepts[0].extra.botanistJob).toBe(j.id);
    const { b64: tx, vt } = payTx({ ...j, memo: pr.accepts[0].extra.memo });
    const sig = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: tx } } as any);
    const w = world(j, { chain, settle: async () => { chain.set("SIGG", landed(vt, j)); return { success: true, transaction: "SIGG" }; } });
    const find = async (id: string, t: string) => (id === w.job.id && sha256Hex(utf8(t)) === w.job.capability_hash ? w.job : null);
    const r = await resolveHeaderJob(sig, { mint: j.mint }, j.resource, find); expect("job" in r).toBe(true);
    const first = await settleAndDeliver(w.d, (r as any).job, sig, token); expect(first.status).toBe(200);
    // The facilitator got the frozen requirement only: no capability, byte-stable across retries.
    expect(w.settles[0].body).not.toContain(token);
    const again = await resolveHeaderJob(sig, { mint: j.mint }, j.resource, find);
    const replay = await settleAndDeliver(w.d, (again as any).job, sig, token);
    expect(replay.body.receipt).toEqual(first.body.receipt); expect(w.calls.filter((c) => c === "settle")).toHaveLength(1);
    // UI resume path (jobId + token, authorized by findJob's capability_hash match) returns the same receipt.
    const ui = await find(j.id, token); expect(ui).not.toBeNull();
    expect((await settleAndDeliver(w.d, ui!, null, token)).body.receipt).toEqual(first.body.receipt);
    expect((await resolveHeaderJob(sig, { mint: "Other1111111111111111111111111111111111111" }, j.resource, find) as any).status).toBe(409);
    expect((await resolveHeaderJob(sig, { mint: j.mint }, "https://evil.test/r", find) as any).status).toBe(409);
  });
  it("a PUBLIC on-chain memo plus a forged header cannot retrieve a paid report without the capability", async () => {
    const token = "cd".repeat(32); const j: Job = { ...mkJob(), capability_hash: sha256Hex(utf8(token)) }; const chain = new Map();
    const { b64: tx, vt } = payTx(j);
    const w = world(j, { chain, settle: async () => { chain.set("SIGP", landed(vt, j)); return { success: true, transaction: "SIGP" }; } });
    expect((await settleAndDeliver(w.d, j, header(j, tx), token)).status).toBe(200); expect(w.job.report).toBeTruthy();
    const find = async (id: string, t: string) => (id === w.job.id && sha256Hex(utf8(t)) === w.job.capability_hash ? w.job : null);
    let lookups = 0; const spy = async (id: string, t: string) => { lookups++; return find(id, t); };
    const forge = (extra: Record<string, unknown>) => encodePaymentSignatureHeader({ x402Version: 2, resource: { url: j.resource }, accepted: { ...requirementOf(j), extra: { feePayer: j.fee_payer, memo: j.memo, ...extra } }, payload: { transaction: "AAAA" } } as any);
    const cases = [forge({}), forge({ botanistJob: j.id }), forge({ botanistJob: j.id, botanistCapability: "00".repeat(32) }), forge({ botanistJob: crypto.randomUUID(), botanistCapability: token }), forge({ botanistJob: j.id, botanistCapability: "short" })];
    for (const c of cases) {
      const r: any = await resolveHeaderJob(c, { mint: j.mint }, j.resource, spy);
      expect("job" in r).toBe(false); expect([401, 404]).toContain(r.status); expect(JSON.stringify(r.body)).not.toContain("report_ready"); expect(r.body.report).toBeUndefined();
    }
    expect(lookups).toBe(2); // malformed / missing capabilities are rejected before any lookup
  });
});
