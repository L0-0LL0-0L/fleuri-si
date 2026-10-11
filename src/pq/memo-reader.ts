// Browser-safe Solana reader for Memo anchors: plain JSON-RPC over fetch with timeouts. No web3.js /
// spl-token imports (AGENTS.md forbids spl-token in browser code). Used by the receipt UI and CLI.
import type { AnchorReader } from "./receipt";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch); if (carry < 0) throw new Error("invalid base58");
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== "1") break; bytes.push(0); }
  const out = bytes.reverse();
  while (out.length > 1 && out[0] === 0 && s[0] !== "1") out.shift();
  return new Uint8Array(s.length === 0 ? [] : out);
}

export function checkRpcUrl(url: string) {
  let u: URL; try { u = new URL(url); } catch { throw new Error("RPC must be a valid https URL."); }
  if (u.protocol !== "https:") throw new Error("RPC must use https.");
  return u.toString();
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export function memoReader(rpcUrl: string, opts: { timeoutMs?: number; fetch?: Fetch; signal?: AbortSignal } = {}): AnchorReader {
  const url = checkRpcUrl(rpcUrl);
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  async function call(method: string, params: unknown[]) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    const onAbort = () => ctrl.abort(); opts.signal?.addEventListener("abort", onAbort);
    try {
      const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const j = await r.json();
      if (j?.error) throw new Error(`RPC error: ${String(j.error.message ?? j.error).slice(0, 120)}`);
      return j?.result;
    } catch (e) { if (ctrl.signal.aborted) throw new Error("RPC timed out or was cancelled."); throw e; }
    finally { clearTimeout(t); opts.signal?.removeEventListener("abort", onAbort); }
  }
  return {
    async genesis() { const g = await call("getGenesisHash", []); if (typeof g !== "string") throw new Error("RPC returned no genesis hash."); return g; },
    async tx(sig) {
      const r = await call("getTransaction", [sig, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }]);
      if (r == null) return { status: "missing" as const };
      const msg = r?.transaction?.message; const keys = msg?.accountKeys; const n = msg?.header?.numRequiredSignatures;
      if (!Array.isArray(keys) || !keys.every((k: unknown) => typeof k === "string") || !Number.isInteger(n) || !Array.isArray(msg?.instructions) || typeof r.slot !== "number")
        return { status: "unsupported" as const, reason: "The RPC returned a transaction shape this reader does not understand." };
      const ixs: { program: string; data: Uint8Array }[] = [];
      for (const ix of msg.instructions) {
        if (!Number.isInteger(ix?.programIdIndex) || typeof ix?.data !== "string") return { status: "unsupported" as const, reason: "Unrecognized instruction encoding." };
        if (ix.programIdIndex >= keys.length) return { status: "unsupported" as const, reason: "Instruction program comes from an address lookup table; not supported by this reader." };
        ixs.push({ program: keys[ix.programIdIndex], data: b58decode(ix.data) });
      }
      return { status: "ok" as const, tx: { slot: r.slot, err: r.meta?.err ?? null, signers: keys.slice(0, n), ixs } };
    },
  };
}
