// @vitest-environment node
// watch()/discovery against mocked chain replies: wrong owner, undecodable pool, sanitized failures,
// missing DAMM v2 account, NFT token state, vault checks and the bounded fallback discovery budget.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const m = vi.hoisted(() => ({ accounts: new Map<string, any>(), slot: 100, multiFail: false, genesisFail: false, rpc: vi.fn(), decode: vi.fn(), readVault: vi.fn() }));
vi.mock("./solana.server", () => ({
  solEnv: () => ({ cluster: "mainnet-beta", rpcUrl: "https://secret-rpc.example/?api-key=abc" }),
  connection: () => ({
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => { if (m.multiFail) throw new Error("upstream 503 https://secret-rpc.example"); return { context: { slot: m.slot }, value: keys.map((k) => m.accounts.get(k.toBase58()) ?? null) }; },
    getAccountInfo: async (k: PublicKey) => m.accounts.get(k.toBase58()) ?? null,
    getBlockTime: async () => 1_700_000_000,
  }),
  assertGenesis: async () => { if (m.genesisFail) throw new Error("raw genesis error"); return "genesis"; },
}));
vi.mock("./pollen.server", () => ({ readVault: m.readVault }));
vi.mock("./observatory.server", async (orig) => ({ ...(await orig<any>()), rpc: m.rpc }));
vi.mock("@meteora-ag/dynamic-bonding-curve-sdk", async (orig) => {
  const real = await orig<any>();
  const coder = { accounts: { decode: (name: string, data: Buffer) => m.decode(name, data) } };
  return { ...real, DynamicBondingCurveClient: class { state = { program: { coder } }; }, createDammV2Program: () => ({ coder }) };
});

import { DAMM_V2_PROGRAM, DBC_PROGRAM, DFS_PROGRAM, SOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "@/pq/watchtower";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DISCOVERY_MAX_REQUESTS, SIG_PAGE, discoverPositions, mintFacts, tokenAccount, tryVault, watch } from "./watchtower.server";
import { publicMessage } from "./observatory.server";

const k = () => Keypair.generate().publicKey.toBase58();
const acct = (owner: string, tag: string, data = Buffer.alloc(200)) => ({ owner: new PublicKey(owner), data: Object.assign(data, { tag }), lamports: 1, executable: false });
function mint(supply = 1n, decimals = 6, initialized = true) { const d = Buffer.alloc(82); d.writeBigUInt64LE(supply, 36); d[44] = decimals; d[45] = initialized ? 1 : 0; return d; }
function tokAcc(mintA: string, holder: string, amount: bigint, state: number) { const d = Buffer.alloc(165); new PublicKey(mintA).toBuffer().copy(d, 0); new PublicKey(holder).toBuffer().copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = state; return d; }

let POOL: string, CONFIG: string, BASE: string, CREATOR: string, CLAIMER: string, DAMM: string;
const cfg = (over: any = {}) => ({ quoteMint: SOL_MINT, feeClaimer: CLAIMER, leftoverReceiver: CLAIMER, collectFeeMode: 0, migrationOption: 1, migrationFeeOption: 2, tokenType: 0, quoteTokenFlag: 0, tokenDecimal: 6, partnerLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, migrationQuoteThreshold: "100", migratedPoolFeeBps: 0, lockedVestingConfig: { amountPerPeriod: "0", numberOfPeriod: "0", cliffUnlockAmount: "0" }, creatorTradingFeePercentage: 0, ...over });
let config: any; let dammPool: any;

