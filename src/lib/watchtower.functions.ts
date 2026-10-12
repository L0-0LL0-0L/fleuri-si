// Public, read-only Graduation Watchtower server functions. No auth; no client-selected RPC;
// only fixed safe error messages are returned.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { addr } from "./observatory.functions";

export const watchInput = z.object({ pool: addr, vault: addr.optional() }).strict();

export const wtWatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => watchInput.parse(d))
  .handler(async ({ data }) => {
    try { return { ok: true as const, data: await (await import("./watchtower.server")).watch(data.pool, data.vault) }; }
    catch (e) {
      const { publicMessage } = await import("./observatory.server");
      const msg = publicMessage(e);
      console.error("[watchtower]", msg);
      return { ok: false as const, error: msg };
    }
  });

export const wtKnown = createServerFn({ method: "GET" }).handler(async () => {
  try { return { ok: true as const, data: await (await import("./watchtower.server")).knownLaunches() }; }
  catch { return { ok: false as const, error: "Recorded launches are unavailable." }; }
});
