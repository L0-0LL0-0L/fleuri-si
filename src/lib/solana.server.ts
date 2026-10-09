// Server-only Solana + Meteora DBC adapter. Never holds user keys; builds unsigned SDK transactions
// and reads confirmed chain state. Env is read inside functions (Workers inject at request time).
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveMintMetadata } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { domainHash, b64, utf8 } from "@/pq/canonical";
import { DBC_PROGRAM_ID, SOL_MINT } from "@/pq/passport";
import { GENESIS, type Cluster } from "@/pq/registration";
import type { Check } from "@/pq/passport";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export function solEnv() {
  const raw = process.env["SOLANA_CLUSTER"] || "devnet";
  const cluster: Cluster | null = raw === "devnet" || raw === "mainnet-beta" ? raw : null;
  const rpcUrl = process.env["SOLANA_RPC_URL"] || (cluster === "devnet" ? "https://api.devnet.solana.com" : null);
  return {
    clusterRaw: raw,
    cluster,
    rpcUrl,
    rpcSource: process.env["SOLANA_RPC_URL"] ? "configured" : cluster === "devnet" ? "public devnet RPC" : "missing",
    dbcConfig: process.env["METEORA_DBC_CONFIG"] || null,
    dammV2Config: process.env["METEORA_DAMM_V2_CONFIG"] || null,
    pinataJwt: process.env["PINATA_JWT"] || null,
    gateway: (process.env["IPFS_GATEWAY"] || "https://gateway.pinata.cloud/ipfs/").replace(/\/?$/, "/"),
    origin: process.env["FLEURI_ORIGIN"] || "fleuri-digital-garden.lovable.app",
  };
}

export function connection() {
  const e = solEnv();
  if (!e.cluster) throw new Error(`SOLANA_CLUSTER must be "devnet" or "mainnet-beta".`);
  if (!e.rpcUrl) throw new Error("SOLANA_RPC_URL is required for mainnet-beta.");
  return new Connection(e.rpcUrl, "confirmed");
}

export async function assertGenesis(conn: Connection, cluster: Cluster) {
  const g = await conn.getGenesisHash();
  if (g !== GENESIS[cluster]) throw new Error(`RPC genesis ${g} does not match ${cluster}.`);
  return g;
}

// ---------- config snapshot ----------
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
      out[path] = typeof p === "number" && !Number.isSafeInteger(p) ? String(p) : typeof p === "string" && p.length > 200 ? p.slice(0, 200) : p;
      return;
    }
    if (Array.isArray(p)) p.forEach((x, i) => walk(x, `${path}.${i}`));
    else for (const k of Object.keys(p).sort()) walk(p[k], path ? `${path}.${k}` : k);
  };
  walk(cfg, "");
  for (const k of Object.keys(out)) if (k.length > 64) delete out[k];
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
      migratedPoolFeeBps: n(cfg.migratedPoolFeeBps),
    },
    authority: {
      tokenUpdateAuthority: "immutable" as const,
      leftoverReceiver: s(cfg.leftoverReceiver),
      policy: "Metadata is immutable at creation. Mint authority is held by the DBC pool and the transfer-hook program/authority, if any, is revoked at curve completion. No Fleuri-controlled authority exists.",
    },
    decimals: n(cfg.tokenDecimal),
    totalSupply: s(cfg.preMigrationTokenSupply),
  };
  return { cfg, problems, terms, ...snapshotConfig(cfg) };
}

export async function buildCreatePoolTx(conn: Connection, p: { config: string; baseMint: string; creator: string; name: string; symbol: string; uri: string }) {
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const creator = new PublicKey(p.creator);
  const baseMint = new PublicKey(p.baseMint);
  const config = new PublicKey(p.config);
  const tx = await client.creator.createPool({ name: p.name, symbol: p.symbol, uri: p.uri, payer: creator, poolCreator: creator, config, baseMint });
  const bh = await conn.getLatestBlockhash("confirmed");
  return finalizeUnsigned(tx, creator, bh, [creator.toBase58(), baseMint.toBase58()]);
}

export function finalizeUnsigned(tx: Transaction, feePayer: PublicKey, bh: { blockhash: string; lastValidBlockHeight: number }, allowedSigners: string[]) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = bh.blockhash;
  const msg = tx.compileMessage();
  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const extra = signers.filter((x) => !allowedSigners.includes(x));
  if (extra.length) throw new Error(`Transaction requires unexpected signers: ${extra.join(", ")}`);
  if (!tx.instructions.some((i) => i.programId.toBase58() === DBC_PROGRAM_ID || i.programId.equals(MEMO_PROGRAM_ID))) throw new Error("Transaction does not call the expected program.");
  const message = tx.serializeMessage();
  return { tx, message, lastValidBlockHeight: bh.lastValidBlockHeight, signers };
}

export const derivePool = (baseMint: string, config: string) => deriveDbcPoolAddress(new PublicKey(SOL_MINT), new PublicKey(baseMint), new PublicKey(config)).toBase58();

export async function buildMemoTx(conn: Connection, wallet: string, memo: string) {
  const w = new PublicKey(wallet);
  const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: w, isSigner: true, isWritable: false }], data: Buffer.from(utf8(memo)) }));
  const bh = await conn.getLatestBlockhash("confirmed");
  return finalizeUnsigned(tx, w, bh, [wallet]);
}

export const unsignedB64 = (tx: Transaction) => b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

