// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { USDC_MINT, WSOL_MINT, compareVault, dbcPartnerRouting, parseAmount, parseTerms } from "./pollen";
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
});