beforeEach(() => {
  m.accounts.clear(); m.multiFail = false; m.genesisFail = false; m.rpc.mockReset(); m.readVault.mockReset().mockRejectedValue(new Error("not DFS"));
  CONFIG = k(); BASE = k(); CREATOR = k(); CLAIMER = k();
  POOL = deriveDbcPoolAddress(new PublicKey(SOL_MINT), new PublicKey(BASE), new PublicKey(CONFIG)).toBase58();
  DAMM = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[2], new PublicKey(BASE), new PublicKey(SOL_MINT)).toBase58();
  config = cfg();
  dammPool = { tokenAMint: BASE, tokenBMint: SOL_MINT, liquidity: "10", permanentLockLiquidity: "0", collectFeeMode: 1, poolStatus: 0, activationType: 1, creator: CREATOR, poolFees: {}, metrics: { totalPosition: "500" } };
  m.decode.mockImplementation((name: string, d: any) => {
    if (name === "virtualPool" && d.tag === "pool") return { config: CONFIG, creator: CREATOR, baseMint: BASE, baseVault: k(), quoteVault: k(), quoteReserve: "100", baseReserve: "0", isMigrated: 1, migrationProgress: 3 };
    if (name === "poolConfig" && d.tag === "config") return config;
    if (name === "pool" && d.tag === "damm") return dammPool;
    throw new Error("bad discriminator");
  });
  m.accounts.set(POOL, acct(DBC_PROGRAM, "pool"));
  m.accounts.set(CONFIG, acct(DBC_PROGRAM, "config"));
  m.accounts.set(BASE, acct(TOKEN_PROGRAM, "mint", mint(1_000_000n)));
  m.accounts.set(SOL_MINT, acct(TOKEN_PROGRAM, "mint", mint(0n, 9)));
});

describe("watch()", () => {
  it("rejects wrong-owner and non-pool accounts with safe messages", async () => {
    m.accounts.set(POOL, acct(DAMM_V2_PROGRAM, "pool"));
    await expect(watch(POOL)).rejects.toThrow(/not owned by Meteora Dynamic Bonding Curve/);
    m.accounts.set(POOL, acct(DBC_PROGRAM, "other"));
    await expect(watch(POOL)).rejects.toThrow(/not a virtual pool/);
    await expect(watch(k())).rejects.toThrow(/No account/);
  });
  it("sanitizes genesis and chain-read failures (no upstream text or RPC URL)", async () => {
    m.genesisFail = true;
    const e1 = await watch(POOL).catch((e) => e); expect(publicMessage(e1)).not.toMatch(/raw|secret/);
    m.genesisFail = false; m.multiFail = true;
    const e2 = await watch(POOL).catch((e) => e); expect(publicMessage(e2)).toBe("The chain read failed. Try again later."); expect(publicMessage(e2)).not.toMatch(/secret|503/);
  });
  it("keeps a migrated pool unverified when the derived DAMM v2 account is missing", async () => {
    const r = await watch(POOL);
    expect(r.input.damm.derived).toBe(DAMM); expect(r.input.damm.account).toBe("missing");
    expect(r.summary.stage.stage).toBe("migrated_unverified"); expect(r.input.discovery).toBeNull();
    expect(r.input.baseMint).toMatchObject({ initialized: true, mintAuthority: null, freezeAuthority: null });
  });
  it("explains an option the installed SDK can't derive instead of guessing a preset pool", async () => {
    config = cfg({ migrationFeeOption: 7 });
    const r = await watch(POOL);
    expect(r.input.damm.derived).toBeNull(); expect(r.input.damm.derivationNote).toMatch(/unsupported/);
    expect(r.summary.checks.find((c) => c.id === "feeOption")!.status).toBe("unsupported");
  });
  it("lists positions without trusting the cumulative counter, and rejects a frozen NFT", async () => {
    m.accounts.set(DAMM, acct(DAMM_V2_PROGRAM, "damm"));
    const nftMint = k();
    const { derivePositionAddress, derivePositionNftAccount } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const pos = derivePositionAddress(new PublicKey(nftMint)).toBase58(); const nftAcct = derivePositionNftAccount(new PublicKey(nftMint)).toBase58();
    const holder = k();
    m.rpc.mockImplementation(async (_u: string, method: string) => { if (method === "getProgramAccounts") return [{ pubkey: pos, account: { data: [new PublicKey(nftMint).toBuffer().toString("base64"), "base64"], owner: DAMM_V2_PROGRAM } }]; throw new Error("unexpected"); });
    m.accounts.set(pos, acct(DAMM_V2_PROGRAM, "position"));
    m.accounts.set(nftMint, acct(TOKEN_2022_PROGRAM, "nftmint", mint(1n, 0)));
    m.accounts.set(nftAcct, acct(TOKEN_2022_PROGRAM, "nftacct", tokAcc(nftMint, holder, 1n, 2)));
    const prev = m.decode.getMockImplementation()!;
    m.decode.mockImplementation((name: string, d: any) => name === "position" && d.tag === "position" ? { pool: DAMM, nftMint, unlockedLiquidity: "0", vestedLiquidity: "0", permanentLockedLiquidity: "10", feeAPending: "0", feeBPending: "0", innerVesting: {} } : prev(name, d));
    const r = await watch(POOL);
    expect(r.summary.stage.stage).toBe("damm_v2_verified");
    expect(r.input.discovery?.status).toBe("found"); expect(r.input.discovery?.detail).toMatch(/also counts closed positions/);
    expect(r.input.positions[0]).toMatchObject({ slot: 100, nft: { state: 2, holder } });
    expect(r.summary.positions[0]).toMatchObject({ status: "failed", holder: null, lockBadge: null, allPermanent: false });
    // An initialized NFT account verifies, with the per-position slot.
    m.accounts.set(nftAcct, acct(TOKEN_2022_PROGRAM, "nftacct", tokAcc(nftMint, holder, 1n, 1)));
    const r2 = await watch(POOL);
    expect(r2.summary.positions[0]).toMatchObject({ status: "verified", holder, allPermanent: true, slot: 100 });
  });
});

