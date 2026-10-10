import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
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

describe("x402 exact SVM verification", () => {
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
  it("only counts a successful confirmed credit of the exact amount to payTo", () => {
    const bal = (a: string) => [{ mint: BOTANIST_ASSET, owner: payTo, uiTokenAmount: { amount: a } }];
    expect(settledCredit({ err: null, preTokenBalances: bal("10"), postTokenBalances: bal("500010") }, req).ok).toBe(true);
    expect(settledCredit({ err: { InstructionError: [2, "x"] }, preTokenBalances: bal("0"), postTokenBalances: bal("500000") }, req).ok).toBe(false);
    expect(settledCredit({ err: null, preTokenBalances: [], postTokenBalances: [] }, req).ok).toBe(false);
  });
  it("receipt digests the delivered report and disclaims correctness", () => {
    const r = receipt({ id: "j", request_hash: "h", network: X402_NETWORK, asset: BOTANIST_ASSET, amount: "500000", pay_to: payTo, payer: "p", settle_signature: "s", settled_slot: 1, settled_at: "t", mint: "m" }, { a: 1 });
    expect(r.outputDigest).toMatch(/^[0-9a-f]{64}$/); expect(r.notice).toMatch(/not certify/);
  });
});
