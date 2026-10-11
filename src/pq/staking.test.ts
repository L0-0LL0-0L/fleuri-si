// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import fixture from "../../onchain/pollen-staking/fixtures/layout.json";
import {
  ACTIONS, PLACEHOLDER_PROGRAM_ID, STAKE_MINT, STAKING_IDL, TOKEN_PROGRAM, WSOL, buildHarvestIx, buildIx, claimableAt, decodePool, decodeProgramData,
  derive, fixtureReader, parseEvents, readLedger, readPositionState, readiness, updateLedger, type Ledger, type PositionState, type ReadinessFacts,
} from "./staking";
import { dbcPartnerRouting } from "./pollen";
import { FLEURI_MINT } from "@/lib/token";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const D = 7n * 86_400n;
const zeroL = (): Ledger => ({ duration: D, cooldown: D, totalActive: 0n, accPerShare: 0n, carry: 0n, streamAmount: 0n, streamStart: 0n, streamReleased: 0n, unallocated: 0n, lastUpdate: 0n, verifiedFeesTotal: 0n, treasuryTotal: 0n, distributedTotal: 0n, claimedTotal: 0n });
const zeroP = (): PositionState => ({ active: 0n, checkpoint: 0n, frac: 0n, owed: 0n, pendingAmount: 0n, unlockTs: 0n, claimedTotal: 0n });
const settle = (l: Ledger, p: PositionState) => { const num = p.active * (l.accPerShare - p.checkpoint) + p.frac; p.owed += num >> 64n; p.frac = num & ((1n << 64n) - 1n); p.checkpoint = l.accPerShare; };
const fund = (l: Ledger, amt: bigint, now: bigint) => { const u = updateLedger(l, now); const rem = u.streamAmount - u.streamReleased; return { ...u, streamAmount: rem + amt, streamStart: now, streamReleased: 0n }; };

describe("Rust layout cross-check", () => {
  it("decodes the Rust-written fixture exactly", () => {
    expect(readLedger(fixtureReader(hex(fixture.ledger)))).toEqual({ duration: D, cooldown: D, totalActive: 3n, accPerShare: 1n << 70n, carry: 5n, streamAmount: 9n, streamStart: -1n, streamReleased: 2n, unallocated: 4n, lastUpdate: 7n, verifiedFeesTotal: 11n, treasuryTotal: 12n, distributedTotal: 13n, claimedTotal: 14n });
    expect(readPositionState(fixtureReader(hex(fixture.position)))).toEqual({ active: 21n, checkpoint: (1n << 128n) - 1n, frac: 22n, owed: 23n, pendingAmount: 24n, unlockTs: 25n, claimedTotal: 26n });
  });
  it("builds instructions with the IDL's exact account order, writability and signers", () => {
    const prog = Keypair.generate().publicKey.toBase58(); const owner = Keypair.generate().publicKey.toBase58();
    const t = Keypair.generate().publicKey.toBase58();
    for (const a of ACTIONS) {
      const ix = buildIx(prog, a, owner, { ownerToken: t, ownerReward: t, amount: 5n });
      const spec = STAKING_IDL.instructions.find((i: any) => i.name === a);
      expect(ix.keys.map((k) => [k.isWritable, k.isSigner])).toEqual(spec.accounts.map((x: any) => [!!x.writable, !!x.signer]));
      expect([...ix.data.subarray(0, 8)]).toEqual(spec.discriminator);
      expect(ix.keys[0].pubkey.toBase58()).toBe(owner);
    }
    const h = buildHarvestIx(prog, owner, t, t); const hs = STAKING_IDL.instructions.find((i: any) => i.name === "harvest_fees");
    expect(h.keys.map((k) => [k.isWritable, k.isSigner])).toEqual(hs.accounts.map((x: any) => [!!x.writable, !!x.signer]));
  });
  it("derives distinct, deterministic PDAs per program and owner", () => {
    const prog = Keypair.generate().publicKey.toBase58();
    const a = derive(prog), b = derive(prog);
    expect(a.pool.equals(b.pool)).toBe(true);
    expect(a.principal.equals(a.reward)).toBe(false);
    const o1 = Keypair.generate().publicKey.toBase58(), o2 = Keypair.generate().publicKey.toBase58();
    expect(a.position(o1).equals(a.position(o2))).toBe(false);
    expect(derive(Keypair.generate().publicKey.toBase58()).pool.equals(a.pool)).toBe(false);
  });
  it("rejects amounts that are zero or above u64", () => {
    const p = Keypair.generate().publicKey.toBase58();
    expect(() => buildIx(p, "stake", p, { ownerToken: p, amount: 0n })).toThrow();
    expect(() => buildIx(p, "request_unstake", p, { amount: 1n << 64n })).toThrow();
  });
  it("rejects accounts that are not pools", () => {
    expect(() => decodePool(new Uint8Array(400))).toThrow(/not a Pollen Staking pool/i);
  });
  it("exposes no admin instruction that could move principal or rewards", () => {
    expect(STAKING_IDL.instructions.map((i: any) => i.name).sort()).toEqual(["cancel_unstake", "claim", "fund_treasury", "harvest_fees", "initialize_pool", "release_unallocated", "request_unstake", "stake", "withdraw"]);
    for (const i of STAKING_IDL.instructions) {
      const outOfVault = i.accounts.some((a: any) => (a.name === "principal_vault" || a.name === "reward_vault") && a.writable) && ["withdraw", "claim"].includes(i.name);
      if (outOfVault) { expect(i.accounts[0]).toMatchObject({ name: "owner", signer: true }); expect(i.accounts.some((a: any) => a.name === "position")).toBe(true); }
    }
  });
});

