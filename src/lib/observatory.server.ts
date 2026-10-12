// Server-only Pollen Observatory reads: one confirmed vault snapshot plus bounded, paginated history
// for the vault and its token vault. Read-only; no signing, no database writes.
import { PublicKey } from "@solana/web3.js";
import { DFS_PROGRAM_ID } from "@/pq/pollen";
import { decodeTx, type ObservedTx, type RawTx, type Stream, type StreamCoverage } from "@/pq/observatory";
import * as sol from "./solana.server";
import { readVault } from "./pollen.server";

export const PAGE = 15; // signatures per address per page: at most 2×15 transaction reads per call
const CONCURRENCY = 4;

async function ready() {
  const e = sol.solEnv();
  if (!e.cluster || !e.rpcUrl) throw new Error("The Solana network is not configured.");
  const conn = sol.connection();
  const genesisHash = await sol.assertGenesis(conn, e.cluster);
  return { conn, cluster: e.cluster, genesisHash, rpcUrl: e.rpcUrl };
}

class RpcError extends Error { constructor(m: string, public rateLimited = false) { super(m); } }
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  if (r.status === 429) throw new RpcError("The RPC rate-limited this read.", true);
  if (!r.ok) throw new RpcError(`The RPC answered HTTP ${r.status}.`);
  const j = (await r.json()) as { result?: T; error?: { code: number; message: string } };
  if (j.error) throw new RpcError(`RPC error ${j.error.code}`, j.error.code === 429 || j.error.code === -32429);
  return j.result as T;
}

export async function snapshot(address: string) {
  const { conn, cluster, genesisHash } = await ready();
  const [slot, vault] = await Promise.all([conn.getSlot("confirmed"), readVault(conn, address)]);
  return { cluster, genesisHash, slot, observedAt: new Date().toISOString(), program: DFS_PROGRAM_ID, vault };
}

type SigInfo = { signature: string; slot: number; err: unknown; blockTime: number | null };

export async function historyPage(input: { vault: string; cursors: Partial<Record<Stream, string | null>>; streams: Stream[] }) {
  const { conn, cluster, rpcUrl } = await ready();
  const v = await readVault(conn, input.vault); // re-validates ownership/decoding and gives the token vault
  const addrs: Record<Stream, string> = { vault: v.address, tokenVault: v.tokenVault };
  const ctx = { vault: v.address, tokenVault: v.tokenVault, recipients: v.recipientSlots };
  const coverage: Partial<Record<Stream, StreamCoverage>> = {};
  const sigs = new Map<string, { info: SigInfo; via: Stream[] }>();
  for (const s of input.streams) {
    new PublicKey(addrs[s]);
    const before = input.cursors[s] ?? undefined;
    try {
      const list = await rpc<SigInfo[]>(rpcUrl, "getSignaturesForAddress", [addrs[s], { limit: PAGE, before, commitment: "confirmed" }]);
      for (const i of list) { const o = sigs.get(i.signature); if (o) o.via.push(s); else sigs.set(i.signature, { info: i, via: [s] }); }
      const last = list[list.length - 1];
      coverage[s] = { address: addrs[s], oldestSignature: last?.signature ?? before ?? null, oldestSlot: last?.slot ?? null, pages: 1, exhausted: list.length < PAGE, error: null };
    } catch (e) {
      coverage[s] = { address: addrs[s], oldestSignature: before ?? null, oldestSlot: null, pages: 0, exhausted: false, error: (e as Error).message };
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
        if (e instanceof RpcError && e.rateLimited) stop = "Not read: the RPC rate-limited this page. Retry later.";
        return { ...base, status: "unavailable", reason: (e as Error).message.slice(0, 160) };
      }
    }))));
  }
  return { cluster, observedAt: new Date().toISOString(), txs: out, coverage };
}

/** Public metadata only: never recorded_by or workspace/launch associations. */
export async function knownVaults() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any).from("pollen_vaults").select("address,cluster,mint").order("created_at", { ascending: false }).limit(25);
  if (error) throw new Error("Known vaults are unavailable.");
  return (data ?? []) as { address: string; cluster: string; mint: string }[];
}
