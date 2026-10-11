// Owner-scoped browser state for Greenhouse: pending-request storage and async fencing.
import { z } from "zod";
import { ConfigSchema, type TrialConfig } from "@/domain/greenhouse";

export type Pending = { requestId: string; config: TrialConfig };
const PendingSchema = z.object({ requestId: z.string().uuid(), config: ConfigSchema }).strict();
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One key per workspace owner: a pending request can never surface in another workspace. */
export const pendingKey = (owner: string) => `fleuri.greenhouse.pending.v2:${owner}`;
export function readPending(owner: string | null, store: Store): Pending | null {
  if (!owner) return null;
  try { const r = PendingSchema.safeParse(JSON.parse(store.getItem(pendingKey(owner)) ?? "null")); return r.success ? r.data : null; } catch { return null; }
}
export function writePending(owner: string, p: Pending, store: Store) { store.setItem(pendingKey(owner), JSON.stringify(PendingSchema.parse(p))); }
export function clearPending(owner: string | null, store: Store) { if (owner) store.removeItem(pendingKey(owner)); store.removeItem("fleuri.greenhouse.pending.v1"); }

/** Generation fence: results from an older generation (previous owner/run) are dropped. */
export function createFence() {
  let gen = 0;
  return { bump: () => ++gen, current: () => gen, guard: (g: number) => g === gen };
}
