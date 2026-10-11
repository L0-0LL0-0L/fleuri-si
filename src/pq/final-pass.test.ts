// @vitest-environment node
// Regressions for the final Research Receipts correctness pass: exact cost gating, strict Memo
// metadata, and the last pre-submit wallet scope check.
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { b64 } from "./canonical";
import { reviewAnchorPrep, type AnchorPrep } from "./anchor-review";
import { GENESIS } from "./registration";
import { MEMO_PROGRAM, receiptMemo } from "./receipt";
import { memoReader } from "./memo-reader";
import { ScopeChangedError, guardedSignSubmit } from "./wallet-flow";
import { estimateWalletCost } from "@/lib/solana.server";

const w = Keypair.generate().publicKey; const H = "a".repeat(64);
const tx = () => { const t = new Transaction().add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [{ pubkey: w, isSigner: true, isWritable: false }], data: Buffer.from(receiptMemo(H)) })); t.feePayer = w; t.recentBlockhash = "11111111111111111111111111111111"; return b64(t.serialize({ requireAllSignatures: false, verifySignatures: false })); };
const prep = (cost: any): AnchorPrep => ({ preparationId: "p", transaction: tx(), memo: receiptMemo(H), wallet: w.toBase58(), cluster: "devnet", genesisHash: GENESIS.devnet, expiresAt: new Date(Date.now() + 60_000).toISOString(), cost });
const ex = { wallet: w.toBase58(), cluster: "devnet", genesisHash: GENESIS.devnet, manifestHash: H };

describe("exact anchor cost gating", () => {
  it("keeps signing disabled when the network fee is missing", () => {
    const r = reviewAnchorPrep(prep({ ok: true, balanceLamports: 100000, simulatedChangeLamports: 5000 }), ex);
    expect(r.ok).toBe(false); expect(r.problems).toContain("the network fee is unavailable");
  });
  it("keeps signing disabled for a NaN simulated change", () => {
    expect(reviewAnchorPrep(prep({ ok: true, balanceLamports: 100000, simulatedChangeLamports: NaN, networkFeeLamports: 5000 }), ex).problems).toContain("the simulated balance change is unavailable");
  });
  it("requires the balance to cover max(simulated change, network fee)", () => {
    const r = reviewAnchorPrep(prep({ ok: true, balanceLamports: 0, simulatedChangeLamports: 0, networkFeeLamports: 5000 }), ex);
    expect(r.ok).toBe(false); expect(r.problems.join()).toMatch(/does not cover the cost \(5000 lamports\)/);
    expect(reviewAnchorPrep(prep({ ok: true, balanceLamports: 5000, simulatedChangeLamports: 0, networkFeeLamports: 5000 }), ex).ok).toBe(true);
  });
});

describe("server cost estimate never invents zero", () => {
  const msg = () => Transaction.from(Buffer.from(tx(), "base64")).serializeMessage();
  const conn = (fee: number | null, accounts: any[] | undefined) => ({ getBalance: async () => 10_000, getFeeForMessage: async () => ({ value: fee }), simulateTransaction: async () => ({ value: { err: null, accounts } }) }) as any;
  it("reports an unavailable network fee instead of 0", async () => {
    expect(await estimateWalletCost(conn(null, [{ lamports: 5000 }]), msg(), w.toBase58())).toMatchObject({ ok: false });
  });
  it("reports a missing post-balance instead of zero cost", async () => {
    expect(await estimateWalletCost(conn(5000, []), msg(), w.toBase58())).toMatchObject({ ok: false });
  });
  it("returns exact amounts when everything is known", async () => {
    expect(await estimateWalletCost(conn(5000, [{ lamports: 5000 }]), msg(), w.toBase58())).toEqual({ ok: true, balanceLamports: 10_000, simulatedChangeLamports: 5000, networkFeeLamports: 5000 });
  });
});

