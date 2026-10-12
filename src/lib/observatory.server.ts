// Server-only Pollen Observatory reads: one confirmed vault snapshot plus bounded, paginated history
// for the vault and its token vault. Read-only; no signing, no database writes. Client-facing errors
// are fixed safe categories: raw upstream messages and RPC URLs never leave this module.
import { DFS_PROGRAM_ID } from "@/pq/pollen";
import { decodeTx, type ObservedTx, type RawTx, type Stream, type StreamCoverage } from "@/pq/observatory";
import * as sol from "./solana.server";
import { readVault } from "./pollen.server";

export const PAGE = 15; // signatures per address per page: at most 2×15 transaction reads per call
const CONCURRENCY = 4;

/** An error whose message is safe to show to anyone. */
export class PublicError extends Error {}
const SAFE_VAULT_ERRORS = ["No account at this address.", "This account is not owned by Meteora Dynamic Fee Sharing."];
export const GENERIC = "The chain read failed. Try again later.";
export function publicMessage(e: unknown): string {
  if (e instanceof PublicError) return e.message;
  const m = e instanceof Error ? e.message : "";
  if (SAFE_VAULT_ERRORS.includes(m)) return m;
  if (/fee ?vault|decode|discriminator|Invalid account/i.test(m)) return "This account could not be decoded as a fee-sharing vault.";
  return GENERIC;
}

async function ready() {
  const e = sol.solEnv();
  if (!e.cluster || !e.rpcUrl) throw new PublicError("The Solana network is not configured.");
  const conn = sol.connection();
  let genesisHash: string;
  try { genesisHash = await sol.assertGenesis(conn, e.cluster); } catch { throw new PublicError("The configured network could not be verified right now."); }
  return { conn, cluster: e.cluster, genesisHash, rpcUrl: e.rpcUrl };
}

export type RpcFailure = "rate_limited" | "unsupported_version" | "unavailable";
export class RpcError extends Error { constructor(public kind: RpcFailure) { super(kind); } }
const FAILURE_TEXT: Record<RpcFailure, string> = {
  rate_limited: "Not read: the RPC rate-limited this request. Retry later.",
  unsupported_version: "The RPC reports this transaction version is not supported.",
  unavailable: "Not read: the RPC was unavailable for this request.",
};
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let r: Response;
  try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) }); }
  catch { throw new RpcError("unavailable"); }
  if (r.status === 429) throw new RpcError("rate_limited");
  if (!r.ok) throw new RpcError("unavailable");
  let j: { result?: T; error?: { code: number } };
  try { j = await r.json(); } catch { throw new RpcError("unavailable"); }
  if (j.error) throw new RpcError(j.error.code === 429 || j.error.code === -32429 ? "rate_limited" : j.error.code === -32015 ? "unsupported_version" : "unavailable");
  return j.result as T;
}

export async function snapshot(address: string) {
  const { conn, cluster, genesisHash } = await ready();
  try {
    const vault = await readVault(conn, address);
    return { cluster, genesisHash, slot: vault.accountSlot, observedAt: new Date().toISOString(), program: DFS_PROGRAM_ID, vault };
  } catch (e) { throw new PublicError(publicMessage(e)); }
}

type SigInfo = { signature: string; slot: number; err: unknown; blockTime: number | null };

export async function historyPage(input: { vault: string; cursors: Partial<Record<Stream, string | null>>; streams: Stream[] }) {
  const { conn, cluster, rpcUrl } = await ready();
  let v: Awaited<ReturnType<typeof readVault>>;
  try { v = await readVault(conn, input.vault); } catch (e) { throw new PublicError(publicMessage(e)); } // re-validates ownership/decoding
  const addrs: Record<Stream, string> = { vault: v.address, tokenVault: v.tokenVault };
  const ctx = { vault: v.address, tokenVault: v.tokenVault, recipients: v.recipientSlots, mint: v.mint };
  const coverage: Partial<Record<Stream, StreamCoverage>> = {};
  const sigs = new Map<string, { info: SigInfo; via: Stream[] }>();
  for (const s of [...new Set(input.streams)]) {
    const before = input.cursors[s] ?? undefined;
    try {
      const list = await rpc<SigInfo[]>(rpcUrl, "getSignaturesForAddress", [addrs[s], { limit: PAGE, before, commitment: "confirmed" }]);
      if (!Array.isArray(list)) throw new RpcError("unavailable");
      for (const i of list) { const o = sigs.get(i.signature); if (o) o.via.push(s); else sigs.set(i.signature, { info: i, via: [s] }); }
      const last = list[list.length - 1];
      coverage[s] = { address: addrs[s], oldestSignature: last?.signature ?? before ?? null, oldestSlot: last?.slot ?? null, pages: 1, exhausted: list.length < PAGE, error: null };
    } catch (e) {
      coverage[s] = { address: addrs[s], oldestSignature: before ?? null, oldestSlot: null, pages: 0, exhausted: false, error: FAILURE_TEXT[e instanceof RpcError ? e.kind : "unavailable"] };
    }
  }
  const items = [...sigs.values()];
  const out: ObservedTx[] = [];
  let stop: string | null = null;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.all(chunk.map(async ({ info, via }): Promise<ObservedTx> => {
      const base = { signature: info.signature, slot: info.slot ?? null, blockTime: info.blockTime ?? null, via: via.sort() as ObservedTx["via"], entries: [], otherVaultEvents: 0 };
      if (info.err != null) return { ...base, status: "failed", reason: "Failed on chain; nothing moved." };
      if (stop) return { ...base, status: "unavailable", reason: stop };
      try {
        const tx = await rpc<RawTx | null>(rpcUrl, "getTransaction", [info.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
        const d = decodeTx(info.signature, tx, ctx, base.via);
        return { ...d, slot: d.slot ?? base.slot, blockTime: d.blockTime ?? base.blockTime };
      } catch (e) {
        const kind: RpcFailure = e instanceof RpcError ? e.kind : "unavailable";
        if (kind === "rate_limited") stop = FAILURE_TEXT.rate_limited;
        return { ...base, status: kind === "unsupported_version" ? "unsupported" : "unavailable", reason: FAILURE_TEXT[kind] };
      }
    }))));
  }
  return { cluster, vault: v.address, observedAt: new Date().toISOString(), txs: out, coverage };
}

/** Public metadata only: never recorded_by or workspace/launch associations. Works without the database. */
export async function knownVaults() {
  const cluster = sol.solEnv().cluster ?? null;
  let vaults: { address: string; cluster: string; mint: string }[] = [];
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).from("pollen_vaults").select("address,cluster,mint").order("created_at", { ascending: false }).limit(25);
    if (!error) vaults = data ?? [];
  } catch { /* the list is optional; lookup still works */ }
  return { cluster, vaults };
}