describe("accounting mirror", () => {
  it("matches the Rust late-joiner scenario and conserves rewards", () => {
    let l = zeroL(); const a = zeroP(), b = zeroP();
    a.active = 100n; l.totalActive = 100n;
    l = fund(l, 700n, 0n);
    l = updateLedger(l, D / 2n); settle(l, b); b.active = 100n; l.totalActive = 200n; // late joiner settles first
    expect(claimableAt(l, b, D / 2n)).toBe(0n);
    expect(claimableAt(l, a, D / 2n)).toBe(350n);
    expect(claimableAt(l, a, D) + claimableAt(l, b, D)).toBe(700n);
    expect(claimableAt(l, b, D)).toBe(175n);
  });
  it("sends releases with no stakers to unallocated", () => {
    const l = updateLedger(fund(zeroL(), 1000n, 0n), D);
    expect(l.unallocated).toBe(1000n); expect(l.distributedTotal).toBe(0n);
  });
});

describe("readiness", () => {
  const prog = Keypair.generate().publicKey.toBase58(); const d = derive(prog);
  const good = (): ReadinessFacts => ({ cluster: "mainnet-beta", genesisOk: true, rpcFresh: true, programId: prog, programExecutable: true, programUpgradeable: false, upgradeAuthority: null, expectedHash: "ab", actualHash: "ab",
    mint: { address: STAKE_MINT, exists: true, mintAuthority: null, freezeAuthority: null, owner: TOKEN_PROGRAM },
    pool: { stakeMint: STAKE_MINT, rewardMint: WSOL, principalVault: d.principal.toBase58(), rewardVault: d.reward.toBase58(), feeVault: "x" }, vaultsOk: true, feeSourceOk: true, feeSourceDetail: "ok" });
  it("enables deposits only when every check passes", () => { expect(readiness(good()).depositsEnabled).toBe(true); });
  it.each([
    ["remaining FLEURI freeze authority", (f: ReadinessFacts) => { f.mint!.freezeAuthority = "5MtQsF3RibxepdqDCf6NmLVqjXHDXiGj1rJojkp3Gse8"; }, "freezeAuth"],
    ["bytecode mismatch", (f: ReadinessFacts) => { f.actualHash = "cd"; }, "code"],
    ["missing expected hash", (f: ReadinessFacts) => { f.expectedHash = null; }, "code"],
    ["devnet cluster", (f: ReadinessFacts) => { f.cluster = "devnet"; }, "cluster"],
    ["wrong genesis", (f: ReadinessFacts) => { f.genesisOk = false; }, "cluster"],
    ["stale RPC", (f: ReadinessFacts) => { f.rpcFresh = false; }, "rpc"],
    ["no pool", (f: ReadinessFacts) => { f.pool = null; }, "pool"],
    ["wrong mint", (f: ReadinessFacts) => { f.mint!.address = Keypair.generate().publicKey.toBase58(); }, "mint"],
    ["swapped vaults", (f: ReadinessFacts) => { f.pool!.rewardVault = f.pool!.principalVault; }, "vaults"],
    ["unverified source", (f: ReadinessFacts) => { f.feeSourceOk = false; }, "source"],
    ["non-executable program", (f: ReadinessFacts) => { f.programExecutable = false; }, "program"],
  ])("blocks deposits on %s", (_n, mut, id) => {
    const f = good(); mut(f); const r = readiness(f);
    expect(r.depositsEnabled).toBe(false); expect(r.checks.find((c) => c.id === id)!.ok).toBe(false);
  });
  it("never treats the placeholder or a missing ID as deployed", () => {
    expect(readiness({ ...good(), programId: PLACEHOLDER_PROGRAM_ID }, PLACEHOLDER_PROGRAM_ID).depositsEnabled).toBe(false);
    expect(readiness({ ...good(), programId: null }, null).depositsEnabled).toBe(false);
  });
  it("reads upgrade authority only from a well-formed ProgramData header", () => {
    const pd = new Uint8Array(45); new DataView(pd.buffer).setUint32(0, 3, true); pd[12] = 1; pd.set(new PublicKey(prog).toBytes(), 13);
    expect(decodeProgramData(pd)).toEqual({ upgradeable: true, authority: prog });
    pd[12] = 0; expect(decodeProgramData(pd).upgradeable).toBe(false);
    pd[12] = 7; expect(() => decodeProgramData(pd)).toThrow();
  });
});

