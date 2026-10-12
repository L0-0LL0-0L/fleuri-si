// Public, read-only Pollen Observatory server functions. No auth: they only read public chain data
// and public vault metadata, and return no RPC URLs, workspace ids or preparation payloads.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const sig = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safe = async (fn: () => Promise<any>): Promise<{ ok: true; data: any } | { ok: false; error: string }> => {
  try { return { ok: true, data: await fn() }; } catch (e) { console.error("[observatory]", (e as Error).message); return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "Unexpected error" }; }
};

export const obsSnapshot = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ vault: addr }).strict().parse(d))
  .handler(async ({ data }) => safe(async () => (await import("./observatory.server")).snapshot(data.vault)));

export const obsHistory = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({
    vault: addr,
    streams: z.array(z.enum(["vault", "tokenVault"])).min(1).max(2),
    cursors: z.object({ vault: sig.nullable().optional(), tokenVault: sig.nullable().optional() }).strict(),
  }).strict().parse(d))
  .handler(async ({ data }) => safe(async () => (await import("./observatory.server")).historyPage(data)));

export const obsKnown = createServerFn({ method: "GET" }).handler(async () => safe(async () => (await import("./observatory.server")).knownVaults()));
