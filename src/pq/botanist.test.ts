// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { createTransferCheckedInstruction as splTransfer, getAssociatedTokenAddressSync as splAta } from "@solana/spl-token";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "./botanist";
import { b64 } from "./canonical";
import { BOTANIST_ASSET, X402_NETWORK, receipt, sameRequirement, settledCredit, verifyExactTransaction, type Requirement } from "./botanist";

const fac = Keypair.generate(), payer = Keypair.generate(), payTo = Keypair.generate().publicKey.toBase58();
const req: Requirement = { scheme: "exact", network: X402_NETWORK, asset: BOTANIST_ASSET, amount: "500000", payTo, maxTimeoutSeconds: 600, extra: { feePayer: fac.publicKey.toBase58(), memo: "fleuri-botanist:abc" } };
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
function build(o: { amount?: bigint; mint?: string; to?: string; memo?: string; extra?: TransactionInstruction; cu?: number; sign?: boolean; authority?: Keypair } = {}) {
  const mint = new PublicKey(o.mint ?? BOTANIST_ASSET); const auth = o.authority ?? payer;
  const tx = new Transaction({ feePayer: fac.publicKey, recentBlockhash: "11111111111111111111111111111111" });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: o.cu ?? 40_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, auth.publicKey), mint, getAssociatedTokenAddressSync(mint, new PublicKey(o.to ?? payTo), true), auth.publicKey, o.amount ?? 500_000n, 6),
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(o.memo ?? req.extra.memo) }));
  if (o.extra) tx.add(o.extra);
  if (o.sign !== false) tx.partialSign(auth);
  return b64(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
}

export function buildV0() {
  const mint = new PublicKey(BOTANIST_ASSET);
  const m = new TransactionMessage({ payerKey: fac.publicKey, recentBlockhash: "11111111111111111111111111111112", instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, payer.publicKey), mint, getAssociatedTokenAddressSync(mint, new PublicKey(payTo), true), payer.publicKey, 500_000n, 6),
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(req.extra.memo) })] }).compileToV0Message();
  const vt = new VersionedTransaction(m); vt.sign([payer]); return b64(vt.serialize());
}

