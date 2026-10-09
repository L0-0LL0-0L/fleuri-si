// Pure chain helpers shared by server and tests (no RPC).
import { Transaction } from "@solana/web3.js";
import { fromB64, sha256Hex } from "./canonical";

export type Lifecycle = "curve_active" | "curve_completed" | "migration_pending" | "damm_v2_live";

/** DBC MigrationProgress: 0 PreBondingCurve, 1 PostBondingCurve, 2 LockedVesting, 3 CreatedPool. */
export function mapLifecycle(p: { isMigrated: number; migrationProgress: number; quoteReserve: bigint; migrationQuoteThreshold: bigint; dammV2Confirmed?: boolean }): Lifecycle {
  if (p.isMigrated === 1) return p.dammV2Confirmed ? "damm_v2_live" : "migration_pending";
  if (p.migrationProgress >= 2) return "migration_pending";
  if (p.migrationProgress === 1 || (p.migrationQuoteThreshold > 0n && p.quoteReserve >= p.migrationQuoteThreshold)) return "curve_completed";
  return "curve_active";
}

export const messageHash = (message: Uint8Array) => sha256Hex(message);

/** Vesting escrow is a separate confirmed wallet transaction before DAMM v2 creation. */
export function needsMigrationLocker(config: { lockedVestingConfig?: { amountPerPeriod: { toString(): string }; numberOfPeriod: { toString(): string }; cliffUnlockAmount: { toString(): string } } }, progress: number) {
  const v = config.lockedVestingConfig;
  return progress < 2 && !!v && BigInt(v.cliffUnlockAmount.toString()) + BigInt(v.amountPerPeriod.toString()) * BigInt(v.numberOfPeriod.toString()) > 0n;
}

/**
 * Accept only the exact prepared message with every required signature present and valid.
 * Returns the raw signed transaction bytes to broadcast.
 */
export function checkSubmission(prepared: { messageHash: string; messageB64: string }, signedTxB64: string): Uint8Array {
  if (signedTxB64.length > 4000) throw new Error("Transaction too large.");
  let tx: Transaction;
  try {
    tx = Transaction.from(fromB64(signedTxB64));
  } catch {
    throw new Error("Could not decode the signed transaction.");
  }
  const msg = tx.serializeMessage();
  const expected = fromB64(prepared.messageB64);
  if (messageHash(msg) !== prepared.messageHash || msg.length !== expected.length || !msg.every((b, i) => b === expected[i])) {
    throw new Error("The signed transaction differs from the prepared one. Nothing was sent.");
  }
  if (!tx.verifySignatures(true)) throw new Error("A required signature is missing or invalid.");
  return tx.serialize();
}
