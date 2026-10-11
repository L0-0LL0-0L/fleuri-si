// Test fixtures for research receipts: genuine dual-signed registration + a real saved trial.
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64, utf8 } from "./canonical";
import { CTX_REGISTRATION, pqKeyHash, pqSign, type PqKeypair } from "./mldsa";
import { buildStatement, CHALLENGE_TTL_MS, GENESIS, registrationHash } from "./registration";
import type { IdentityProof } from "./receipt";
import { buildSeed } from "@/domain/seed";
import { contentHash, freezeMarket, inputHash, makeInput, outputHash, runTrial, snapshotPolicy } from "@/domain/greenhouse";

export const DOMAIN = "https://fleuri.test";
export function identityFor(k: PqKeypair, w: Keypair, cluster: "devnet" | "mainnet-beta" = "devnet"): IdentityProof {
  const owner = "11111111-1111-4111-8111-111111111111", now = Date.parse("2026-10-01T00:00:00Z");
  const fields = { domain: DOMAIN, cluster, genesisHash: GENESIS[cluster], ownerId: owner, wallet: w.publicKey.toBase58(), pqKeyHash: pqKeyHash(k.publicKey), challengeId: "22222222-2222-4222-8222-222222222222", nonce: "a".repeat(32), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString() };
  const statement = buildStatement(fields); const msg = utf8(statement);
  return { owner_id: owner, wallet: fields.wallet, cluster, genesis_hash: GENESIS[cluster], public_key: b64(k.publicKey), key_hash: fields.pqKeyHash, statement, registration_hash: registrationHash(statement), wallet_signature: b64(ed25519.sign(msg, w.secretKey.subarray(0, 32))), pq_signature: b64(pqSign(k.secretKey, msg, CTX_REGISTRATION)) };
}
export function runFixture() {
  const s = buildSeed(1_800_000_000_000);
  const agents = Object.values(s.agents).slice(0, 2);
  const input = makeInput({ agentIds: agents.map((a) => a.id), seed: 9, repetitions: 1, cycles: 5, scenarios: ["control", "sell_pressure"] }, freezeMarket(s, 1_800_000_000_000), agents.map(snapshotPolicy));
  const out = runTrial(input); const ih = inputHash(input), oh = outputHash(out);
  return { id: "33333333-3333-4333-8333-333333333333", created_at: "2026-10-11T00:00:00Z", finished_at: "2026-10-11T00:00:02Z", input, output: out, input_hash: ih, output_hash: oh, content_hash: contentHash(ih, oh) };
}