describe("x402 exact SVM verification", () => {
  it("local SPL helpers match @solana/spl-token byte for byte", () => {
    const m = new PublicKey(BOTANIST_ASSET), o = payer.publicKey;
    expect(getAssociatedTokenAddressSync(m, o).toBase58()).toBe(splAta(m, o).toBase58());
    const a = createTransferCheckedInstruction(o, m, o, o, 5n, 6), b = splTransfer(o, m, o, o, 5n, 6);
    expect(Buffer.from(a.data).toString("hex")).toBe(b.data.toString("hex")); expect(a.keys).toEqual(b.keys);
  });
  it("accepts the exact transfer and binds the payer and a stable payment hash", () => {
    const t = build(); const r = verifyExactTransaction(t, req);
    expect(r.payer).toBe(payer.publicKey.toBase58()); expect(verifyExactTransaction(t, req).paymentHash).toBe(r.paymentHash);
  });
  it("rejects wrong amount, mint, recipient, memo, compute cap, extra instructions and missing signatures", () => {
    expect(() => verifyExactTransaction(build({ amount: 499_999n }), req)).toThrow(/amount/);
    expect(() => verifyExactTransaction(build({ mint: Keypair.generate().publicKey.toBase58() }), req)).toThrow(/token/);
    expect(() => verifyExactTransaction(build({ to: Keypair.generate().publicKey.toBase58() }), req)).toThrow(/recipient/);
    expect(() => verifyExactTransaction(build({ memo: "other-job" }), req)).toThrow(/memo/);
    expect(() => verifyExactTransaction(build({ cu: 1_400_000 }), req)).toThrow(/cap/);
    expect(() => verifyExactTransaction(build({ extra: new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(1) }) }), req)).toThrow(/unexpected/);
    expect(() => verifyExactTransaction(build({ sign: false }), req)).toThrow(/signature/);
    expect(() => verifyExactTransaction(build({ authority: fac }), req)).toThrow(/fee payer/i);
    expect(() => verifyExactTransaction(build(), { ...req, extra: { ...req.extra, feePayer: Keypair.generate().publicKey.toBase58() } })).toThrow(/facilitator/);
  });
  it("requires the accepted requirement to equal the frozen quote", () => {
    expect(sameRequirement(req, { ...req })).toBe(true);
    expect(sameRequirement(req, { ...req, amount: "1" })).toBe(false);
    expect(sameRequirement(req, { ...req, network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })).toBe(false);
  });
  it("verifies Ed25519 over the exact message and rejects tampered or foreign signatures", () => {
    const t = Buffer.from(build(), "base64");
    // signature for slot 1 (payer) starts at 1 + 64 (after shortvec count and fee-payer slot)
    const flipped = Buffer.from(t); flipped[1 + 64 + 5] ^= 1;
    expect(() => verifyExactTransaction(flipped.toString("base64"), req)).toThrow(/does not verify/);
    const other = Keypair.generate(); const vt = VersionedTransaction.deserialize(t);
    vt.signatures[1] = ed25519.sign(new Uint8Array(vt.message.serialize()), other.secretKey.subarray(0, 32));
    expect(() => verifyExactTransaction(b64(vt.serialize()), req)).toThrow(/does not verify/);
    const msgTamper = Buffer.from(t); msgTamper[msgTamper.length - 1] ^= 1; // memo byte changes, signature now stale
    expect(() => verifyExactTransaction(msgTamper.toString("base64"), req)).toThrow(/verify|memo/);
  });
  it("accepts a standard v0 VersionedTransaction payment", () => {
    const r = verifyExactTransaction(buildV0(), req); expect(r.payer).toBe(payer.publicKey.toBase58());
  });
  it("is accepted by the pinned @x402/svm reference exact verifier (legacy and v0)", async () => {
    const scheme = new ExactSvmScheme({ getAddresses: () => [fac.publicKey.toBase58()], simulateTransaction: async () => {} } as any);
    for (const tx of [build(), buildV0()]) {
      const v = await scheme.verify({ x402Version: 2, resource: { url: "https://fleuri.test/api/public/botanist/report" }, accepted: req, payload: { transaction: tx } } as any, req as any);
      expect(v.isValid, String(v.invalidReason)).toBe(true); expect(v.payer).toBe(payer.publicKey.toBase58());
    }
  });
  it("only counts a confirmed credit of THIS message to the canonical destination account index", () => {
    const t = VersionedTransaction.deserialize(Buffer.from(build(), "base64")); const c = verifyExactTransaction(build(), req);
    const at = (i: number, a: string, owner = payTo) => [{ accountIndex: i, mint: BOTANIST_ASSET, owner, uiTokenAmount: { amount: a } }];
    const tx = (meta: any, message = t.message) => ({ meta, transaction: { message } });
    expect(settledCredit(tx({ err: null, preTokenBalances: at(c.destIndex, "10"), postTokenBalances: at(c.destIndex, "500010") }), req, c.paymentHash).ok).toBe(true);
    expect(settledCredit(tx({ err: { InstructionError: [2, "x"] }, preTokenBalances: at(c.destIndex, "0"), postTokenBalances: at(c.destIndex, "500000") }), req, c.paymentHash).ok).toBe(false);
    // Another account owned by payTo gaining the amount is NOT this payment's destination.
    const wrongIdx = c.destIndex === 1 ? 2 : 1;
    expect(settledCredit(tx({ err: null, preTokenBalances: at(wrongIdx, "0"), postTokenBalances: at(wrongIdx, "500000") }), req, c.paymentHash).ok).toBe(false);
    // A different successful transfer (different message) never satisfies the accepted hash.
    const other = VersionedTransaction.deserialize(Buffer.from(buildV0(), "base64"));
    const r = settledCredit(tx({ err: null, preTokenBalances: at(c.destIndex, "0"), postTokenBalances: at(c.destIndex, "500000") }, other.message), req, c.paymentHash);
    expect(r.ok).toBe(false); expect((r as any).mismatch).toBe(true);
  });
  it("receipt digests the delivered report and disclaims correctness", () => {
    const r = receipt({ id: "j", request_hash: "h", network: X402_NETWORK, asset: BOTANIST_ASSET, amount: "500000", pay_to: payTo, payer: "p", settle_signature: "s", settled_slot: 1, settled_at: "t", mint: "m" }, { a: 1 });
    expect(r.outputDigest).toMatch(/^[0-9a-f]{64}$/); expect(r.notice).toMatch(/not certify/);
  });
});
