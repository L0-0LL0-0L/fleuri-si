// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { b64 } from "./canonical";
import { reviewAnchorPrep, type AnchorPrep } from "./anchor-review";
import { GENESIS } from "./registration";
import { MEMO_PROGRAM, receiptMemo } from "./receipt";

const w = Keypair.generate().publicKey; const H = "a".repeat(64);
function txB64(opts: { memo?: string; payer?: PublicKey; extra?: boolean } = {}) {
  const t = new Transaction().add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [{ pubkey: w, isSigner: true, isWritable: false }], data: Buffer.from(opts.memo ?? receiptMemo(H)) }));
  if (opts.extra) t.add(SystemProgram.transfer({ fromPubkey: w, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  t.feePayer = opts.payer ?? w; t.recentBlockhash = "11111111111111111111111111111111";
  return b64(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
const ok = (): AnchorPrep => ({ preparationId: "p", transaction: txB64(), memo: receiptMemo(H), wallet: w.toBase58(), cluster: "devnet", genesisHash: GENESIS.devnet, expiresAt: new Date(Date.now() + 60_000).toISOString(), cost: { ok: true, balanceLamports: 10_000, simulatedChangeLamports: 5000, networkFeeLamports: 5000 } });
const ex = { wallet: w.toBase58(), cluster: "devnet", genesisHash: GENESIS.devnet, manifestHash: H };

describe("anchor preparation review", () => {
  it("passes only when the exact bytes, wallet, network, expiry and simulation all check out", () => {
    const r = reviewAnchorPrep(ok(), ex); expect(r).toMatchObject({ ok: true, memo: receiptMemo(H), feePayer: w.toBase58() });
  });
  it("disables signing on simulation failure/unavailability or insufficient balance", () => {
    expect(reviewAnchorPrep({ ...ok(), cost: { ok: false, error: "Simulation failed: X" } }, ex).problems.join()).toMatch(/simulation failed/);
    expect(reviewAnchorPrep({ ...ok(), cost: null }, ex).ok).toBe(false);
    expect(reviewAnchorPrep({ ...ok(), cost: { ok: true, balanceLamports: 10, simulatedChangeLamports: 5000, networkFeeLamports: 5000 } }, ex).problems.join()).toMatch(/balance/);
  });
  it("refuses expired preps, wrong network/genesis, other memo, other fee payer or extra instructions", () => {
    expect(reviewAnchorPrep({ ...ok(), expiresAt: new Date(Date.now() - 1).toISOString() }, ex).problems.join()).toMatch(/expired/);
    expect(reviewAnchorPrep({ ...ok(), cluster: "mainnet-beta" }, ex).ok).toBe(false);
    expect(reviewAnchorPrep({ ...ok(), genesisHash: GENESIS["mainnet-beta"] }, ex).problems.join()).toMatch(/genesis/);
    expect(reviewAnchorPrep({ ...ok(), transaction: txB64({ memo: receiptMemo("b".repeat(64)) }) }, ex).problems.join()).toMatch(/Memo text/);
    expect(reviewAnchorPrep({ ...ok(), transaction: txB64({ payer: Keypair.generate().publicKey }) }, ex).problems.join()).toMatch(/fee payer/);
    expect(reviewAnchorPrep({ ...ok(), transaction: txB64({ extra: true }) }, ex).problems.join()).toMatch(/exactly one instruction/);
    expect(reviewAnchorPrep({ ...ok(), transaction: "!!" }, ex).problems.join()).toMatch(/could not be decoded/);
  });
});
