// @vitest-environment node
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { PublicKey, Keypair } from "@solana/web3.js";
import { canonicalize } from "@/pq/canonical";
import { generatePqKeypair } from "@/pq/mldsa";
import { manifestFixture } from "@/pq/fixtures";
import { buildReport, type ReportDeps } from "./botanist-report";

const addr = () => Keypair.generate().publicKey.toBase58();
function deps(o: Partial<ReportDeps> = {}): ReportDeps {
  const m = manifestFixture(generatePqKeypair());
  const launch = { pool: addr(), config: m.config.address, creator_wallet: m.creatorWallet, lifecycle: "curve_active", signature: "5".repeat(88), passports: { manifest_hash: "a".repeat(64), manifest: m } };
  return {
    getSlot: async () => 321, now: () => "2026-10-10T00:00:00.000Z", cluster: "mainnet-beta", dbcProgram: "dbcij3LWUppWqq96dh6gJWwBifmcgFLSB5D4DuSMaqN",
    readAnyMint: async () => ({ program: "spl-token", decimals: 9, supply: 1_000_000_000n, mintAuthority: null, freezeAuthority: null, extensions: [] }),
    readTokenMetadata: async () => ({ name: "Strange Bloom", symbol: "BLOOM", uri: "ipfs://x", updateAuthority: "11111111111111111111111111111111", isMutable: false }),
    readUpgradeAuthority: async () => ({ status: "ok", loader: "BPFLoaderUpgradeab1e11111111111111111111111", programData: addr(), immutable: false, authority: addr(), slot: 5 }),
    largestAccounts: async () => [{ address: addr(), amount: "600000000" }, { address: addr(), amount: "100000000" }],
    findLaunch: async () => launch,
    // Real SDK reader shapes: BigInt reserves/threshold and nested terms with BN/strings.
    readPool: async () => ({ creator: addr(), baseMint: m.token.baseMint, config: m.config.address, isMigrated: 0, migrationProgress: 0, quoteReserve: 123456789n, migrationQuoteThreshold: 85_000_000_000n, dammV2Pool: null, dammV2Confirmed: false }),
    readDbcConfig: async () => ({ cfg: { quoteReserve: new BN(5) }, problems: [], terms: { fees: { ...m.fees }, lp: m.lp, migration: { ...m.migration, quoteThresholdLamports: "85000000000" } }, raw: new BN("18446744073709551616") }),
    ...o,
  };
}

describe("botanist report", () => {
  it("serializes a fleuri launch report with exact strings for BigInt/BN and the real config terms", async () => {
    const d = deps(); const r: any = await buildReport(d, addr());
    expect(() => canonicalize(r)).not.toThrow(); expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.facts.dbc.quoteReserveLamports).toBe("123456789");
    expect(r.facts.dbc.migrationQuoteThresholdLamports).toBe("85000000000");
    expect(r.facts.dbc.creatorChanged).toBe(true);
    expect(r.facts.dbcConfig.feeClaimer).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(r.facts.dbcConfig.matchesSigned).toBe(true);
    expect(r.facts.dbcConfig.migrationQuoteThresholdLamports).toBe("85000000000");
    expect(r.facts.mint.supply).toBe("1000000000");
    expect(r.facts.holders.top10ShareBps).toBe(7000);
    expect(typeof r.facts.dbcProgram.authority).toBe("string"); expect(r.facts.dbcProgram.immutable).toBe(false);
    expect(r.observedSlot).toBe(321);
  });
  it("labels absent pool, missing metadata and non-fleuri mints unavailable with explicit nulls", async () => {
    const r: any = await buildReport(deps({ readPool: async () => null, readTokenMetadata: async () => null }), addr());
    expect(r.facts.dbc).toBeNull(); expect(r.unavailable.dbcPool).toMatch(/not found/);
    expect(r.facts.metadata).toBeNull(); expect(r.unavailable.metadata).toMatch(/No Metaplex/);
    expect(() => canonicalize(r)).not.toThrow();
    const n: any = await buildReport(deps({ findLaunch: async () => null, largestAccounts: async () => { throw new Error("rpc 429"); } }), addr());
    expect(n.unavailable.protocol).toMatch(/Not a fleuri launch/); expect(n.unavailable.holders).toMatch(/429/); expect(n.facts.fleuri).toBeUndefined();
    expect(() => canonicalize(n)).not.toThrow();
  });
  it("refuses to report on non-mint accounts (quotes validate the same reader before payment)", async () => {
    await expect(buildReport(deps({ readAnyMint: async () => { throw new Error("not an initialized mint"); } }), addr())).rejects.toThrow(/mint/);
  });
});
