// Isomorphic Solana/Meteora chain readers. No secrets: the server passes its configured RPC
// connection; the standalone browser verifier passes a caller-selected RPC connection.
import { Connection, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveMintMetadata, METAPLEX_PROGRAM_ID, DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Buffer } from "buffer";
import { domainHash, sha256Hex } from "./canonical";
import { DBC_PROGRAM_ID, SOL_MINT } from "./passport";


function plain(v: any): any {
  if (v == null) return null;
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === "object" && typeof v.toString === "function" && (v.constructor?.name === "BN" || "words" in v)) return v.toString(10);
  if (v instanceof Uint8Array || (Array.isArray(v) && v.every((x) => typeof x === "number") && v.length > 8)) return Buffer.from(v as any).toString("hex");
  if (typeof v === "bigint") return v.toString();
  return v;
}
export function snapshotConfig(cfg: Record<string, any>) {
  const out: Record<string, string | number | boolean | null> = {};
  const walk = (v: any, path: string) => {
    const p = plain(v);
    if (p !== v || p === null || typeof p !== "object") {
      if (/padding/i.test(path)) return;
      if (path.length > 64 || (typeof p === "string" && p.length > 200) || (typeof p === "number" && !Number.isSafeInteger(p))) throw new Error("Unsupported config field: " + path);
      out[path] = p;
      return;
    }
    if (Array.isArray(p)) p.forEach((x, i) => walk(x, `${path}.${i}`));
    else for (const k of Object.keys(p).sort()) walk(p[k], path ? `${path}.${k}` : k);
  };
  walk(cfg, "");
  return { snapshot: out, snapshotHash: domainHash("fleuri:config-snapshot:v1", out) };
}

const n = (v: any) => Number(plain(v) ?? 0);
const s = (v: any) => String(plain(v) ?? "0");

/** Reads and validates the DBC config account. Throws with a precise reason when unusable. */
export async function readDbcConfig(conn: Connection, address: string) {
  const pk = new PublicKey(address);
  const info = await conn.getAccountInfo(pk);
  if (!info) throw new Error("METEORA_DBC_CONFIG account does not exist on this cluster.");
  if (info.owner.toBase58() !== DBC_PROGRAM_ID) throw new Error("METEORA_DBC_CONFIG is not owned by the Meteora DBC program.");
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const cfg: any = await client.state.getPoolConfig(pk);
  if (!cfg) throw new Error("Could not decode the DBC pool config.");
  const problems: string[] = [];
  if (plain(cfg.quoteMint) !== SOL_MINT) problems.push("quote mint must be SOL");
  if (n(cfg.migrationOption) !== 1) problems.push("migration must target DAMM v2 (migrationOption 1)");
  if (n(cfg.tokenUpdateAuthority) !== 1) problems.push("token update authority must be Immutable");
  if (n(cfg.fixedTokenSupplyFlag) !== 1) problems.push("config must use a fixed token supply so supply can be bound");
  if (n(cfg.tokenType) !== 0) problems.push("first release supports SPL Token base mints only");
  if (n(cfg.poolFees?.baseFee?.baseFeeMode) === 2) problems.push("rate limiter configs are deprecated for new pools");
  if (n(cfg.tokenDecimal) < 6 || n(cfg.tokenDecimal) > 9) problems.push("token decimals must be 6–9");
  if (s(cfg.preMigrationTokenSupply) !== s(cfg.postMigrationTokenSupply)) problems.push("first release requires the same supply cap before and after migration");
  if (BigInt(s(cfg.preMigrationTokenSupply)) <= 0n) problems.push("fixed token supply must be positive");
  const feeOption = n(cfg.migrationFeeOption);
  if (!Number.isInteger(feeOption) || feeOption < 0 || feeOption > 6) problems.push("unsupported DAMM v2 migration fee option");
  const lpTotal = n(cfg.creatorLiquidityPercentage) + n(cfg.creatorPermanentLockedLiquidityPercentage) + n(cfg.partnerLiquidityPercentage) + n(cfg.partnerPermanentLockedLiquidityPercentage);
  if (lpTotal !== 100) problems.push("first release requires claimable and permanently locked LP shares totaling 100%; LP vesting configs are not eligible");
  const terms = {
    fees: {
      baseFeeBps: Math.round(n(cfg.poolFees?.baseFee?.cliffFeeNumerator) / 100_000),
      dynamicFeeEnabled: n(cfg.poolFees?.dynamicFee?.initialized) === 1,
      feeClaimer: s(cfg.feeClaimer),
      creatorTradingFeePercent: n(cfg.creatorTradingFeePercentage),
      partnerTradingFeePercent: 100 - n(cfg.creatorTradingFeePercentage),
      poolCreationFeeLamports: s(cfg.poolCreationFee),
    },
    lp: {
      creatorLiquidityPercent: n(cfg.creatorLiquidityPercentage),
      creatorPermanentLockedPercent: n(cfg.creatorPermanentLockedLiquidityPercentage),
      partnerLiquidityPercent: n(cfg.partnerLiquidityPercentage),
      partnerPermanentLockedPercent: n(cfg.partnerPermanentLockedLiquidityPercentage),
    },
    migration: {
      target: "DAMM_V2" as const,
      quoteThresholdLamports: s(cfg.migrationQuoteThreshold),
      migrationFeeOption: n(cfg.migrationFeeOption),
      migrationFeePercent: n(cfg.migrationFeePercentage),
      creatorMigrationFeePercent: n(cfg.creatorMigrationFeePercentage),
      // Fixed fee presets leave the custom migratedPoolFeeBps field at zero.
      migratedPoolFeeBps: feeOption === 6 ? n(cfg.migratedPoolFeeBps) : ([25, 30, 100, 200, 400, 600][feeOption] ?? 0),
    },
    authority: {
      tokenUpdateAuthority: "immutable" as const,
      mintAuthority: "revoked" as const,
      freezeAuthority: "revoked" as const,
      leftoverReceiver: s(cfg.leftoverReceiver),
      policy: "SPL mint and freeze authorities are revoked. Metaplex metadata is immutable with the system-program update authority. This release uses no transfer hook. Fees and LP ownership follow the signed DBC config.",
    },
    decimals: n(cfg.tokenDecimal),
    totalSupply: s(cfg.preMigrationTokenSupply),
  };
  return { cfg, problems, terms, ...snapshotConfig({...cfg, accountDataSha256: sha256Hex(info.data)}) };
}


