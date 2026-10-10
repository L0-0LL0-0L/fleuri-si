// Botanist field report: x402 V2 "exact" SVM payment rules, enforced locally before and after
// facilitator settlement. Pure and testable; no network.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { canonicalize, fromB64, sha256Hex, utf8 } from "./canonical";
import { USDC_MINT } from "./pollen";

export const X402_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // CAIP-2 Solana mainnet
export const BOTANIST_ASSET = USDC_MINT; // Circle USDC, 6 decimals, SPL Token (verified at readiness)
export const USDC_DECIMALS = 6;
export const DEFAULT_PRICE = 500_000n; // 0.50 USDC
export const QUOTE_TTL_S = 600;
export const MAX_CU_LIMIT = 400_000;
export const MAX_CU_PRICE = 5_000_000n; // micro-lamports per CU (≤ 5 lamports/CU)
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

export type Requirement = { scheme: "exact"; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra: { feePayer: string; memo: string } };

export const requestHash = (jobId: string, mint: string, amount: string, payTo: string, memo: string, resource: string) => sha256Hex(utf8(canonicalize({ v: "fleuri.botanist.request/v1", jobId, mint, amount, payTo, memo, resource, network: X402_NETWORK, asset: BOTANIST_ASSET })));
export const jobMemo = (jobId: string, nonce: string) => `fleuri-botanist:${sha256Hex(utf8(`${jobId}:${nonce}`)).slice(0, 32)}`;

export function sameRequirement(a: Requirement, b: any) {
  return !!b && b.scheme === a.scheme && b.network === a.network && b.asset === a.asset && String(b.amount) === a.amount && b.payTo === a.payTo && b.extra?.feePayer === a.extra.feePayer && b.extra?.memo === a.extra.memo;
}

/**
 * Enforces the exact SVM layout: compute limit + price (capped), one TransferChecked of the exact
 * amount of the exact mint into the payTo ATA, optional Lighthouse assertions, and the job memo.
 * The facilitator's fee payer may not be the token authority or appear in the transfer.
 */
export function verifyExactTransaction(txB64: string, req: Requirement): { payer: string; paymentHash: string } {
  if (txB64.length > 2400) throw new Error("Payment transaction too large.");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(fromB64(txB64)); } catch { throw new Error("Payment transaction could not be decoded."); }
  const msg = tx.message;
  if (msg.addressTableLookups?.length) throw new Error("Address lookup tables are not accepted for payments.");
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== req.extra.feePayer) throw new Error("Fee payer is not the facilitator named in the quote.");
  let limit = -1, price = -1n, transfer: { accounts: string[]; data: Uint8Array } | null = null, memo: string | null = null;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const data = ix.data; const accounts = ix.accountKeyIndexes.map((i) => keys[i]);
    if (prog === COMPUTE && data[0] === 2 && data.length === 5 && limit < 0) limit = new DataView(data.buffer, data.byteOffset).getUint32(1, true);
    else if (prog === COMPUTE && data[0] === 3 && data.length === 9 && price < 0n) price = new DataView(data.buffer, data.byteOffset).getBigUint64(1, true);
    else if (prog === TOKEN_PROGRAM_ID.toBase58() && data[0] === 12 && data.length === 10 && !transfer) transfer = { accounts, data };
    else if (prog === MEMO && memo === null) memo = new TextDecoder().decode(data);
    else if (prog === LIGHTHOUSE) continue;
    else throw new Error("Payment contains an unexpected instruction.");
  }
  if (limit < 0 || price < 0n) throw new Error("Compute budget instructions are missing.");
  if (limit > MAX_CU_LIMIT || price > MAX_CU_PRICE) throw new Error("Compute budget exceeds the fee cap.");
  if (!transfer) throw new Error("No TransferChecked instruction.");
  const [source, mint, dest, authority] = transfer.accounts;
  const amount = new DataView(transfer.data.buffer, transfer.data.byteOffset).getBigUint64(1, true);
  if (mint !== req.asset) throw new Error("Wrong payment token.");
  if (transfer.data[9] !== USDC_DECIMALS) throw new Error("Wrong token decimals.");
  if (amount !== BigInt(req.amount)) throw new Error("Wrong payment amount.");
  const ata = getAssociatedTokenAddressSync(new PublicKey(req.asset), new PublicKey(req.payTo), true).toBase58();
  if (dest !== ata) throw new Error("Payment does not go to the service recipient's USDC account.");
  if (authority === req.extra.feePayer || source === req.extra.feePayer || transfer.accounts.includes(req.extra.feePayer)) throw new Error("Facilitator fee payer may not move funds.");
  const signerCount = msg.header.numRequiredSignatures;
  const ai = keys.indexOf(authority);
  if (ai < 0 || ai >= signerCount) throw new Error("Transfer authority is not a signer.");
  if (memo !== req.extra.memo) throw new Error("Payment is not bound to this job (memo mismatch).");
  // Authority must have signed already; fee payer slot is completed by the facilitator.
  if (tx.signatures[ai].every((b) => b === 0)) throw new Error("Payer signature missing.");
  return { payer: authority, paymentHash: sha256Hex(new Uint8Array(msg.serialize())) };
}

/** Confirms the settled transaction credited exactly `amount` of `asset` to the payTo ATA. */
export function settledCredit(meta: { err: unknown; preTokenBalances?: any[] | null; postTokenBalances?: any[] | null }, req: Requirement) {
  if (meta.err) return { ok: false as const, reason: `Settlement failed on chain: ${JSON.stringify(meta.err)}` };
  const bal = (arr: any[] | null | undefined) => BigInt(arr?.find((b) => b.mint === req.asset && b.owner === req.payTo)?.uiTokenAmount?.amount ?? "0");
  const delta = bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
  return delta === BigInt(req.amount) ? { ok: true as const } : { ok: false as const, reason: `Recipient credit ${delta} differs from ${req.amount}.` };
}

export function receipt(job: { id: string; request_hash: string; network: string; asset: string; amount: string | number; pay_to: string; payer: string; settle_signature: string; settled_slot: number; settled_at: string; mint: string }, report: unknown) {
  const outputDigest = sha256Hex(utf8(canonicalize(report as any)));
  return {
    format: "fleuri.botanist.receipt/v1",
    job: job.id, requestHash: job.request_hash, inspectedMint: job.mint,
    payment: { protocol: "x402 v2 exact", network: job.network, asset: job.asset, amount: String(job.amount), payTo: job.pay_to, payer: job.payer, transaction: job.settle_signature, slot: job.settled_slot, settledAt: job.settled_at },
    outputDigest,
    notice: "This receipt evidences payment and which report fleuri delivered (by digest). It is not a signature from fleuri and does not certify that the token is safe.",
  };
}