/** Reads a confirmed transaction. Returns null when not yet visible. */
export async function readConfirmedTx(conn: Connection, signature: string) {
  const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t) return null;
  const message = t.transaction.message;
  const keys = message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  const ixs = message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], data: ix.data, accounts: ix.accountKeyIndexes.map((i) => keys[i]) }));
  const signers = keys.slice(0, message.header.numRequiredSignatures);
  return { slot: t.slot, err: t.meta?.err ?? null, serialized: message.serialize(), ixs, signers };
}

export async function readPool(conn: Connection, pool: string) {
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const p: any = await client.state.getPool(new PublicKey(pool));
  if (!p) return null;
  const cfg: any = await client.state.getPoolConfig(p.config);
  return {
    baseMint: s(p.baseMint),
    config: s(p.config),
    creator: s(p.creator),
    isMigrated: n(p.isMigrated),
    migrationProgress: n(p.migrationProgress),
    quoteReserve: BigInt(s(p.quoteReserve)),
    migrationQuoteThreshold: BigInt(s(cfg?.migrationQuoteThreshold)),
  };
}

/** Parses the Metaplex metadata account (name/symbol/uri/isMutable). */
export async function readTokenMetadata(conn: Connection, mint: string) {
  const info = await conn.getAccountInfo(deriveMintMetadata(new PublicKey(mint)));
  if (!info) return null;
  const d = info.data;
  let o = 1 + 32 + 32;
  const str = () => {
    const len = d.readUInt32LE(o);
    o += 4;
    const v = d.subarray(o, o + len).toString("utf8").replace(/\0+$/, "");
    o += len;
    return v;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  o += 2;
  if (d[o++] === 1) o += 4 + d.readUInt32LE(o) * 34;
  o += 1;
  const isMutable = d[o] === 1;
  return { name, symbol, uri, isMutable, updateAuthority: new PublicKey(d.subarray(1, 33)).toBase58() };
}

export async function pinBytes(bytes: Uint8Array, filename: string, mime: string) {
  const { pinataJwt } = solEnv();
  if (!pinataJwt) throw new Error("PINATA_JWT is not configured, so immutable metadata cannot be pinned.");
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${pinataJwt}` }, body: form });
  if (!r.ok) throw new Error(`IPFS pinning failed (${r.status}).`);
  const j = (await r.json()) as { IpfsHash: string };
  return j.IpfsHash;
}

export async function readiness(): Promise<{ cluster: string; rpcSource: string; ready: boolean; checks: Check[]; dbcConfig: string | null }> {
  const e = solEnv();
  const checks: Check[] = [];
  const push = (id: string, label: string, status: Check["status"], detail: string) => checks.push({ id, label, status, detail });
  if (!e.cluster) push("cluster", "Cluster", "fail", `SOLANA_CLUSTER="${e.clusterRaw}" is not devnet or mainnet-beta.`);
  else push("cluster", "Cluster", "pass", `${e.cluster} (${e.rpcSource})`);
  let conn: Connection | null = null;
  if (e.cluster && e.rpcUrl) {
    try {
      conn = new Connection(e.rpcUrl, "confirmed");
      await assertGenesis(conn, e.cluster);
      push("rpc", "RPC + genesis", "pass", `genesis matches ${e.cluster}`);
    } catch (err) {
      conn = null;
      push("rpc", "RPC + genesis", "unavailable", (err as Error).message.slice(0, 160));
    }
  } else push("rpc", "RPC + genesis", "unavailable", "SOLANA_RPC_URL missing.");
  if (conn) {
    try {
      const prog = await conn.getAccountInfo(new PublicKey(DBC_PROGRAM_ID));
      push("dbc", "Meteora DBC program", prog?.executable ? "pass" : "fail", prog?.executable ? `${DBC_PROGRAM_ID} is deployed` : "program not found on this cluster");
    } catch (err) {
      push("dbc", "Meteora DBC program", "unavailable", (err as Error).message.slice(0, 120));
    }
  } else push("dbc", "Meteora DBC program", "unavailable", "needs RPC");
  if (!e.dbcConfig) push("config", "DBC pool config", "fail", "METEORA_DBC_CONFIG is not set. Create a DBC config (SOL quote, DAMM v2, immutable, fixed supply) and add its address.");
  else if (!conn) push("config", "DBC pool config", "unavailable", "needs RPC");
  else {
    try {
      const r = await readDbcConfig(conn, e.dbcConfig);
      push("config", "DBC pool config", r.problems.length ? "fail" : "pass", r.problems.length ? r.problems.join("; ") : `valid · fee ${r.terms.fees.baseFeeBps} bps · migrates to DAMM v2 at ${Number(r.terms.migration.quoteThresholdLamports) / 1e9} SOL`);
    } catch (err) {
      push("config", "DBC pool config", "fail", (err as Error).message);
    }
  }
  push("ipfs", "Immutable metadata pinning", e.pinataJwt ? "pass" : "fail", e.pinataJwt ? `Pinata · gateway ${e.gateway}` : "PINATA_JWT is not set.");
  push("damm", "Manual DAMM v2 migration", e.dammV2Config ? "pass" : "unavailable", e.dammV2Config ? "METEORA_DAMM_V2_CONFIG set" : "Optional: set METEORA_DAMM_V2_CONFIG to allow manual migrateToDammV2. Meteora keepers migrate many configs automatically.");
  const ready = checks.filter((c) => c.id !== "damm").every((c) => c.status === "pass");
  return { cluster: e.cluster ?? e.clusterRaw, rpcSource: e.rpcSource, ready, checks, dbcConfig: e.dbcConfig };
}
