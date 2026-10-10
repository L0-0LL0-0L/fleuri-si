// Botanist field report: x402 V2 "exact" SVM payment rules, enforced locally before and after
// facilitator settlement. Pure and testable; no network.
import { PublicKey, TransactionInstruction, VersionedTransaction, type VersionedMessage } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// Minimal SPL helpers so the browser bundle avoids @solana/spl-token (global Buffer at import).
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const getAssociatedTokenAddressSync = (mint: PublicKey, owner: PublicKey, _allowOffCurve = true) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
export function createTransferCheckedInstruction(source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number) {
  const data = new Uint8Array(10); data[0] = 12; new DataView(data.buffer).setBigUint64(1, amount, true); data[9] = decimals;
  return new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data: data as any });
}
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

export type ExactCheck = { payer: string; paymentHash: string; destIndex: number; authorityIndex: number };

/**
 * Enforces the exact SVM layout on a message (legacy or v0, no lookup tables): compute limit + price
 * (capped), one TransferChecked of the exact amount of the exact mint into the payTo ATA, optional
 * Lighthouse assertions, and exactly one job memo. The fee payer may not move funds.
 */
export function checkExactMessage(msg: VersionedMessage, req: Requirement): ExactCheck {
  if (msg.addressTableLookups?.length) throw new Error("Address lookup tables are not accepted for payments.");
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== req.extra.feePayer) throw new Error("Fee payer is not the facilitator named in the quote.");
  let limit = -1, price = -1n, transfer: { accounts: number[]; data: Uint8Array } | null = null, memo: string | null = null;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const data = ix.data;
    if (prog === COMPUTE && data[0] === 2 && data.length === 5 && limit < 0) limit = new DataView(data.buffer, data.byteOffset).getUint32(1, true);
    else if (prog === COMPUTE && data[0] === 3 && data.length === 9 && price < 0n) price = new DataView(data.buffer, data.byteOffset).getBigUint64(1, true);
    else if (prog === TOKEN_PROGRAM_ID.toBase58() && data[0] === 12 && data.length === 10 && !transfer && ix.accountKeyIndexes.length === 4) transfer = { accounts: [...ix.accountKeyIndexes], data };
    else if (prog === MEMO && memo === null) memo = new TextDecoder("utf-8", { fatal: true }).decode(data);
    else if (prog === LIGHTHOUSE) continue;
    else throw new Error("Payment contains an unexpected instruction.");
  }
  if (limit < 0 || price < 0n) throw new Error("Compute budget instructions are missing.");
  if (limit > MAX_CU_LIMIT || price > MAX_CU_PRICE) throw new Error("Compute budget exceeds the fee cap.");
  if (!transfer) throw new Error("No TransferChecked instruction.");
  const [si, mi, di, ai] = transfer.accounts; const [source, mint, dest, authority] = [si, mi, di, ai].map((i) => keys[i]);
  const amount = new DataView(transfer.data.buffer, transfer.data.byteOffset).getBigUint64(1, true);
  if (mint !== req.asset) throw new Error("Wrong payment token.");
  if (transfer.data[9] !== USDC_DECIMALS) throw new Error("Wrong token decimals.");
  if (amount !== BigInt(req.amount)) throw new Error("Wrong payment amount.");
  const ata = getAssociatedTokenAddressSync(new PublicKey(req.asset), new PublicKey(req.payTo), true).toBase58();
  if (dest !== ata) throw new Error("Payment does not go to the service recipient's USDC account.");
  if ([source, mint, dest, authority].includes(req.extra.feePayer)) throw new Error("Facilitator fee payer may not move funds.");
  if (ai >= msg.header.numRequiredSignatures) throw new Error("Transfer authority is not a signer.");
  if (memo !== req.extra.memo) throw new Error("Payment is not bound to this job (memo mismatch).");
  return { payer: authority, paymentHash: sha256Hex(new Uint8Array(msg.serialize())), destIndex: di, authorityIndex: ai };
}

/** Layout check + Ed25519 verification of every required signer except the facilitator's slot 0. */
export function verifyExactTransaction(txB64: string, req: Requirement): ExactCheck {
  if (txB64.length > 2400) throw new Error("Payment transaction too large.");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(fromB64(txB64)); } catch { throw new Error("Payment transaction could not be decoded."); }
  const r = checkExactMessage(tx.message, req);
  const bytes = new Uint8Array(tx.message.serialize()); const keys = tx.message.staticAccountKeys;
  for (let i = 1; i < tx.message.header.numRequiredSignatures; i++) {
    const s = tx.signatures[i];
    if (!s || s.every((b) => b === 0)) throw new Error("Payer signature missing.");
    let ok = false; try { ok = ed25519.verify(s, bytes, keys[i].toBytes()); } catch { ok = false; }
    if (!ok) throw new Error(`Signature ${i} does not verify over the payment message.`);
  }
  return r;
}

/**
 * Confirms a settled transaction delivered THIS accepted payment: its message hash must equal the
 * durable payment hash, it must still pass the exact layout, and the canonical destination ATA (by
 * account index in that message) must gain exactly `amount`.
 */
export function settledCredit(tx: { meta: { err: unknown; preTokenBalances?: any[] | null; postTokenBalances?: any[] | null } | null; transaction: { message: VersionedMessage } }, req: Requirement, acceptedHash: string) {
  const meta = tx.meta;
  if (!meta) return { ok: false as const, terminal: false, reason: "Transaction metadata unavailable." };
  let c: ExactCheck;
  try { c = checkExactMessage(tx.transaction.message, req); } catch (e) { return { ok: false as const, terminal: true, reason: `Settled transaction is not this payment: ${(e as Error).message}` }; }
  if (c.paymentHash !== acceptedHash) return { ok: false as const, terminal: true, reason: "Settled transaction message differs from the accepted payment." };
  if (meta.err) return { ok: false as const, terminal: true, reason: `Settlement failed on chain: ${JSON.stringify(meta.err)}` };
  const bal = (arr: any[] | null | undefined) => { const b = arr?.find((x) => x.accountIndex === c.destIndex); return b && b.mint === req.asset && b.owner === req.payTo ? BigInt(b.uiTokenAmount?.amount ?? "0") : 0n; };
  const delta = bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
  return delta === BigInt(req.amount) ? { ok: true as const, payer: c.payer } : { ok: false as const, terminal: true, reason: `Recipient credit ${delta} differs from ${req.amount}.` };
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

/** Exact JSON-safe form: BigInt/BN → decimal string, PublicKey → base58, undefined → null. */
export function jsonSafe(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") { if (!Number.isFinite(v)) return null; return v; }
  if (typeof v !== "object") return v;
  if (typeof v.toBase58 === "function") return v.toBase58();
  if (typeof v.toArrayLike === "function" && typeof v.toString === "function") return v.toString(10);
  if (Array.isArray(v)) return v.map(jsonSafe);
  const o: Record<string, any> = {}; for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x); return o;
}