describe("Memo reader requires usable status metadata", () => {
  const memoB58 = "3yZe7d"; // arbitrary memo bytes; status handling is what is under test
  const result = (over: any) => ({ slot: 5, version: "legacy", meta: { err: null }, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [w.toBase58(), MEMO_PROGRAM], instructions: [{ programIdIndex: 1, data: memoB58 }] } }, ...over });
  const reader = (r: any) => memoReader("https://rpc.example", { fetch: async () => new Response(JSON.stringify({ result: r })) });
  it("missing metadata is unsupported, never a success", async () => {
    expect((await reader(result({ meta: null })).tx("S")).status).toBe("unsupported");
    expect((await reader(result({ meta: {} })).tx("S")).status).toBe("unsupported");
  });
  it("explicit success metadata is accepted", async () => {
    expect(await reader(result({})).tx("S")).toMatchObject({ status: "ok", tx: { err: null, slot: 5, signers: [w.toBase58()] } });
  });
  it("rejects bad signer header, slot, instruction index and unknown versions", async () => {
    expect((await reader(result({ transaction: { message: { header: { numRequiredSignatures: 3 }, accountKeys: [w.toBase58(), MEMO_PROGRAM], instructions: [] } } })).tx("S")).status).toBe("unsupported");
    expect((await reader(result({ slot: -1 })).tx("S")).status).toBe("unsupported");
    expect((await reader(result({ transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [w.toBase58()], instructions: [{ programIdIndex: -1, data: memoB58 }] } } })).tx("S")).status).toBe("unsupported");
    expect((await reader(result({ version: 1 })).tx("S")).status).toBe("unsupported");
  });
  it("does not start a fetch when the signal is already aborted", async () => {
    const f = vi.fn(); const c = new AbortController(); c.abort();
    await expect(memoReader("https://rpc.example", { fetch: f, signal: c.signal }).genesis()).rejects.toThrow(/cancelled/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("guarded wallet submit: last gate and account events", () => {
  const base = (over: any = {}) => {
    let watcher: ((a?: string | null) => void) | null = null;
    const d: any = { decode: () => ({}), feePayer: () => "W", connect: vi.fn(async () => "W"), sign: vi.fn(async (t: any) => t), serialize: vi.fn(() => "BYTES"),
      submit: vi.fn(async () => ({ ok: true, data: { signature: "S" } })), confirm: async () => ({ ok: true, data: { status: "confirmed", detail: "ok" } }),
      watchAccount: (cb: any) => { watcher = cb; return () => { watcher = null; }; }, sleep: async () => {}, ...over };
    return { d, fire: (a?: string | null) => watcher?.(a) };
  };
  it("a status callback that changes scope prevents submit", async () => {
    let live = true; const { d } = base();
    const p = guardedSignSubmit({ preparationId: "p", transaction: "" }, d, { guard: () => live, onStatus: (s) => { if (s.startsWith("Submitting")) live = false; } });
    await expect(p).rejects.toBeInstanceOf(ScopeChangedError); expect(d.submit).not.toHaveBeenCalled();
  });
  it("serialization that changes scope prevents submit", async () => {
    let live = true; const { d } = base({ serialize: vi.fn(() => { live = false; return "BYTES"; }) });
    await expect(guardedSignSubmit({ preparationId: "p", transaction: "" }, d, { guard: () => live })).rejects.toBeInstanceOf(ScopeChangedError);
    expect(d.submit).not.toHaveBeenCalled();
  });
  it("the wallet's own initial account event does not cancel; a different account does", async () => {
    const h = base(); h.d.connect = vi.fn(async () => { h.fire("W"); return "W"; });
    await expect(guardedSignSubmit({ preparationId: "p", transaction: "" }, h.d)).resolves.toMatchObject({ signature: "S" });
    const h2 = base(); h2.d.sign = vi.fn(async (t: any) => { h2.fire("OTHER"); return t; });
    await expect(guardedSignSubmit({ preparationId: "p", transaction: "" }, h2.d)).rejects.toBeInstanceOf(ScopeChangedError);
    expect(h2.d.submit).not.toHaveBeenCalled();
  });
  it("a synchronous disconnect while the wallet opens leaves no unhandled rejection", async () => {
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    const h = base(); h.d.sign = vi.fn(() => { h.fire(null); return Promise.reject(new Error("user rejected")); });
    await expect(guardedSignSubmit({ preparationId: "p", transaction: "" }, h.d)).rejects.toBeInstanceOf(ScopeChangedError);
    await new Promise((r) => setTimeout(r, 10)); process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled(); expect(h.d.submit).not.toHaveBeenCalled();
  });
});
