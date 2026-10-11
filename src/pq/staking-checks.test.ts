// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  DFS_FEE_VAULT_DISC, DFS_PROGRAM, FEE_VAULT_LEN, STAKING_IDL, TOKEN_PROGRAM, WSOL, blockers, buildIx, checkFeeVault, checkTokenAccount,
  decodeMintStrict, derive, fundLedger, matchConfirmation, readiness, updateLedger, vested, type Ledger, type ReadinessFacts,
} from "./staking";
import { checkSubmission, messageHash } from "./chain-pure";

const D = 7n * 86_400n;
const enc = (s: string) => new TextEncoder().encode(s);
const prog = Keypair.generate().publicKey.toBase58();
const d = derive(prog); const pool = d.pool.toBase58();

function tokenAcc(mint: string, authority: string, o: { delegate?: boolean; close?: boolean; state?: number; len?: number } = {}) {
  const b = new Uint8Array(o.len ?? 165); if (b.length < 165) return b;
  b.set(new PublicKey(mint).toBytes(), 0); b.set(new PublicKey(authority).toBytes(), 32);
  const v = new DataView(b.buffer); if (o.delegate) v.setUint32(72, 1, true); b[108] = o.state ?? 1; if (o.close) v.setUint32(129, 1, true);
  return b;
}
/** Builds a real-shaped DFS PDA fee vault (bytemuck FeeVault) for `base`. */
function feeVault(base = Keypair.generate().publicKey, o: { type?: number; flag?: number; index?: number; share?: number; who?: string } = {}) {
  const [addr, bump] = PublicKey.findProgramAddressSync([enc("fee_vault"), base.toBytes(), new PublicKey(WSOL).toBytes()], new PublicKey(DFS_PROGRAM));
  const tv = PublicKey.findProgramAddressSync([enc("token_vault"), addr.toBytes()], new PublicKey(DFS_PROGRAM))[0];
  const b = new Uint8Array(FEE_VAULT_LEN); const v = new DataView(b.buffer);
  b.set(DFS_FEE_VAULT_DISC, 0); b.set(new PublicKey(WSOL).toBytes(), 40); b.set(tv.toBytes(), 72);
  b[104] = o.flag ?? 0; b[105] = o.type ?? 1; b[106] = bump; v.setUint32(120, 10_000, true); b.set(base.toBytes(), 152);
  const i = o.index ?? 2; b.set(new PublicKey(o.who ?? pool).toBytes(), 248 + i * 80); v.setUint32(248 + i * 80 + 32, o.share ?? 2_500, true);
  return { address: addr.toBase58(), tokenVault: tv.toBase58(), acc: { owner: DFS_PROGRAM, data: b } };
}

describe("vault custody checks", () => {
  it("accepts a clean pool vault", () => expect(checkTokenAccount({ owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, pool) }, { mint: WSOL, authority: pool })).toEqual([]));
  it.each([
    ["truncated", { owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, pool, { len: 100 }) }, /length/],
    ["oversized", { owner: TOKEN_PROGRAM, data: new Uint8Array(170) }, /length/],
    ["wrong program owner", { owner: Keypair.generate().publicKey.toBase58(), data: tokenAcc(WSOL, pool) }, /SPL Token/],
    ["delegate", { owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, pool, { delegate: true }) }, /delegate/],
    ["close authority", { owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, pool, { close: true }) }, /close/],
    ["frozen", { owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, pool, { state: 2 }) }, /frozen/],
    ["uninitialized", { owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, pool, { state: 0 }) }, /uninitialized/],
    ["wrong mint", { owner: TOKEN_PROGRAM, data: tokenAcc(Keypair.generate().publicKey.toBase58(), pool) }, /mint/],
    ["wrong authority", { owner: TOKEN_PROGRAM, data: tokenAcc(WSOL, Keypair.generate().publicKey.toBase58()) }, /authority/],
  ])("rejects %s", (_n, acc, re) => expect(checkTokenAccount(acc, { mint: WSOL, authority: pool }).join(" ")).toMatch(re));
  it("rejects a missing account", () => expect(checkTokenAccount(null, { mint: WSOL, authority: pool })).toEqual(["account missing"]));
});

describe("strict mint decoding", () => {
  const mint = (dec = 6, init = 1, len = 82) => { const b = new Uint8Array(len); if (len >= 82) { b[44] = dec; b[45] = init; } return b; };
  it("reads decimals and initialized", () => expect(decodeMintStrict(TOKEN_PROGRAM, mint())).toMatchObject({ decimals: 6, initialized: true, mintAuthority: null, freezeAuthority: null }));
  it("rejects truncated, wrong owner and malformed options", () => {
    expect(() => decodeMintStrict(TOKEN_PROGRAM, mint(6, 1, 50))).toThrow(/length/);
    expect(() => decodeMintStrict(WSOL, mint())).toThrow(/SPL Token/);
    const m = mint(); new DataView(m.buffer).setUint32(0, 9, true); expect(() => decodeMintStrict(TOKEN_PROGRAM, m)).toThrow(/option/);
  });
  it("readiness blocks wrong decimals or an uninitialized mint", () => {
    const f = good(); f.mint!.decimals = 9; expect(readiness(f).checks.find((c) => c.id === "mint")!.ok).toBe(false);
    const g = good(); g.mint!.initialized = false; expect(readiness(g).checks.find((c) => c.id === "mint")!.ok).toBe(false);
  });
});

