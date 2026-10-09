// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { compareConfig, expectedTerms, parseDraft } from "./config-draft";
import { buildConfigParams } from "./config-build";
import { buildCreateConfigTx } from "@/lib/solana.server";
import { DBC_PROGRAM_ID } from "./passport";

const w = Keypair.generate().publicKey.toBase58();
const base = { decimals: 6, totalSupply: 1_000_000_000, percentageSupplyOnMigration: 20, migrationThresholdSol: 85, baseFeeBps: 100, creatorTradingFeePercent: 50, migrationFeeOption: 2, lp: { partnerClaimable: 0, partnerLocked: 50, creatorClaimable: 0, creatorLocked: 50 }, feeClaimer: w, leftoverReceiver: w };

describe("DBC config draft", () => {
  it("rejects LP not totalling 100%, under 10% locked, bad recipients and unknown fields", () => {
    expect(() => parseDraft({ ...base, lp: { ...base.lp, creatorLocked: 40 } })).toThrow("100%");
    expect(() => parseDraft({ ...base, lp: { partnerClaimable: 50, partnerLocked: 5, creatorClaimable: 45, creatorLocked: 0 } })).toThrow("10%");
    expect(() => parseDraft({ ...base, feeClaimer: "not-an-address" })).toThrow();
    expect(() => parseDraft({ ...base, transferHook: w })).toThrow();
    expect(() => parseDraft({ ...base, migrationThresholdSol: Number.NaN })).toThrow();
  });

  it("builds a real SDK createConfig needing only the wallet and fresh config key", async () => {
    const d = parseDraft(base), params = buildConfigParams(d), config = Keypair.generate().publicKey.toBase58();
    expect(params.tokenType).toBe(0); expect(params.migrationOption).toBe(1); expect(params.tokenUpdateAuthority).toBe(1);
    const conn = new Connection("https://api.devnet.solana.com");
    (conn as any).getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 });
    const built = await buildCreateConfigTx(conn, { config, wallet: w, feeClaimer: d.feeClaimer, leftoverReceiver: d.leftoverReceiver, params });
    expect(new Set(built.signers)).toEqual(new Set([w, config]));
    expect(built.tx.instructions.every((i) => i.programId.equals(new PublicKey(DBC_PROGRAM_ID)) || i.programId.toBase58().startsWith("ComputeBudget"))).toBe(true);
    const e = expectedTerms(d, params);
    expect(e.totalSupply).toBe("1000000000000000");
    expect(e.migratedPoolFeeBps).toBe(100);
    expect(BigInt(e.quoteThresholdLamports)).toBeGreaterThanOrEqual(85_000_000_000n);
  });

  it("flags any confirmed term that differs from the reviewed draft, including a swapped fee recipient", () => {
    const d = parseDraft(base), e = expectedTerms(d, buildConfigParams(d));
    const chain = { decimals: 6, totalSupply: e.totalSupply, fees: { baseFeeBps: 100, creatorTradingFeePercent: 50, feeClaimer: w }, lp: e.lp, migration: { quoteThresholdLamports: e.quoteThresholdLamports, migrationFeeOption: 2, migratedPoolFeeBps: 100 }, authority: { leftoverReceiver: w } };
    expect(compareConfig(chain, e)).toEqual([]);
    const other = Keypair.generate().publicKey.toBase58();
    expect(compareConfig({ ...chain, fees: { ...chain.fees, feeClaimer: other } }, e).join()).toContain("fee claimer");
    expect(compareConfig({ ...chain, migration: { ...chain.migration, quoteThresholdLamports: "1" } }, e).join()).toContain("graduation threshold");
  });
});
