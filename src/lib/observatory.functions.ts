// Public, read-only Pollen Observatory server functions. No auth: they only read public chain data
// and public vault metadata, and return no RPC URLs, workspace ids or raw upstream errors.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { b58decode } from "@/pq/memo-reader";

const bytesLen = (n: number) => (s: string) => { try { return b58decode(s).length === n; } catch { return false; } };
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const addr = z.string().min(32).max(44).regex(B58).refine(bytesLen(32), "Not a 32-byte address.");
export const sig = z.string().min(64).max(90).regex(B58).refine(bytesLen(64), "Not a 64-byte signature.");
export const historyInput = z.object({
  vault: addr,
  streams: z.array(z.enum(["vault", "tokenVault"])).min(1).max(2).refine((s) => new Set(s).size === s.length, "Streams must be unique."),
  cursors: z.object({ vault: sig.nullable().optional(), tokenVault: sig.nullable().optional() }).strict(),
}).strict();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safe = async (fn: () => Promise<any>): Promise<{ ok: true; data: any } | { ok: false; error: string }> => {
  try { return { ok: true, data: await fn() }; }
  catch (e) {
    const { publicMessage } = await import("./observatory.server");
    const msg = publicMessage(e);
    console.error("[observatory]", msg);
    return { ok: false, error: msg };
  }
};

export const obsSnapshot = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ vault: addr }).strict().parse(d))
  .handler(async ({ data }) => safe(async () => (await import("./observatory.server")).snapshot(data.vault)));

export const obsHistory = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => historyInput.parse(d))
  .handler(async ({ data }) => safe(async () => (await import("./observatory.server")).historyPage(data)));

export const obsKnown = createServerFn({ method: "GET" }).handler(async () => safe(async () => (await import("./observatory.server")).knownVaults()));