/**
 * Reads a confirmed transaction through a version-aware adapter. Legacy and v0 messages are
 * supported (v0 lookup-table keys come from loadedAddresses). Unsupported versions or parse
 * errors are reported as `unsupported`, never as a cryptographic pass/fail.
 */
export type ReadTx = { slot: number; blockTime: number | null; err: unknown; version: "legacy" | 0; serialized: Uint8Array; ixs: { program: string; data: Uint8Array; accounts: string[] }[]; signers: string[] };
export async function readConfirmedTxEx(conn: Connection, signature: string): Promise<{ status: "ok"; tx: ReadTx } | { status: "missing" } | { status: "unsupported"; reason: string }> {
  let t: Awaited<ReturnType<Connection["getTransaction"]>>;
  try { t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); }
  catch (e) { const m = (e as Error).message; if (/version/i.test(m)) return { status: "unsupported", reason: m.slice(0, 160) }; throw e; }
  if (!t || !t.meta) return { status: "missing" };
  try {
    const message = t.transaction.message;
    const all = message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses ?? undefined });
    const keys: string[] = []; for (let i = 0; i < all.length; i++) keys.push(all.get(i)!.toBase58());
    const ixs = message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], data: ix.data, accounts: ix.accountKeyIndexes.map((i) => keys[i]) }));
    const signers = keys.slice(0, message.header.numRequiredSignatures);
    return { status: "ok", tx: { slot: t.slot, blockTime: t.blockTime ?? null, err: t.meta.err ?? null, version: t.version === 0 ? 0 : "legacy", serialized: message.serialize(), ixs, signers } };
  } catch (e) { return { status: "unsupported", reason: `Transaction could not be parsed: ${(e as Error).message.slice(0, 120)}` }; }
}
/** Back-compatible reader: null when missing; throws (never passes) on unsupported versions. */
export async function readConfirmedTx(conn: Connection, signature: string) {
  const r = await readConfirmedTxEx(conn, signature);
  if (r.status === "missing") return null;
  if (r.status === "unsupported") throw new Error(r.reason);
  return r.tx;
}

export async function readPool(conn: Connection, pool: string) {
  const info = await conn.getAccountInfo(new PublicKey(pool));
  if (!info) return null;
  if (info.owner.toBase58() !== DBC_PROGRAM_ID) throw new Error("Pool is not owned by Meteora DBC.");
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const p: any = await client.state.getPool(new PublicKey(pool));
  if (!p) return null;
  const state = p.poolState;
  if (!state) throw new Error("Unsupported DBC pool layout.");
  const cfg: any = await client.state.getPoolConfig(state.config);
  if (!cfg) throw new Error("Pool config is not readable.");
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[n(cfg.migrationFeeOption)];
  const dammV2Pool = dammConfig ? deriveDammV2PoolAddress(dammConfig, state.baseMint, cfg.quoteMint) : null;
  const dammAccount = n(state.isMigrated) === 1 && dammV2Pool ? await conn.getAccountInfo(dammV2Pool) : null;
  return {
    baseMint: s(state.baseMint),
    config: s(state.config),
    creator: s(state.creator),
    isMigrated: n(state.isMigrated),
    migrationProgress: n(state.migrationProgress),
    quoteReserve: BigInt(s(state.quoteReserve)),
    sqrtPrice: s(state.sqrtPrice),
    migrationQuoteThreshold: BigInt(s(cfg?.migrationQuoteThreshold)),
    dammV2Pool: dammV2Pool?.toBase58() ?? null,
    dammConfig: dammConfig?.toBase58() ?? null,
    dammV2Confirmed: !!dammAccount && dammAccount.owner.equals(DAMM_V2_PROGRAM_ID),
  };
}

