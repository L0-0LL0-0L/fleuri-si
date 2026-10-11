// Reviews the EXACT server-returned Memo preparation bytes before a wallet is asked to sign.
// Signing stays disabled unless every check passes, including a successful fee simulation.
import { Transaction } from "@solana/web3.js";
import { fromB64 } from "./canonical";
import { MEMO_PROGRAM, receiptMemo } from "./receipt";

export interface AnchorPrep { preparationId: string; transaction: string; memo: string; wallet: string; cluster: string; genesisHash?: string; expiresAt: string; reused?: boolean; cost?: { ok: boolean; error?: string; balanceLamports?: number; simulatedChangeLamports?: number; networkFeeLamports?: number } | null }
export interface AnchorReview { ok: boolean; problems: string[]; memo: string | null; feePayer: string | null; signers: string[] }

export function reviewAnchorPrep(p: AnchorPrep, expect: { wallet: string; cluster: string; genesisHash: string; manifestHash: string }, now = Date.now()): AnchorReview {
  const problems: string[] = []; let memo: string | null = null, feePayer: string | null = null, signers: string[] = [];
  try {
    const tx = Transaction.from(fromB64(p.transaction));
    feePayer = tx.feePayer?.toBase58() ?? null;
    const msg = tx.compileMessage();
    signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
    if (tx.instructions.length !== 1) problems.push(`expected exactly one instruction, found ${tx.instructions.length}`);
    const ix = tx.instructions[0];
    if (ix && ix.programId.toBase58() !== MEMO_PROGRAM) problems.push("the instruction is not the SPL Memo program");
    if (ix) memo = new TextDecoder().decode(ix.data);
    if (memo !== receiptMemo(expect.manifestHash)) problems.push("the Memo text does not commit this receipt's hash");
    if (feePayer !== expect.wallet) problems.push("the fee payer is not the receipt issuer wallet");
    if (signers.length !== 1 || signers[0] !== expect.wallet) problems.push("the transaction asks for signers other than the issuer wallet");
  } catch { problems.push("the prepared transaction bytes could not be decoded"); }
  if (p.wallet !== expect.wallet) problems.push("the preparation names a different wallet");
  if (p.memo !== receiptMemo(expect.manifestHash)) problems.push("the preparation's Memo field differs");
  if (p.cluster !== expect.cluster) problems.push(`the server is on ${p.cluster}, the receipt on ${expect.cluster}`);
  if (!p.genesisHash || p.genesisHash !== expect.genesisHash) problems.push("the server's network genesis was not confirmed to match the receipt");
  const exp = Date.parse(p.expiresAt);
  if (!Number.isFinite(exp) || exp <= now) problems.push("the preparation has expired — prepare a new one");
  if (!p.cost) problems.push("fee simulation was not available");
  else if (!p.cost.ok) problems.push(`fee simulation failed: ${p.cost.error ?? "unknown"}`);
  else {
    const lam = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    const { balanceLamports: b, simulatedChangeLamports: c, networkFeeLamports: f } = p.cost;
    if (!lam(b)) problems.push("the wallet balance is unavailable");
    if (!lam(c)) problems.push("the simulated balance change is unavailable");
    if (!lam(f)) problems.push("the network fee is unavailable");
    if (lam(b) && lam(c) && lam(f) && b! < Math.max(c!, f!)) problems.push(`the wallet balance (${b} lamports) does not cover the cost (${Math.max(c!, f!)} lamports)`);
  }
  return { ok: problems.length === 0, problems, memo, feePayer, signers };
}
