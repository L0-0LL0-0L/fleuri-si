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
