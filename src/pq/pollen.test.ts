// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { USDC_MINT, WSOL_MINT, claimable, percentToBps, pdaProblems, dfsEvents, fundDelta, compareVault, dbcPartnerRouting, parseAmount, parseTerms } from "./pollen";
const w = () => Keypair.generate().publicKey.toBase58();

describe("pollen allocation rules", () => {
  it("accepts 2–5 unique recipients totalling 10,000 bps", () => {
    expect(parseTerms({ mint: USDC_MINT, recipients: [{ address: w(), bps: 6000 }, { address: w(), bps: 4000 }] }).recipients).toHaveLength(2);
  });
  it.each([
    ["one recipient", [{ bps: 10000 }]],
    ["six recipients", Array(6).fill(0).map(() => ({ bps: 10000 / 6 | 0 }))],
    ["sum below 100%", [{ bps: 5000 }, { bps: 4999 }]],
    ["zero share", [{ bps: 10000 }, { bps: 0 }]],
  ])("rejects %s", (_n, rs) => {
    expect(() => parseTerms({ mint: USDC_MINT, recipients: (rs as any[]).map((r) => ({ address: w(), ...r })) })).toThrow();
  });
  it("rejects duplicate, default and unsupported-mint vaults", () => {
    const a = w();
    expect(() => parseTerms({ mint: USDC_MINT, recipients: [{ address: a, bps: 5000 }, { address: a, bps: 5000 }] })).toThrow("unique");
    expect(() => parseTerms({ mint: USDC_MINT, recipients: [{ address: "11111111111111111111111111111111", bps: 5000 }, { address: w(), bps: 5000 }] })).toThrow();
    expect(() => parseTerms({ mint: w(), recipients: [{ address: w(), bps: 5000 }, { address: w(), bps: 5000 }] })).toThrow("USDC");
  });
  it("parses exact amounts and rejects ambiguity", () => {
    expect(parseAmount("0.5", 6)).toBe(500000n); expect(parseAmount("12", 9)).toBe(12_000_000_000n);
    for (const bad of ["-1", "0", "1e3", "0.0000001", "1,5", ""]) expect(() => parseAmount(bad, 6)).toThrow();
  });
  it("detects any change between reviewed and on-chain allocations", () => {
    const o = w(); const t = parseTerms({ mint: WSOL_MINT, recipients: [{ address: w(), bps: 7000 }, { address: w(), bps: 3000 }] });
    const users = t.recipients.map((r) => ({ address: r.address, share: r.bps }));
    expect(compareVault({ mint: WSOL_MINT, owner: o, users }, t, o)).toEqual([]);
    expect(compareVault({ mint: WSOL_MINT, owner: o, users: [users[0], { ...users[1], share: 3001 }] }, t, o)).toContain("recipient shares differ");
    expect(compareVault({ mint: USDC_MINT, owner: o, users }, t, o)).toContain("mint differs");
  });
  it("refuses source-fee routing for pools whose config does not name the vault", () => {
    const vault = w(), s = w();
    const base = { feeClaimer: vault, quoteMint: WSOL_MINT, collectFeeMode: 0, vault, vaultMint: WSOL_MINT, signer: s, recipients: [s], migrated: false };
    expect(dbcPartnerRouting(base).eligible).toBe(true);
    expect(dbcPartnerRouting({ ...base, feeClaimer: w() }).reasons[0]).toMatch(/retrofitted/);
    expect(dbcPartnerRouting({ ...base, vaultMint: USDC_MINT }).eligible).toBe(false);
    expect(dbcPartnerRouting({ ...base, signer: w() }).eligible).toBe(false);
    expect(dbcPartnerRouting({ ...base, migrated: true }).eligible).toBe(false);
  });
  it("computes claimable from the feePerShare checkpoint with Q64 floor rounding", () => {
    const total = 10_000n; let fps = 0n;
    fps += fundDelta(1_000_001n, total); // 1.000001 USDC funded
    expect(claimable(3333n, fps, 0n)).toBe(333_300n); // floor, never over-pays
    const cp = fps; fps += fundDelta(500_000n, total);
    expect(claimable(3333n, fps, cp)).toBe(166_650n);
    expect(claimable(6667n, fps, 0n) + claimable(3333n, fps, 0n)).toBeLessThanOrEqual(1_500_001n);
    expect(() => claimable(1n, 0n, 1n)).toThrow();
  });
  it("parses exact two-decimal shares and rejects extra precision", () => {
    expect(percentToBps("33.33")).toBe(3333); expect(percentToBps("50")).toBe(5000); expect(percentToBps("0.01")).toBe(1);
    for (const bad of ["33.333", "0", "100.01", "-5", "1e2", ""]) expect(() => percentToBps(bad)).toThrow();
  });
  it("bounds amounts to u64", () => {
    expect(() => parseAmount("18446744073709.551616", 6)).toThrow(/u64/);
    expect(parseAmount("18446744073709.551615", 6)).toBe(18446744073709551615n);
  });
  it("allows DBC routing only into derived PDA vaults", () => {
    expect(pdaProblems({ feeVaultType: 0, derived: "a", address: "a" })[0]).toMatch(/non-PDA/);
    expect(pdaProblems({ feeVaultType: 1, derived: "a", address: "b" })[0]).toMatch(/derived/);
    expect(pdaProblems({ feeVaultType: 1, derived: "a", address: "a" })).toEqual([]);
  });
  it("attributes amounts only from this transaction's DFS events", () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const tag = [228, 69, 165, 46, 81, 203, 154, 29];
    const fund = new Uint8Array(16 + 32 + 32 + 8 + 16 + 4); fund.set(tag); fund.set([15, 14, 233, 140, 19, 195, 163, 7], 8); fund.fill(7, 48, 80); new DataView(fund.buffer).setBigUint64(80, 1234n, true);
    const claim = new Uint8Array(16 + 32 + 32 + 1 + 8); claim.set(tag); claim.set([6, 36, 88, 232, 53, 193, 253, 98], 8); claim.fill(7, 16, 48); claim.fill(9, 48, 80); new DataView(claim.buffer).setBigUint64(81, 55n, true);
    const ev = dfsEvents([fund, claim, new Uint8Array([1, 2, 3])], hex);
    expect(ev).toEqual([{ kind: "fund", vault: "07".repeat(32), amount: 1234n }, { kind: "claim", vault: "07".repeat(32), user: "09".repeat(32), amount: 55n }]);
  });
});