/** Parses the Metaplex metadata account (name/symbol/uri/isMutable). */
export async function readTokenMetadata(conn: Connection, mint: string) {
  const info = await conn.getAccountInfo(deriveMintMetadata(new PublicKey(mint)));
  if (!info) return null;
  if (!info.owner.equals(METAPLEX_PROGRAM_ID)) throw new Error("Metadata account has the wrong program owner.");
  return decodeTokenMetadata(info.data, mint);
}

export function decodeTokenMetadata(d: Buffer, mint: string) {
  if (d.length < 83 || d.length > 10000 || d[0] !== 4 || new PublicKey(d.subarray(33,65)).toBase58() !== mint) throw new Error("Invalid Metaplex metadata account.");
  let o = 1 + 32 + 32;
  const str = () => {
    if (o + 4 > d.length) throw new Error("Truncated metadata.");
    const len = d.readUInt32LE(o);
    o += 4;
    if (len > 200 || o + len > d.length) throw new Error("Invalid metadata string length.");
    const v = d.subarray(o, o + len).toString("utf8").replace(/\0+$/, "");
    o += len;
    return v;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  o += 2;
  const hasCreators = d[o++];
  if (hasCreators === 1) { if (o + 4 > d.length) throw new Error("Truncated creators."); const count = d.readUInt32LE(o); if (count > 5) throw new Error("Invalid creators."); o += 4 + count * 34; }
  else if (hasCreators !== 0) throw new Error("Invalid creator option.");
  o += 1;
  if (o >= d.length || (d[o] !== 0 && d[o] !== 1)) throw new Error("Truncated metadata flags.");
  const isMutable = d[o] === 1;
  return { name, symbol, uri, isMutable, updateAuthority: new PublicKey(d.subarray(1, 33)).toBase58() };
}

export async function readTokenMint(conn: Connection, mint: string) {
  const m = await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_PROGRAM_ID);
  return {decimals: m.decimals, supply: m.supply, mintAuthority: m.mintAuthority?.toBase58() ?? null, freezeAuthority: m.freezeAuthority?.toBase58() ?? null};
}

export const derivePool = (baseMint: string, config: string) => deriveDbcPoolAddress(new PublicKey(SOL_MINT), new PublicKey(baseMint), new PublicKey(config)).toBase58();

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** Upgrade authority of a BPF-upgradeable program, read from its ProgramData account. */
export async function readUpgradeAuthority(conn: Connection, program: string): Promise<{ loader: string; programData: string | null; authority: string | null; immutable: boolean; slot: number | null }> {
  const info = await conn.getAccountInfo(new PublicKey(program));
  if (!info) throw new Error("Program account not found.");
  const loader = info.owner.toBase58();
  if (loader !== UPGRADEABLE_LOADER) return { loader, programData: null, authority: null, immutable: true, slot: null };
  if (info.data.length < 36 || info.data.readUInt32LE(0) !== 2) throw new Error("Unexpected upgradeable program layout.");
  const programData = new PublicKey(info.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  if (!pd || pd.data.length < 13 || pd.data.readUInt32LE(0) !== 3) throw new Error("ProgramData account is unreadable.");
  const slot = Number(pd.data.readBigUInt64LE(4));
  const has = pd.data[12] === 1;
  const authority = has ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  return { loader, programData: programData.toBase58(), authority, immutable: !has, slot };
}

/** Classic SPL Token or Token-2022 mint, any decimals (Botanist inspects arbitrary mints). */
export async function readAnyMint(conn: Connection, mint: string) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error("Mint account not found.");
  const owner = info.owner.toBase58();
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  if (owner !== TOKEN_PROGRAM_ID.toBase58() && owner !== T22) throw new Error("Account is not an SPL Token mint.");
  if (info.data.length < 82) throw new Error("Mint data too short.");
  const d = Buffer.from(info.data);
  const opt = (o: number) => (d.readUInt32LE(o) === 1 ? new PublicKey(d.subarray(o + 4, o + 36)).toBase58() : null);
  return { program: owner === T22 ? "token-2022" : "spl-token", mintAuthority: opt(0), supply: d.readBigUInt64LE(36), decimals: d[44], initialized: d[45] === 1, freezeAuthority: opt(46), extensionsBytes: Math.max(0, d.length - 82) };
}
