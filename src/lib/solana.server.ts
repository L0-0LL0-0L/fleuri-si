// Server-only Solana + Meteora DBC adapter. Never holds user keys; builds unsigned SDK transactions
// and reads confirmed chain state. Env is read inside functions (Workers inject at request time).
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveMintMetadata, METAPLEX_PROGRAM_ID, DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { domainHash, b64, utf8, sha256Hex } from "@/pq/canonical";
import { DBC_PROGRAM_ID, SOL_MINT } from "@/pq/passport";
import { GENESIS, type Cluster } from "@/pq/registration";
import type { Check } from "@/pq/passport";

export { snapshotConfig, readDbcConfig, readConfirmedTx, readConfirmedTxEx, readPool, readTokenMetadata, decodeTokenMetadata, readTokenMint, derivePool } from "@/pq/chain-read";
import { readDbcConfig } from "@/pq/chain-read";

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
  // Simulated post-balance of the payer: account rent plus whatever the RPC deducts for fees.
  return { ok: true as const, balanceLamports: pre, simulatedChangeLamports: Math.max(0, pre - post), networkFeeLamports: networkFee };
}

export async function buildMigrationLockerTx(conn: Connection, pool: string, wallet: string) {
  const payer = new PublicKey(wallet);
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const tx = await client.migration.createLocker({ pool: new PublicKey(pool), payer });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  return finalizeUnsigned(tx, payer, await conn.getLatestBlockhash("confirmed"), [wallet]);
}

export function finalizeUnsigned(tx: Transaction, feePayer: PublicKey, bh: { blockhash: string; lastValidBlockHeight: number }, allowedSigners: string[], programs: string[] = [DBC_PROGRAM_ID, MEMO_PROGRAM_ID.toBase58()]) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = bh.blockhash;
  const msg = tx.compileMessage();
  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const extra = signers.filter((x) => !allowedSigners.includes(x));
  if (extra.length || signers.length !== new Set(allowedSigners).size) throw new Error(`Transaction requires unexpected signers: ${signers.join(", ")}`);
  if (!tx.instructions.some((i) => programs.includes(i.programId.toBase58()))) throw new Error("Transaction does not call the expected program.");
  const message = tx.serializeMessage();
  if (tx.serialize({requireAllSignatures: false, verifySignatures: false}).length > 1232) throw new Error("Prepared legacy transaction exceeds the wallet transaction size limit.");
  return { tx, message, lastValidBlockHeight: bh.lastValidBlockHeight, signers };
}


export async function buildMemoTx(conn: Connection, wallet: string, memo: string) {
  const w = new PublicKey(wallet);
  const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: w, isSigner: true, isWritable: false }], data: Buffer.from(utf8(memo)) }));
  const bh = await conn.getLatestBlockhash("confirmed");
  return finalizeUnsigned(tx, w, bh, [wallet]);
}

export const unsignedB64 = (tx: Transaction) => b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));



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