describe("fee source and events", () => {
  it("the existing $FLEURI DBC pool cannot route fees to a staking vault it does not name", () => {
    const vault = Keypair.generate().publicKey.toBase58();
    const r = dbcPartnerRouting({ feeClaimer: "5MtQsF3RibxepdqDCf6NmLVqjXHDXiGj1rJojkp3Gse8", quoteMint: WSOL, collectFeeMode: 0, vault, vaultMint: WSOL, signer: vault, recipients: [vault], migrated: false });
    expect(r.eligible).toBe(false); expect(r.reasons[0]).toMatch(/retrofitted/);
    expect(FLEURI_MINT).toBe(STAKE_MINT);
  });
  it("only parses events emitted by this program at its own depth", () => {
    const prog = Keypair.generate().publicKey.toBase58(); const owner = Keypair.generate().publicKey;
    const ev = STAKING_IDL.events.find((e: any) => e.name === "Claimed").discriminator;
    const b = new Uint8Array(8 + 64 + 8); b.set(ev); b.set(owner.toBytes(), 8); b.set(owner.toBytes(), 40); new DataView(b.buffer).setBigUint64(72, 42n, true);
    const data = `Program data: ${btoa(String.fromCharCode(...b))}`;
    const other = Keypair.generate().publicKey.toBase58();
    expect(parseEvents([`Program ${prog} invoke [1]`, data, `Program ${prog} success`], prog)).toEqual([{ name: "Claimed", pool: owner.toBase58(), who: owner.toBase58(), amount: 42n, extra: undefined }]);
    expect(parseEvents([`Program ${prog} invoke [1]`, `Program ${other} invoke [2]`, data, `Program ${other} success`, `Program ${prog} success`], prog)).toEqual([]);
  });
});
