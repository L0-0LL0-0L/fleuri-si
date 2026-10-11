import { describe, expect, it } from "vitest";
import { clearPending, createFence, pendingKey, readPending, writePending } from "./greenhouse-session";

function mem() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; }
const p = { requestId: "aaaaaaaa-0000-4000-8000-000000000001", config: { agentIds: ["a_1"], seed: 1, repetitions: 1, cycles: 5, scenarios: ["control" as const] } };

describe("greenhouse session privacy", () => {
  it("pending requests are scoped to their owner", () => {
    const s = mem();
    writePending("ownerA", p, s);
    expect(readPending("ownerA", s)).toEqual(p);
    expect(readPending("ownerB", s)).toBeNull();
    expect(readPending(null, s)).toBeNull();
    clearPending("ownerA", s); expect(readPending("ownerA", s)).toBeNull();
  });
  it("strictly rejects malformed or legacy pending entries", () => {
    const s = mem();
    s.setItem(pendingKey("o"), JSON.stringify({ requestId: "nope", config: p.config }));
    expect(readPending("o", s)).toBeNull();
    s.setItem(pendingKey("o"), JSON.stringify({ ...p, extra: 1 }));
    expect(readPending("o", s)).toBeNull();
    s.setItem(pendingKey("o"), "{");
    expect(readPending("o", s)).toBeNull();
    s.setItem("fleuri.greenhouse.pending.v1", JSON.stringify(p));
    expect(readPending("o", s)).toBeNull(); // the old global key is never read
  });
  it("fences late responses from a previous owner", async () => {
    const f = createFence(); const shown: string[] = [];
    const g = f.current();
    const late = new Promise<string>((r) => setTimeout(() => r("old owner's private run"), 5));
    f.bump(); // session switched
    const v = await late; if (f.guard(g)) shown.push(v);
    expect(shown).toEqual([]);
    const g2 = f.current(); if (f.guard(g2)) shown.push("new"); expect(shown).toEqual(["new"]);
  });
});
