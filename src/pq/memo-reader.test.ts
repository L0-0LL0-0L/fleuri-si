// @vitest-environment node
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { b58decode, checkRpcUrl, memoReader } from "./memo-reader";
import { MEMO_PROGRAM } from "./receipt";

const rpc = (result: any, status = 200) => async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });
const tx = (over: any = {}) => ({ slot: 77, meta: { err: null }, transaction: { message: { accountKeys: ["Signer1111", MEMO_PROGRAM], header: { numRequiredSignatures: 1 }, instructions: [{ programIdIndex: 1, accounts: [0], data: bs58.encode(new TextEncoder().encode("fleuri:receipt:v1:abc")) }] } }, ...over });

describe("browser-safe memo reader", () => {
  it("decodes base58 like the reference implementation", () => {
    for (const s of ["1", "11", "3mJr7AoUXx2Wqd", bs58.encode(new Uint8Array([0, 0, 5, 255]))]) expect(Array.from(b58decode(s))).toEqual(Array.from(bs58.decode(s)));
  });
  it("reads signers, memo data and errors from a confirmed transaction", async () => {
    const r = await memoReader("https://rpc.test", { fetch: rpc(tx()) }).tx("sig");
    expect(r.status).toBe("ok");
    if (r.status === "ok") { expect(r.tx.signers).toEqual(["Signer1111"]); expect(new TextDecoder().decode(r.tx.ixs[0].data)).toBe("fleuri:receipt:v1:abc"); expect(r.tx.slot).toBe(77); }
  });
  it("reports missing, unsupported (lookup tables / odd shapes), RPC errors and timeouts", async () => {
    expect((await memoReader("https://rpc.test", { fetch: rpc(null) }).tx("s")).status).toBe("missing");
    const lut = tx(); lut.transaction.message.instructions[0].programIdIndex = 5;
    expect((await memoReader("https://rpc.test", { fetch: rpc(lut) }).tx("s")).status).toBe("unsupported");
    expect((await memoReader("https://rpc.test", { fetch: rpc({ weird: true }) }).tx("s")).status).toBe("unsupported");
    await expect(memoReader("https://rpc.test", { fetch: async () => new Response(JSON.stringify({ error: { message: "boom" } })) }).genesis()).rejects.toThrow(/boom/);
    await expect(memoReader("https://rpc.test", { fetch: rpc("x", 500) }).genesis()).rejects.toThrow(/500/);
    const hang = (_u: string, i: RequestInit) => new Promise<Response>((_, rej) => i.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(memoReader("https://rpc.test", { fetch: hang, timeoutMs: 10 }).genesis()).rejects.toThrow(/timed out/);
  });
  it("only accepts https RPC URLs", () => {
    expect(() => checkRpcUrl("http://rpc.test")).toThrow(/https/); expect(() => checkRpcUrl("nope")).toThrow();
  });
});