describe("DFS fee vault check (mirror of Rust check_fee_vault)", () => {
  it("accepts the canonical PDA vault naming the pool at its index", () => {
    const v = feeVault(); const r = checkFeeVault(v.address, v.acc, { feeTokenVault: v.tokenVault, pool, index: 2 });
    expect(r.issues).toEqual([]); expect(r.share).toBe(2_500); expect(r.totalShare).toBe(10_000);
  });
  it("rejects a wrong recipient index, another recipient and zero share", () => {
    const v = feeVault(); expect(checkFeeVault(v.address, v.acc, { feeTokenVault: v.tokenVault, pool, index: 1 }).issues.join()).toMatch(/recipient 1 is not the pool/);
    const w = feeVault(undefined, { who: Keypair.generate().publicKey.toBase58() }); expect(checkFeeVault(w.address, w.acc, { feeTokenVault: w.tokenVault, pool, index: 2 }).issues.join()).toMatch(/not the pool/);
    const z = feeVault(undefined, { share: 0 }); expect(checkFeeVault(z.address, z.acc, { feeTokenVault: z.tokenVault, pool, index: 2 }).issues.join()).toMatch(/share is zero/);
    expect(checkFeeVault(v.address, v.acc, { feeTokenVault: v.tokenVault, pool, index: 5 }).issues.join()).toMatch(/out of range/);
  });
  it("rejects keypair vaults, Token-2022 flag, non-canonical PDA and token vault", () => {
    const k = feeVault(undefined, { type: 0 }); expect(checkFeeVault(k.address, k.acc, { feeTokenVault: k.tokenVault, pool, index: 2 }).issues.join()).toMatch(/keypair/);
    const f = feeVault(undefined, { flag: 1 }); expect(checkFeeVault(f.address, f.acc, { feeTokenVault: f.tokenVault, pool, index: 2 }).issues.join()).toMatch(/flag/);
    const v = feeVault(); const other = Keypair.generate().publicKey.toBase58();
    expect(checkFeeVault(other, v.acc, { feeTokenVault: v.tokenVault, pool, index: 2 }).issues.join()).toMatch(/canonical fee-vault PDA/);
    expect(checkFeeVault(v.address, v.acc, { feeTokenVault: other, pool, index: 2 }).issues.join()).toMatch(/token vault/);
  });
  it("rejects truncated data and a non-DFS owner", () => {
    const v = feeVault();
    expect(checkFeeVault(v.address, { owner: DFS_PROGRAM, data: v.acc.data.subarray(0, 300) }, { feeTokenVault: v.tokenVault, pool, index: 2 }).issues).toEqual(["not a DFS fee vault"]);
    expect(checkFeeVault(v.address, { owner: TOKEN_PROGRAM, data: v.acc.data }, { feeTokenVault: v.tokenVault, pool, index: 2 }).issues).toEqual(["not owned by Dynamic Fee Sharing"]);
  });
});

function good(): ReadinessFacts {
  return { cluster: "mainnet-beta", genesisOk: true, rpcFresh: true, programId: prog, programExecutable: true, programUpgradeable: false, upgradeAuthority: null, expectedHash: "ab", actualHash: "ab",
    mint: { address: "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri", exists: true, mintAuthority: null, freezeAuthority: null, owner: TOKEN_PROGRAM, decimals: 6, initialized: true },
    pool: { stakeMint: "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri", rewardMint: WSOL, principalVault: d.principal.toBase58(), rewardVault: d.reward.toBase58(), feeVault: "x" }, vaultsOk: true, feeSourceOk: true, feeSourceDetail: "ok" };
}

describe("exit isolation", () => {
  it("exits stay available when deposit-only checks (mint authorities, fee source) fail", () => {
    const f = good(); f.mint!.freezeAuthority = Keypair.generate().publicKey.toBase58(); f.feeSourceOk = false; f.mint!.decimals = 9;
    const { checks, depositsEnabled } = readiness(f);
    expect(depositsEnabled).toBe(false);
    for (const a of ["request_unstake", "cancel_unstake", "withdraw", "claim"] as const) expect(blockers(a, checks)).toEqual([]);
    expect(blockers("stake", checks).map((c) => c.id).sort()).toEqual(["freezeAuth", "mint", "source"]);
    expect(blockers("harvest", checks).map((c) => c.id)).toEqual(["source"]);
  });
  it("exits are blocked by a wrong program or stale RPC", () => {
    const f = good(); f.actualHash = "zz"; expect(blockers("withdraw", readiness(f).checks).map((c) => c.id)).toEqual(["code"]);
  });
});

