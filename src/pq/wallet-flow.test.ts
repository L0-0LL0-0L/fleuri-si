import { describe, expect, it, vi } from "vitest";
import { ScopeChangedError, guardedSignSubmit, type WalletFlowDeps } from "./wallet-flow";

const W = "Wallet111";
function deps(over: Partial<WalletFlowDeps<any>> = {}) {
  let watcher: (() => void) | null = null;
  const d = {
    decode: () => ({ tx: 1 }), feePayer: () => W, connect: vi.fn(async () => W), sign: vi.fn(async (t: any) => ({ ...t, signed: true })), serialize: () => "SIGNED",
    submit: vi.fn(async () => ({ ok: true as const, data: { signature: "SIG" } })), confirm: vi.fn(async () => ({ ok: true as const, data: { status: "confirmed", detail: "ok" } })),
    watchAccount: (cb: () => void) => { watcher = cb; return () => { watcher = null; }; }, sleep: async () => {}, ...over,
  };
  return { d, fire: () => watcher?.(), watched: () => watcher !== null };
}
const prep = { preparationId: "p", transaction: "AA==" };

describe("scope-guarded wallet signing", () => {
  it("signs, submits the exact bytes and confirms when the scope is stable", async () => {
    const { d, watched } = deps();
    expect(await guardedSignSubmit(prep, d, { guard: () => true })).toEqual({ signature: "SIG", id: undefined, detail: "ok" });
    expect(d.submit).toHaveBeenCalledWith("SIGNED"); expect(watched()).toBe(false);
  });
  it("never submits a signature that returns after the review changed", async () => {
    let scope = "a"; const { d } = deps({ sign: vi.fn(async (t: any) => { scope = "b"; return t; }) });
    await expect(guardedSignSubmit(prep, d, { guard: () => scope === "a" })).rejects.toBeInstanceOf(ScopeChangedError);
    expect(d.submit).not.toHaveBeenCalled();
  });
  it("cancels immediately on wallet account change while the prompt is open; a late signature is discarded", async () => {
    let resolveSign!: (v: any) => void;
    const h = deps({ sign: vi.fn(() => new Promise((r) => { resolveSign = r; })) });
    const p = guardedSignSubmit(prep, h.d, {});
    await new Promise((r) => setTimeout(r, 0));
    h.fire(); // accountChanged / disconnect
    await expect(p).rejects.toBeInstanceOf(ScopeChangedError);
    resolveSign({ late: true }); await new Promise((r) => setTimeout(r, 0));
    expect(h.d.submit).not.toHaveBeenCalled();
  });
  it("an abort (owner switch/unmount) during connect cancels before signing", async () => {
    const ctrl = new AbortController(); const { d } = deps({ connect: vi.fn(() => new Promise<string>(() => {})) });
    const p = guardedSignSubmit(prep, d, { signal: ctrl.signal }); ctrl.abort();
    await expect(p).rejects.toThrow(/Cancelled while connecting/); expect(d.sign).not.toHaveBeenCalled();
  });
  it("rejects the wrong wallet and surfaces wallet rejection without submitting", async () => {
    const a = deps({ connect: vi.fn(async () => "Other") });
    await expect(guardedSignSubmit(prep, a.d)).rejects.toThrow(/Switch to the wallet/); expect(a.d.sign).not.toHaveBeenCalled();
    const b = deps({ sign: vi.fn(async () => { throw new Error("User rejected the request."); }) });
    await expect(guardedSignSubmit(prep, b.d)).rejects.toThrow(/rejected/); expect(b.d.submit).not.toHaveBeenCalled();
  });
  it("expiry while polling stops watching after submission (recovery stays in Pending transactions)", async () => {
    let expired = false;
    const { d } = deps({ confirm: vi.fn(async () => { expired = true; return { ok: true as const, data: { status: "pending", detail: "" } }; }) });
    await expect(guardedSignSubmit(prep, d, { guard: () => !expired })).rejects.toThrow(/Submitted SIG; stopped watching/);
    expect(d.submit).toHaveBeenCalledTimes(1);
  });
});
