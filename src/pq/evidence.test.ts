// @vitest-environment node
// Portable evidence: verified entirely from a fixture RPC/IPFS reader, with no database.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64, sha256Hex, utf8 } from "./canonical";
import { CTX_REGISTRATION, generatePqKeypair, pqKeyHash, pqSign, type PqKeypair } from "./mldsa";
import { DBC_PROGRAM_ID, signPassport } from "./passport";
import { anchorMemo, buildStatement, CHALLENGE_TTL_MS, GENESIS, registrationHash } from "./registration";
import { BUNDLE_FORMAT, SYSTEM_PROGRAM, verifyBundle, type EvidenceReader } from "./evidence";
import { manifestFixture } from "./fixtures";
import { Connection, PublicKey } from "@solana/web3.js";
import { createDbcProgram } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { deriveInitAccounts, derivePool } from "./chain-read";

// Genuine SDK/Anchor-encoded initialize_virtual_pool_with_spl_token (built offline; no RPC).
const prog = createDbcProgram(new Connection("http://127.0.0.1:1")).program as any;
async function sdkInitIx(o: { config: string; creator: string; mint: string; pool: string; payer: string; name: string; symbol: string; uri: string; method?: string }) {
  const d = deriveInitAccounts(o.mint, o.pool); const P = (s: string) => new PublicKey(s);
  const ix = await prog.methods[o.method ?? "initializeVirtualPoolWithSplToken"]({ name: o.name, symbol: o.symbol, uri: o.uri }).accountsPartial({
    config: P(o.config), poolAuthority: P(d.poolAuthority), creator: P(o.creator), baseMint: P(o.mint), quoteMint: P("So11111111111111111111111111111111111111112"), pool: P(o.pool), baseVault: P(d.baseVault), quoteVault: P(d.quoteVault), mintMetadata: P(d.mintMetadata), metadataProgram: P("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), payer: P(o.payer), tokenQuoteProgram: P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), tokenProgram: P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), systemProgram: P("11111111111111111111111111111111"),
  }).instruction();
  return { program: ix.programId.toBase58(), data: new Uint8Array(ix.data), accounts: ix.keys.map((k: any) => k.pubkey.toBase58()) };
}

vi.mock("@/integrations/supabase/client.server", () => { throw new Error("database must not be used"); });

let kp: PqKeypair;
beforeAll(() => { kp = generatePqKeypair(); });
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ANCHOR = "3".repeat(88), LAUNCH = "4".repeat(88);

async function world(over: Partial<{ creator: string; config: string; method: string }> = {}) {
  const wallet = Keypair.generate(); const owner = crypto.randomUUID(); const now = Date.now();
  const fields = { domain: "https://fleuri.test", cluster: "devnet" as const, genesisHash: GENESIS.devnet, ownerId: owner, wallet: wallet.publicKey.toBase58(), pqKeyHash: pqKeyHash(kp.publicKey), challengeId: crypto.randomUUID(), nonce: "a".repeat(32), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString() };
  const statement = buildStatement(fields); const msg = utf8(statement); const rh = registrationHash(statement);
  const m = manifestFixture(kp);
  m.creatorWallet = fields.wallet; m.pool.address = derivePool(m.token.baseMint, m.config.address); m.identity.registrationHash = rh; m.identity.anchorSignature = ANCHOR;
  const passport = signPassport(m, kp);
  const metaUri = "ipfs://" + "m".repeat(59);
  const metaBytes = utf8(JSON.stringify({ name: m.token.name, symbol: m.token.symbol, image: m.token.imageUri, properties: { fleuri_passport: passport } }));
  const bundle: any = {
    format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), cluster: "devnet", passport,
    registration: { ownerId: owner, statement, publicKey: b64(kp.publicKey), walletSignature: b64(ed25519.sign(msg, wallet.secretKey.subarray(0, 32))), pqSignature: b64(pqSign(kp.secretKey, msg, CTX_REGISTRATION)), registrationHash: rh },
    anchorSignature: ANCHOR, launchSignature: LAUNCH, metadata: { uri: metaUri, sha256: sha256Hex(metaBytes) }, image: { uri: m.token.imageUri, sha256: null },
  };
  const tx = (signers: string[], ixs: any[]) => ({ status: "ok" as const, tx: { slot: 77, blockTime: 1, err: null, version: 0 as const, serialized: new Uint8Array(), signers, ixs } });
  const init = await sdkInitIx({ config: over.config ?? m.config.address, creator: over.creator ?? fields.wallet, mint: m.token.baseMint, pool: m.pool.address, payer: fields.wallet, name: m.token.name, symbol: m.token.symbol, uri: metaUri, method: over.method });
  const reader: EvidenceReader = {
    genesis: async () => GENESIS.devnet,
    tx: async (s) => s === ANCHOR ? tx([fields.wallet], [{ program: MEMO, accounts: [], data: utf8(anchorMemo(rh)) }])
      : s === LAUNCH ? tx([fields.wallet, m.token.baseMint], [init]) : { status: "missing" },
    dbcConfig: async () => ({ problems: [], terms: { fees: m.fees, lp: m.lp, migration: m.migration, authority: m.authority, decimals: m.token.decimals, totalSupply: m.token.totalSupply }, snapshot: m.config.snapshot, snapshotHash: m.config.snapshotHash }),
    metadata: async () => ({ name: m.token.name, symbol: m.token.symbol, uri: metaUri, isMutable: false, updateAuthority: SYSTEM_PROGRAM }),
    mint: async () => ({ decimals: m.token.decimals, supply: BigInt(m.token.totalSupply), mintAuthority: null, freezeAuthority: null }),
    derivePool,
    derived: deriveInitAccounts,
    pool: async (a) => a === m.pool.address ? { config: m.config.address, baseMint: m.token.baseMint, creator: fields.wallet } : null,
    ipfs: async (u) => { if (u === metaUri) return metaBytes; throw new Error("not pinned"); },
  };
  return { bundle, reader, m, wallet };
}
const status = (r: Awaited<ReturnType<typeof verifyBundle>>, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("portable evidence bundle", () => {
  it("verifies every proof from chain/IPFS fixtures with the database disabled", async () => {
    const { bundle, reader } = await world();
    const r = await verifyBundle(bundle, reader);
    expect(r.checks.filter((c) => c.status !== "pass").map((c) => c.id)).toEqual(["image"]); // no signed image hash in fixture
  });
  it("fails a tampered passport term", async () => {
    const { bundle, reader } = await world(); bundle.passport.manifest.fees.baseFeeBps++;
    expect((await verifyBundle(bundle, reader)).checks.some((c) => c.status === "fail")).toBe(true);
  });
  it("does not trust the bundle's claimed metadata hash", async () => {
    const { bundle, reader } = await world(); bundle.metadata.sha256 = "f".repeat(64);
    expect(status(await verifyBundle(bundle, reader), "metadata")).toBe("fail");
  });
  it("fails a launch transaction not signed by the creator", async () => {
    const { bundle, reader, m } = await world();
    const orig = reader.tx; reader.tx = async (s) => { const r = await orig(s); if (s === LAUNCH && r.status === "ok") r.tx.signers = [Keypair.generate().publicKey.toBase58(), m.token.baseMint]; return r; };
    expect(status(await verifyBundle(bundle, reader), "transaction")).toBe("fail");
  });
  it("fails an anchor signature that differs from the signed passport", async () => {
    const { bundle, reader } = await world(); bundle.anchorSignature = "5".repeat(88);
    expect(status(await verifyBundle(bundle, reader), "anchor")).toBe("fail");
  });
  it("marks the wrong network as fail and leaves chain facts unavailable", async () => {
    const { bundle, reader } = await world(); reader.genesis = async () => GENESIS["mainnet-beta"];
    const r = await verifyBundle(bundle, reader);
    expect(status(r, "network")).toBe("fail"); expect(status(r, "transaction")).toBe("unavailable"); expect(status(r, "terms")).toBe("unavailable");
  });
  it("reports unsupported transaction versions and RPC errors as unavailable, never pass or fail", async () => {
    const { bundle, reader } = await world();
    reader.tx = async () => ({ status: "unsupported", reason: "Transaction version (1) is not supported" });
    reader.dbcConfig = async () => { throw new Error("429 rate limited"); };
    const r = await verifyBundle(bundle, reader);
    expect(status(r, "anchor")).toBe("unavailable"); expect(status(r, "transaction")).toBe("unavailable"); expect(status(r, "terms")).toBe("unavailable");
  });
  it("rejects other DBC instructions and wrong positional creator/config", async () => {
    for (const over of [{ method: "initializeVirtualPoolWithToken2022" }, { creator: Keypair.generate().publicKey.toBase58() }, { config: Keypair.generate().publicKey.toBase58() }]) {
      const { bundle, reader } = await world(over);
      expect(status(await verifyBundle(bundle, reader), "transaction")).toBe("fail");
    }
  });
  it("fails missing or foreign-owned pool accounts and tolerates a later creator change", async () => {
    const a = await world(); a.reader.pool = async () => null;
    expect(status(await verifyBundle(a.bundle, a.reader), "poolstate")).toBe("fail");
    const b = await world(); b.reader.pool = async () => { throw new Error("Pool account is not owned by Meteora DBC."); };
    expect(status(await verifyBundle(b.bundle, b.reader), "poolstate")).toBe("fail");
    const c = await world(); const orig = c.reader.pool; c.reader.pool = async (x) => ({ ...(await orig(x))!, creator: Keypair.generate().publicKey.toBase58() });
    const r = await verifyBundle(c.bundle, c.reader); expect(status(r, "poolstate")).toBe("pass"); expect(status(r, "transaction")).toBe("pass");
  });
  it("bounds gateway downloads while streaming", async () => {
    const { readBounded } = await import("./evidence");
    const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }));
    await expect(readBounded(big, 4096)).rejects.toThrow(/too large/);
    expect((await readBounded(new Response(new Uint8Array(10)), 100)).length).toBe(10);
  });
  it("fails when retained mint authority is observed on chain", async () => {
    const { bundle, reader } = await world(); reader.mint = async () => ({ decimals: 9, supply: 1n, mintAuthority: Keypair.generate().publicKey.toBase58(), freezeAuthority: null });
    expect(status(await verifyBundle(bundle, reader), "onchain")).toBe("fail");
  });
});