describe("discovery budget", () => {
  it("stops at the explicit page budget and reports truncation as unknown", async () => {
    m.rpc.mockImplementation(async () => Array.from({ length: SIG_PAGE }, (_, i) => ({ signature: `s${i}` })));
    const d = await discoverPositions("u", "P", "D");
    expect(d.status).toBe("truncated"); expect(d.positions).toEqual([]);
    expect(d.budget!.requests).toBeLessThanOrEqual(DISCOVERY_MAX_REQUESTS); expect(m.rpc.mock.calls.length).toBeLessThanOrEqual(DISCOVERY_MAX_REQUESTS);
  });
  it("stops on the time budget and on rate limits", async () => {
    let t = 0; m.rpc.mockImplementation(async () => { t += 10_000; return [{ signature: "a" }]; });
    expect((await discoverPositions("u", "P", "D", () => t)).status).toBe("truncated");
    const { RpcError } = await import("./observatory.server");
    m.rpc.mockReset().mockRejectedValue(new RpcError("rate_limited"));
    const d = await discoverPositions("u", "P", "D");
    expect(d.status).toBe("unavailable"); expect(d.detail).toMatch(/rate-limited/);
  });
});

describe("vault and token layouts", () => {
  it("flags unsupported, wrong-mint and frozen DFS token vaults", async () => {
    const V = k(), TV = k();
    m.readVault.mockResolvedValue({ address: V, mint: SOL_MINT, tokenVault: TV, supported: true, feeVaultType: 1, recipients: [{ address: k() }], pdaIssues: [], accountSlot: 9 });
    m.accounts.set(TV, acct(TOKEN_PROGRAM, "tv", tokAcc(SOL_MINT, k(), 0n, 1)));
    expect(await tryVault({ getAccountInfo: async (p: PublicKey) => m.accounts.get(p.toBase58()) } as any, V)).toMatchObject({ issues: [], slot: 9 });
    m.accounts.set(TV, acct(TOKEN_PROGRAM, "tv", tokAcc(k(), k(), 0n, 2)));
    const bad = await tryVault({ getAccountInfo: async (p: PublicKey) => m.accounts.get(p.toBase58()) } as any, V);
    expect(bad!.issues!.join(" ")).toMatch(/different mint/); expect(bad!.issues!.join(" ")).toMatch(/initialized, unfrozen/);
    m.readVault.mockResolvedValue({ address: V, mint: k(), tokenVault: TV, supported: false, feeVaultType: 1, recipients: [], pdaIssues: [], accountSlot: 9 });
    expect((await tryVault({ getAccountInfo: async () => null } as any, V))!.issues!.join(" ")).toMatch(/not a supported/);
    m.readVault.mockRejectedValue(new Error("not DFS"));
    expect(await tryVault({} as any, V)).toBeNull();
    void DFS_PROGRAM;
  });
  it("decodes mint authorities and short accounts as unknown", () => {
    const d = mint(); d.writeUInt32LE(1, 0); new PublicKey(CREATOR).toBuffer().copy(d, 4);
    expect(mintFacts("M", acct(TOKEN_PROGRAM, "m", d) as any)).toMatchObject({ initialized: true, mintAuthority: CREATOR, freezeAuthority: null });
    expect(mintFacts("M", acct(TOKEN_PROGRAM, "m", Buffer.alloc(10)) as any)).toMatchObject({ initialized: null, supply: null });
    expect(tokenAccount(acct(TOKEN_PROGRAM, "t", Buffer.alloc(100)) as any)).toBeNull();
  });
});
