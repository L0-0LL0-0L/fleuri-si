import { describe, expect, it } from "vitest";
import { createScope } from "./live-scope";
import { clearReceiptSig, readReceiptSig, writeReceiptSig } from "./receipt-session";

function mem() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; }
const RID = "aaaaaaaa-0000-4000-8000-000000000001", RID2 = "aaaaaaaa-0000-4000-8000-000000000002";

describe("deferred responses and account switches", () => {
  it("a late publish/prepare/anchor result is dropped after owner, receipt or anchor scope changes", async () => {
    const s = createScope("ownerA|r1|-"); const shown: string[] = [];
    const late = (v: string, ms: number) => new Promise<string>((r) => setTimeout(() => r(v), ms));
    const t1 = s.token(); const p1 = late("owner A published", 5);
    s.set("ownerB|r1|-"); // account switch while in flight
    if (s.live(t1)) shown.push(await p1); else await p1;
    const t2 = s.token(); s.set("ownerB|r1|prep2"); // a new anchor preparation replaced the one being signed
    expect(s.live(t2)).toBe(false);
    const t3 = s.token(); s.end(); // unmount
    expect(s.live(t3)).toBe(false);
    expect(shown).toEqual([]);
  });
  it("bump invalidates an older RPC/file read in the same scope", () => {
    const s = createScope("file"); const t = s.token(); s.bump(); expect(s.live(t)).toBe(false); expect(s.live(s.token())).toBe(true);
  });
  it("saved signature bytes are per owner and per exact draft hash", () => {
    const st = mem(); const v = { receiptId: RID, manifestHash: "a".repeat(64), publicKey: "pk", signature: "sig" };
    writeReceiptSig("A", v, st);
    expect(readReceiptSig("A", RID, "a".repeat(64), st)).toEqual(v);
    expect(readReceiptSig("B", RID, "a".repeat(64), st)).toBeNull();
    expect(readReceiptSig("A", RID, "b".repeat(64), st)).toBeNull();
    expect(readReceiptSig("A", RID2, "a".repeat(64), st)).toBeNull();
    clearReceiptSig("A", RID, st); expect(readReceiptSig("A", RID, "a".repeat(64), st)).toBeNull();
  });
});
