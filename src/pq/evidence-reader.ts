// Builds an EvidenceReader from any Solana RPC + IPFS gateway. Used by the browser verifier
// (direct to the caller's RPC; credentials never reach Fleuri) and the CLI.
import { Connection } from "@solana/web3.js";
import { deriveInitAccounts, readPoolLinks, derivePool, readConfirmedTxEx, readDbcConfig, readTokenMetadata, readTokenMint } from "./chain-read";
import { gatewayFetch, type EvidenceReader } from "./evidence";

export function connectionReader(conn: Connection, gateway: string): EvidenceReader {
  return {
    genesis: () => conn.getGenesisHash(),
    tx: (s) => readConfirmedTxEx(conn, s),
    dbcConfig: (a) => readDbcConfig(conn, a),
    metadata: (m) => readTokenMetadata(conn, m),
    mint: (m) => readTokenMint(conn, m),
    derivePool,
    pool: (a) => readPoolLinks(conn, a),
    derived: deriveInitAccounts,
    ipfs: (u, max) => gatewayFetch(gateway, u, max),
  };
}

export function rpcConnection(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error("RPC URL must be https.");
  return new Connection(u.href, { commitment: "confirmed", disableRetryOnRateLimit: true });
}
