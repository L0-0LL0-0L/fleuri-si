// Owner-scoped browser state for research receipts. Stores only request ids and PUBLIC signature
// bytes (so a lost submit can be resent unchanged) — never a key, never another owner's data.
import { z } from "zod";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const Pending = z.object({
  requestId: z.string().uuid(), runId: z.string().uuid(), identityId: z.string().uuid(),
  receiptId: z.string().uuid().optional(), manifestHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  publicKey: z.string().max(4096).optional(), signature: z.string().max(6000).optional(),
}).strict();
export type ReceiptPending = z.infer<typeof Pending>;
export const receiptPendingKey = (owner: string, runId: string) => `fleuri.receipt.pending.v1:${owner}:${runId}`;
export function readReceiptPending(owner: string | null, runId: string, s: Store): ReceiptPending | null {
  if (!owner) return null;
  try { const r = Pending.safeParse(JSON.parse(s.getItem(receiptPendingKey(owner, runId)) ?? "null")); return r.success && r.data.runId === runId ? r.data : null; } catch { return null; }
}
export function writeReceiptPending(owner: string, p: ReceiptPending, s: Store) { s.setItem(receiptPendingKey(owner, p.runId), JSON.stringify(Pending.parse(p))); }
export function clearReceiptPending(owner: string | null, runId: string, s: Store) { if (owner) s.removeItem(receiptPendingKey(owner, runId)); }

/** Exact signed bytes per draft (owner + receipt id), so a resumed draft resends the SAME signature. */
const Sig = z.object({ receiptId: z.string().uuid(), manifestHash: z.string().regex(/^[0-9a-f]{64}$/), publicKey: z.string().max(4096), signature: z.string().max(6000) }).strict();
export type ReceiptSig = z.infer<typeof Sig>;
export const receiptSigKey = (owner: string, receiptId: string) => `fleuri.receipt.sig.v1:${owner}:${receiptId}`;
export function readReceiptSig(owner: string | null, receiptId: string, manifestHash: string, s: Store): ReceiptSig | null {
  if (!owner) return null;
  try { const r = Sig.safeParse(JSON.parse(s.getItem(receiptSigKey(owner, receiptId)) ?? "null")); return r.success && r.data.receiptId === receiptId && r.data.manifestHash === manifestHash ? r.data : null; } catch { return null; }
}
export function writeReceiptSig(owner: string, v: ReceiptSig, s: Store) { s.setItem(receiptSigKey(owner, v.receiptId), JSON.stringify(Sig.parse(v))); }
export function clearReceiptSig(owner: string | null, receiptId: string, s: Store) { if (owner) s.removeItem(receiptSigKey(owner, receiptId)); }
