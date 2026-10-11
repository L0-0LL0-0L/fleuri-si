// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CLOCK_SYSVAR, DFS_FEE_VAULT_DISC, DFS_PROGRAM, FEE_VAULT_LEN, POOL_LEN, POSITION_LEN, WSOL, checkFeeVault, decodeClock, derive, disc, positionView } from "./staking";
import { readSnapshot } from "@/lib/staking.server";

const prog = Keypair.generate().publicKey.toBase58(); const d = derive(prog); const wallet = Keypair.generate().publicKey.toBase58();
const Q = 1n << 64n;
const u128 = (b: Uint8Array, o: number, x: bigint) => { const v = new DataView(b.buffer); v.setBigUint64(o, x & (Q - 1n), true); v.setBigUint64(o + 8, x >> 64n, true); };
function poolBytes(acc: bigint, active = 100n) {
  const b = new Uint8Array(POOL_LEN); b.set(disc("accounts", "Pool"), 0); const v = new DataView(b.buffer);
  const L = 8 + 7 * 32 + 2; v.setBigInt64(L, 604800n, true); v.setBigInt64(L + 8, 604800n, true); v.setBigUint64(L + 16, active, true); u128(b, L + 24, acc);
  v.setBigInt64(L + 88, 1_760_000_000n, true); // lastUpdate == clock: no pending stream math
  return { owner: prog, data: b };
}
function posBytes(cp: bigint, active = 100n) {
  const b = new Uint8Array(POSITION_LEN); b.set(disc("accounts", "Position"), 0); const v = new DataView(b.buffer);
  v.setBigUint64(73, active, true); u128(b, 81, cp); return { owner: prog, data: b };
}
const clock = (ts = 1_760_000_000n) => { const b = new Uint8Array(40); new DataView(b.buffer).setBigInt64(32, ts, true); return { owner: "Sysvar1111111111111111111111111111111111111", data: b }; };
const info = (a: { owner: string; data: Uint8Array } | null) => a && { owner: new PublicKey(a.owner), data: Buffer.from(a.data), executable: false, lamports: 1 };

describe("Clock sysvar", () => {
  it("reads unix_timestamp at byte 32, rejects other lengths", () => {
    expect(decodeClock(clock(123n)).unixTimestamp).toBe(123n);
    expect(() => decodeClock({ owner: "x", data: new Uint8Array(39) })).toThrow();
  });
});

describe("coherent multi-account snapshot", () => {
  it("rejects a newer position checkpoint against an older pool accumulator", () => {
    expect(() => positionView(prog, poolBytes(5n * Q), posBytes(6n * Q), clock())).toThrow(/ahead/);
    expect(positionView(prog, poolBytes(6n * Q), posBytes(5n * Q), clock()).position!.claimable).toBe(100n);
  });
  it("reads all accounts plus Clock in ONE getMultipleAccountsInfoAndContext call and retries an incoherent bank", async () => {
    let n = 0;
    const conn = { getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[], cfg: any) => {
      expect(cfg.commitment).toBe("confirmed");
      expect(keys.map((k) => k.toBase58())).toEqual(expect.arrayContaining([d.pool.toBase58(), d.position(wallet).toBase58(), d.principal.toBase58(), d.reward.toBase58(), CLOCK_SYSVAR]));
      n++;
      // first response: state changed mid-read (position newer than pool) -> must not be shown
      const pool = n === 1 ? poolBytes(5n * Q) : poolBytes(7n * Q);
      const vals = [pool, posBytes(6n * Q), null, null, null, null, clock(), null];
      return { context: { slot: 1000 + n }, value: vals.map(info) };
    }) };
    // pool.feeVault is the zero key; first coherent read then re-reads with that key
    const r = await readSnapshot(conn as any, prog, d, wallet, 4);
    expect(r.view!.position!.claimable).toBe(100n);
    expect(r.view!.clock.unixTimestamp).toBe(1_760_000_000n);
    expect(conn.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(3);
    expect(r.slot).toBe(1003);
  });
  it("gives up rather than displaying a permanently incoherent checkpoint", async () => {
    const conn = { getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [poolBytes(1n), posBytes(2n), null, null, null, null, clock(), null].map(info) }) };
    await expect(readSnapshot(conn as any, prog, d, wallet)).rejects.toThrow(/coherent/);
  });
});

describe("harvestable amount uses the configured recipient index", () => {
  it("duplicate pool addresses with different checkpoints: only the selected slot counts", () => {
    const enc = (s: string) => new TextEncoder().encode(s); const base = Keypair.generate().publicKey;
    const [addr, bump] = PublicKey.findProgramAddressSync([enc("fee_vault"), base.toBytes(), new PublicKey(WSOL).toBytes()], new PublicKey(DFS_PROGRAM));
    const tv = PublicKey.findProgramAddressSync([enc("token_vault"), addr.toBytes()], new PublicKey(DFS_PROGRAM))[0];
    const b = new Uint8Array(FEE_VAULT_LEN); const v = new DataView(b.buffer);
    b.set(DFS_FEE_VAULT_DISC, 0); b.set(new PublicKey(WSOL).toBytes(), 40); b.set(tv.toBytes(), 72); b[105] = 1; b[106] = bump; v.setUint32(120, 10_000, true); b.set(base.toBytes(), 152);
    u128(b, 136, 10n * Q);
    for (const [i, cp] of [[0, 0n], [3, 9n * Q]] as const) { const u = 248 + i * 80; b.set(d.pool.toBytes(), u); v.setUint32(u + 32, 1000, true); u128(b, u + 64, cp); }
    const acc = { owner: DFS_PROGRAM, data: b };
    expect(checkFeeVault(addr.toBase58(), acc, { feeTokenVault: tv.toBase58(), pool: d.pool.toBase58(), index: 3 }).claimable).toBe(1000n);
    expect(checkFeeVault(addr.toBase58(), acc, { feeTokenVault: tv.toBase58(), pool: d.pool.toBase58(), index: 0 }).claimable).toBe(10_000n);
  });
});

describe("associated token account program id", () => {
  it("derives the canonical ATA (known wallet USDC ATA vector)", async () => {
    const { ata } = await import("./staking");
    expect(ata("11111111111111111111111111111111", "So11111111111111111111111111111111111111112").toBase58())
      .toBe(PublicKey.findProgramAddressSync([new PublicKey("11111111111111111111111111111111").toBytes(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBytes(), new PublicKey(WSOL).toBytes()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0].toBase58());
  });
});

