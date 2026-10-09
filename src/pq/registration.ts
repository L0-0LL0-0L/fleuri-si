// Canonical identity registration statement, signed by BOTH the Solana wallet (Ed25519)
// and the ML-DSA-65 key over identical bytes. Pure validation used by the server and tests.
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { canonicalize, concat, fromB64, sha256Hex, utf8 } from "./canonical";
import { CTX_REGISTRATION, PQ_ALG, PUBLIC_KEY_BYTES, pqKeyHash, pqVerify } from "./mldsa";

export const REGISTRATION_SCHEMA = "fleuri.pq-identity-registration/v1";
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;
export type Cluster = keyof typeof GENESIS;

export interface RegistrationFields {
  domain: string;
  cluster: Cluster;
  genesisHash: string;
  ownerId: string;
  wallet: string;
  pqKeyHash: string;
  challengeId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function buildStatement(f: RegistrationFields) {
  const body = {
    schema: REGISTRATION_SCHEMA,
    purpose: "Binds this ML-DSA-65 key to this Solana wallet and Fleuri account for launch provenance only. It does not make Solana custody quantum-safe.",
    alg: PQ_ALG,
    ...f,
  };
  return `Fleuri PQ identity registration\n${canonicalize(body)}`;
}
export const registrationHash = (statement: string) => sha256Hex(concat(utf8("fleuri:pq-registration:v1\n"), utf8(statement)));
export const anchorMemo = (regHash: string) => `fleuri:pqid:v1:${regHash}`;

export function isSolanaAddress(s: string) {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function verifyWalletSignature(wallet: string, message: Uint8Array, sig: Uint8Array) {
  if (sig.length !== 64 || !isSolanaAddress(wallet)) return false;
  try {
    return ed25519.verify(sig, message, bs58.decode(wallet));
  } catch {
    return false;
  }
}

export interface StoredChallenge {
  id: string;
  owner_id: string;
  wallet: string;
  pq_key_hash: string;
  statement: string;
  expires_at: string;
  used_at: string | null;
}

/** Throws a user-safe reason when the submission is not acceptable. Does not consume. */
export function validateRegistration(input: {
  challenge: StoredChallenge | null;
  ownerId: string;
  now: number;
  publicKeyB64: string;
  walletSignatureB64: string;
  pqSignatureB64: string;
}) {
  const c = input.challenge;
  if (!c) throw new Error("Unknown challenge.");
  if (c.owner_id !== input.ownerId) throw new Error("This challenge belongs to a different account.");
  if (c.used_at) throw new Error("This challenge was already used.");
  if (Date.parse(c.expires_at) <= input.now) throw new Error("This challenge has expired. Request a new one.");
  if (input.publicKeyB64.length > 4096 || input.walletSignatureB64.length > 200 || input.pqSignatureB64.length > 6000) throw new Error("Signature or key has an invalid length.");
  const pk = fromB64(input.publicKeyB64);
  if (pk.length !== PUBLIC_KEY_BYTES) throw new Error("ML-DSA-65 public key has the wrong length.");
  if (pqKeyHash(pk) !== c.pq_key_hash) throw new Error("Public key does not match the challenged key.");
  const msg = utf8(c.statement);
  if (!verifyWalletSignature(c.wallet, msg, fromB64(input.walletSignatureB64))) throw new Error("Wallet signature is invalid for this statement.");
  if (!pqVerify(pk, msg, fromB64(input.pqSignatureB64), CTX_REGISTRATION)) throw new Error("ML-DSA-65 possession signature is invalid.");
  return { publicKey: pk, registrationHash: registrationHash(c.statement) };
}
