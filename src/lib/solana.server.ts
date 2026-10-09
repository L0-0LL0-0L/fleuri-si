// Server-only Solana + Meteora DBC adapter. Never holds user keys; builds unsigned SDK transactions
// and reads confirmed chain state. Env is read inside functions (Workers inject at request time).
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveMintMetadata, METAPLEX_PROGRAM_ID, DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { domainHash, b64, utf8, sha256Hex } from "@/pq/canonical";
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
    origin: new URL(process.env["FLEURI_ORIGIN"] || "https://id-preview--bf8617bb-d302-4646-b8c0-e4bb493471e2.lovable.app").origin,
  };
}

export function connection() {
  const e = solEnv();
  if (!e.cluster) throw new Error(`SOLANA_CLUSTER must be "devnet" or "mainnet-beta".`);
  if (!e.rpcUrl) throw new Error("SOLANA_RPC_URL is required for mainnet-beta.");
  return new Connection(e.rpcUrl, {commitment: "confirmed", disableRetryOnRateLimit: true, fetch: (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(15_000)})});
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

export async function buildCreatePoolTx(conn: Connection, p: { config: string; baseMint: string; creator: string; name: string; symbol: string; uri: string }) {
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const creator = new PublicKey(p.creator);
  const baseMint = new PublicKey(p.baseMint);
  const config = new PublicKey(p.config);
  const tx = await client.creator.createPool({ name: p.name, symbol: p.symbol, uri: p.uri, payer: creator, poolCreator: creator, config, baseMint });
  const bh = await conn.getLatestBlockhash("confirmed");
  return finalizeUnsigned(tx, creator, bh, [creator.toBase58(), baseMint.toBase58()]);
}

/** Unsigned SDK createConfig. The wallet pays; the fresh config key (held only in the browser) co-signs. */
export async function buildCreateConfigTx(conn: Connection, p: { config: string; wallet: string; feeClaimer: string; leftoverReceiver: string; params: Record<string, unknown> }) {
  const payer = new PublicKey(p.wallet);
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const tx = await client.partner.createConfig({ ...(p.params as any), config: new PublicKey(p.config), feeClaimer: new PublicKey(p.feeClaimer), leftoverReceiver: new PublicKey(p.leftoverReceiver), quoteMint: new PublicKey(SOL_MINT), payer });
  return finalizeUnsigned(tx, payer, await conn.getLatestBlockhash("confirmed"), [p.wallet, p.config]);
}

/** Simulates without signatures to report the exact lamports the wallet would spend (rent + fee). */
export async function estimateWalletCost(conn: Connection, message: Uint8Array, wallet: string) {
  const { VersionedTransaction, VersionedMessage } = await import("@solana/web3.js");
  const vtx = new VersionedTransaction(VersionedMessage.deserialize(message));
  const [pre, fee, sim] = await Promise.all([
    conn.getBalance(new PublicKey(wallet), "confirmed"),
    conn.getFeeForMessage(VersionedMessage.deserialize(message), "confirmed"),
    conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: [wallet] } }),
  ]);
  if (sim.value.err) return { ok: false as const, balanceLamports: pre, error: `Simulation failed: ${JSON.stringify(sim.value.err)}. ${(sim.value.logs ?? []).slice(-3).join(" | ")}`.slice(0, 400) };
  const post = sim.value.accounts?.[0]?.lamports ?? pre;
  const networkFee = fee.value ?? 0;
  return { ok: true as const, balanceLamports: pre, rentLamports: Math.max(0, pre - post), networkFeeLamports: networkFee, totalLamports: Math.max(0, pre - post) + networkFee };
}

export async function buildMigrationLockerTx(conn: Connection, pool: string, wallet: string) {
  const payer = new PublicKey(wallet);
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const tx = await client.migration.createLocker({ pool: new PublicKey(pool), payer });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  return finalizeUnsigned(tx, payer, await conn.getLatestBlockhash("confirmed"), [wallet]);
}

export function finalizeUnsigned(tx: Transaction, feePayer: PublicKey, bh: { blockhash: string; lastValidBlockHeight: number }, allowedSigners: string[]) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = bh.blockhash;
  const msg = tx.compileMessage();
  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const extra = signers.filter((x) => !allowedSigners.includes(x));
  if (extra.length || signers.length !== new Set(allowedSigners).size) throw new Error(`Transaction requires unexpected signers: ${signers.join(", ")}`);
  if (!tx.instructions.some((i) => i.programId.toBase58() === DBC_PROGRAM_ID || i.programId.equals(MEMO_PROGRAM_ID))) throw new Error("Transaction does not call the expected program.");
  const message = tx.serializeMessage();
  if (tx.serialize({requireAllSignatures: false, verifySignatures: false}).length > 1232) throw new Error("Prepared legacy transaction exceeds the wallet transaction size limit.");
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
  if (!t || !t.meta) return null;
  const message = t.transaction.message;
  const keys = message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  const ixs = message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], data: ix.data, accounts: ix.accountKeyIndexes.map((i) => keys[i]) }));
  const signers = keys.slice(0, message.header.numRequiredSignatures);
  return { slot: t.slot, err: t.meta?.err ?? null, serialized: message.serialize(), ixs, signers };
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

export async function fetchIpfsBytes(uri: string, maxBytes: number) {
  const cid = uri.match(/(?:^ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{46,100})$/)?.[1];
  if (!cid) throw new Error("Not an immutable IPFS content URI.");
  const r = await fetch(solEnv().gateway + cid, {signal: AbortSignal.timeout(15_000)});
  if (!r.ok || !r.body) throw new Error("IPFS content is unavailable.");
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let size=0;
  try { for (;;) { const v=await reader.read(); if (v.done) break; size+=v.value.length; if(size>maxBytes) throw new Error("IPFS document too large."); chunks.push(v.value); } }
  finally { await reader.cancel(); }
  const bytes=new Uint8Array(size); let off=0; for(const c of chunks){bytes.set(c,off);off+=c.length;} return bytes;
}

export async function pinBytes(bytes: Uint8Array, filename: string, mime: string) {
  const { pinataJwt } = solEnv();
  if (!pinataJwt) throw new Error("PINATA_JWT is not configured, so immutable metadata cannot be pinned.");
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${pinataJwt}` }, body: form, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`IPFS pinning failed (${r.status}).`);
  const j = (await r.json()) as { IpfsHash: string };
  if (!/^[A-Za-z0-9]{46,100}$/.test(j.IpfsHash)) throw new Error("Pinning provider returned an invalid content ID.");
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
      conn = connection();
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
  push("damm", "DAMM v2 graduation", "pass", "The migration config is derived from the signed DBC fee option. The actual DAMM v2 pool must exist before graduation is shown as live.");
  const ready = checks.filter((c) => c.id !== "damm").every((c) => c.status === "pass");
  return { cluster: e.cluster ?? e.clusterRaw, rpcSource: e.rpcSource, ready, checks, dbcConfig: e.dbcConfig };
}
