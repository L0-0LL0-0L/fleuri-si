import { describe, expect, it } from "vitest";
import { clearReceiptPending, readReceiptPending, receiptPendingKey, writeReceiptPending } from "./receipt-session";
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const RUN = "33333333-3333-4333-8333-333333333333";
const p = { requestId: "aaaaaaaa-0000-4000-8000-000000000001", runId: RUN, identityId: "44444444-4444-4444-8444-444444444444" };
describe("receipt session storage", () => {
  it("scopes pending requests by owner and run; never leaks to another workspace", () => {
    const s = mem(); writeReceiptPending("A", p, s);
    expect(readReceiptPending("A", RUN, s)).toEqual(p);
    expect(readReceiptPending("B", RUN, s)).toBeNull();
    expect(readReceiptPending(null, RUN, s)).toBeNull();
    clearReceiptPending("A", RUN, s); expect(readReceiptPending("A", RUN, s)).toBeNull();
  });
  it("rejects malformed or key-bearing entries", () => {
    const s = mem();
    s.setItem(receiptPendingKey("A", RUN), JSON.stringify({ ...p, secretKey: "x" }));
    expect(readReceiptPending("A", RUN, s)).toBeNull();
    expect(() => writeReceiptPending("A", { ...p, secretKey: "x" } as any, s)).toThrow();
    s.setItem(receiptPendingKey("A", RUN), "{");
    expect(readReceiptPending("A", RUN, s)).toBeNull();
  });
});