describe("reward window cannot be griefed (TS mirror)", () => {
  const l0 = (): Ledger => ({ duration: D, cooldown: D, totalActive: 1n, accPerShare: 0n, carry: 0n, streamAmount: 0n, streamStart: 0n, streamEnd: 0n, streamReleased: 0n, unallocated: 0n, lastUpdate: 0n, dfsFundedTotal: 0n, treasuryTotal: 0n, distributedTotal: 0n, claimedTotal: 0n });
  it("1-lamport top-ups keep the original deadline; zero is rejected", () => {
    let l = fundLedger(l0(), 1_000_000n, true, 0n);
    for (let t = 1n; t < D; t += 3_600n) l = fundLedger(l, 1n, false, t);
    expect(l.streamEnd).toBe(D);
    expect(updateLedger(l, D).distributedTotal).toBe(l.dfsFundedTotal + l.treasuryTotal);
    expect(() => fundLedger(l, 0n, true, 5n)).toThrow();
    const after = fundLedger(updateLedger(l, 2n * D), 7n, false, 2n * D); expect(after.streamEnd).toBe(3n * D); expect(vested(after, 3n * D)).toBe(7n);
  });
});

describe("event confirmation", () => {
  const owner = Keypair.generate().publicKey;
  const evLog = (name: string, poolKey: PublicKey, who: PublicKey, amount: bigint, extra?: bigint) => {
    const disc = STAKING_IDL.events.find((e: any) => e.name === name).discriminator;
    const b = new Uint8Array(8 + 64 + 8 + (extra != null ? 8 : 0)); b.set(disc); b.set(poolKey.toBytes(), 8); b.set(who.toBytes(), 40);
    const v = new DataView(b.buffer); v.setBigUint64(72, amount, true); if (extra != null) v.setBigUint64(80, extra, true);
    return [`Program ${prog} invoke [1]`, `Program data: ${btoa(String.fromCharCode(...b))}`, `Program ${prog} success`];
  };
  const prep = (action: any, amount: string | null) => ({ subject: pool, wallet: owner.toBase58(), payload: { programId: prog, action, amount } });
  it("accepts the program's own matching event", () => expect(matchConfirmation(prep("stake", "5"), evLog("Staked", d.pool, owner, 5n, 5n)).amount).toBe(5n));
  it("rejects a different amount, wallet, pool, event or program", () => {
    expect(() => matchConfirmation(prep("stake", "6"), evLog("Staked", d.pool, owner, 5n, 5n))).toThrow(/amount differs/);
    expect(() => matchConfirmation(prep("stake", "5"), evLog("Staked", d.pool, Keypair.generate().publicKey, 5n, 5n))).toThrow(/No Staked/);
    expect(() => matchConfirmation(prep("stake", "5"), evLog("Staked", Keypair.generate().publicKey, owner, 5n, 5n))).toThrow();
    expect(() => matchConfirmation(prep("claim", null), evLog("Withdrawn", d.pool, owner, 5n))).toThrow(/No Claimed/);
    const foreign = evLog("Claimed", d.pool, owner, 5n).map((l) => l.replace(prog, Keypair.generate().publicKey.toBase58()));
    expect(() => matchConfirmation(prep("claim", null), foreign)).toThrow();
  });
});

describe("identical-byte recovery for staking transactions", () => {
  it("accepts only the exact prepared message and returns stable bytes", () => {
    const kp = Keypair.generate(); const t = Keypair.generate().publicKey.toBase58();
    const mk = (amount: bigint) => { const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: "11111111111111111111111111111111" }); tx.add(buildIx(prog, "request_unstake", kp.publicKey.toBase58(), { ownerToken: t, amount })); return tx; };
    const tx = mk(5n); const msg = tx.serializeMessage(); const prepared = { messageHash: messageHash(msg), messageB64: btoa(String.fromCharCode(...msg)) };
    tx.sign(kp); const signed = btoa(String.fromCharCode(...tx.serialize()));
    const a = checkSubmission(prepared, signed), b = checkSubmission(prepared, signed);
    expect([...a]).toEqual([...b]);
    const other = mk(6n); other.sign(kp);
    expect(() => checkSubmission(prepared, btoa(String.fromCharCode(...other.serialize())))).toThrow(/differs/);
    const unsigned = btoa(String.fromCharCode(...mk(5n).serialize({ requireAllSignatures: false })));
    expect(() => checkSubmission(prepared, unsigned)).toThrow(/signature/);
  });
});
