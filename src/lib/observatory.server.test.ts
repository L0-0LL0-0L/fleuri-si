// @vitest-environment node
// historyPage against fixture RPC replies: paging cursor, failed and rate-limited transactions,
// and sanitized errors (no raw upstream text or RPC URL reaches the caller).
import { afterEach, describe, expect, it, vi } from "vitest";

const RPC = "https://secret-rpc.example/key=abc";
vi.mock("./solana.server", () => ({ solEnv: () => ({ cluster: "mainnet-beta", rpcUrl: RPC }), connection: () => ({}), assertGenesis: async () => "genesis" }));
vi.mock("./pollen.server", () => ({ readVault: vi.fn(async (_c: unknown, a: string) => ({ address: a, tokenVault: "TV", mint: "M", recipientSlots: [], accountSlot: 42 })) }));

import { historyPage, publicMessage, snapshot, PAGE } from "./observatory.server";
import { historyInput } from "./observatory.functions";
import { readVault } from "./pollen.server";

const okTx = { slot: 1, blockTime: 1, version: 0, transaction: { message: { accountKeys: ["X"], instructions: [] } }, meta: { err: null, innerInstructions: [] } };
afterEach(() => vi.unstubAllGlobals());

function stubRpc(handler: (method: string, params: any[]) => { status?: number; body?: unknown }) {
  const calls: { method: string; params: any[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const { method, params } = JSON.parse(init.body); calls.push({ method, params });
    const r = handler(method, params);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }));
  return calls;
}

describe("historyPage", () => {
  it("pages with the cursor, keeps failed txs out of decoding, and turns a rate limit into marked gaps", async () => {
    const sigs = Array.from({ length: PAGE }, (_, i) => ({ signature: `s${i}`, slot: 100 - i, err: i === 0 ? { x: 1 } : null, blockTime: 1 }));
    let txCalls = 0;
    const calls = stubRpc((m) => {
      if (m === "getSignaturesForAddress") return { body: { result: sigs } };
      txCalls++;
      return txCalls === 2 ? { status: 429 } : { body: { result: okTx } };
    });
    const r = await historyPage({ vault: "V", streams: ["vault"], cursors: { vault: "cursor-sig" } });
    expect(calls[0].params[1]).toMatchObject({ before: "cursor-sig", limit: PAGE });
    expect(r).toMatchObject({ cluster: "mainnet-beta", vault: "V" });
    expect(r.coverage.vault).toMatchObject({ oldestSignature: `s${PAGE - 1}`, exhausted: false, error: null });
    expect(r.txs.find((t) => t.signature === "s0")?.status).toBe("failed");
    const gaps = r.txs.filter((t) => t.status === "unavailable");
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((t) => /rate-limited/.test(t.reason ?? ""))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("secret-rpc");
  });

  it("marks unsupported-version RPC errors distinctly and sanitizes a failed signature list", async () => {
    stubRpc((m) => (m === "getSignaturesForAddress" ? { body: { result: [{ signature: "s", slot: 1, err: null, blockTime: 1 }] } } : { body: { error: { code: -32015, message: `Transaction version (1) is not supported at ${RPC}` } } }));
    const r = await historyPage({ vault: "V", streams: ["vault"], cursors: {} });
    expect(r.txs[0].status).toBe("unsupported");
    expect(r.coverage.vault?.exhausted).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`connect ECONNREFUSED ${RPC}`); }));
    const r2 = await historyPage({ vault: "V", streams: ["vault", "tokenVault"], cursors: {} });
    expect(r2.coverage.vault?.error).toBe("Not read: the RPC was unavailable for this request.");
    expect(JSON.stringify(r2)).not.toContain("secret-rpc");
  });

  it("reports the account-context slot and only safe error text", async () => {
    expect((await snapshot("V")).slot).toBe(42);
    vi.mocked(readVault).mockRejectedValueOnce(new Error(`fetch failed ${RPC}`));
    await expect(snapshot("V")).rejects.toThrow("The chain read failed. Try again later.");
    vi.mocked(readVault).mockRejectedValueOnce(new Error("This account is not owned by Meteora Dynamic Fee Sharing."));
    await expect(snapshot("V")).rejects.toThrow("not owned by Meteora");
    expect(publicMessage(new Error(`429 at ${RPC}`))).not.toContain("secret");
  });
});

describe("historyInput", () => {
  const vault = "DwyTJxxgyA8KF2MS8Jnmw4PymX2NjvBjnnQjLjj1tG5r";
  it("checks decoded byte lengths and unique streams", () => {
    expect(historyInput.safeParse({ vault, streams: ["vault"], cursors: {} }).success).toBe(true);
    expect(historyInput.safeParse({ vault: "1".repeat(40), streams: ["vault"], cursors: {} }).success).toBe(false);
    expect(historyInput.safeParse({ vault, streams: ["vault", "vault"], cursors: {} }).success).toBe(false);
    expect(historyInput.safeParse({ vault, streams: ["vault"], cursors: { vault: "z".repeat(70) } }).success).toBe(false);
  });
});
