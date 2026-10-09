// Server-only PQ identity / passport / real-launch business logic. Uses the service-role client
// for writes after the caller is authenticated; never receives private keys.
import { PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { b64, canonicalize, fromB64, hex, sha256Hex, utf8 } from "@/pq/canonical";
import { checkSubmission, mapLifecycle, messageHash } from "@/pq/chain-pure";
import { pqKeyHash } from "@/pq/mldsa";
import { DBC_PROGRAM_ID, SOL_MINT, verifyPassportOffline, type Check, type PassportManifest, PASSPORT_SCHEMA } from "@/pq/passport";
import { CHALLENGE_TTL_MS, GENESIS, anchorMemo, buildStatement, isSolanaAddress, validateRegistration } from "@/pq/registration";
import * as sol from "./solana.server";

const PREP_TTL_MS = 90_000;
const NONCE_TTL_MS = 15 * 60_000;

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}
function must<T>(r: { data: T; error: any }, msg = "Database error") {
  if (r.error) throw new Error(`${msg}: ${r.error.message}`);
  return r.data;
}
function env() {
  const e = sol.solEnv();
  if (!e.cluster) throw new Error("SOLANA_CLUSTER is invalid.");
  return { ...e, cluster: e.cluster };
}

// ---------- identity ----------
export async function issueChallenge(ownerId: string, wallet: string, publicKeyB64: string) {
  if (!isSolanaAddress(wallet)) throw new Error("Invalid Solana wallet address.");
  const pk = fromB64(publicKeyB64);
  if (pk.length !== 1952) throw new Error("ML-DSA-65 public key must be 1952 bytes.");
  const keyHash = pqKeyHash(pk);
  const d = await db();
  const existing = must(await d.from("pq_identities").select("id").eq("key_hash", keyHash).maybeSingle());
  if (existing) throw new Error("This PQ key is already registered.");
  const e = env();
  const id = crypto.randomUUID();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const statement = buildStatement({ domain: e.origin, cluster: e.cluster, genesisHash: GENESIS[e.cluster], ownerId, wallet, pqKeyHash: keyHash, challengeId: id, nonce, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() });
  must(await d.from("pq_challenges").insert({ id, owner_id: ownerId, wallet, pq_key_hash: keyHash, cluster: e.cluster, genesis_hash: GENESIS[e.cluster], nonce, statement, issued_at: issuedAt.toISOString(), expires_at: expiresAt.toISOString() }));
  return { challengeId: id, statement, expiresAt: expiresAt.toISOString() };
}

export async function registerIdentity(ownerId: string, i: { challengeId: string; publicKey: string; walletSignature: string; pqSignature: string }) {
  const d = await db();
  const challenge = must(await d.from("pq_challenges").select("*").eq("id", i.challengeId).maybeSingle());
  const v = validateRegistration({ challenge, ownerId, now: Date.now(), publicKeyB64: i.publicKey, walletSignatureB64: i.walletSignature, pqSignatureB64: i.pqSignature });
  const consumed = must(await d.rpc("consume_pq_challenge", { _id: i.challengeId, _owner: ownerId }));
  if (!consumed || !consumed.id) throw new Error("This challenge was already used or has expired.");
  const row = must(
    await d
      .from("pq_identities")
      .insert({ owner_id: ownerId, wallet: challenge.wallet, cluster: challenge.cluster, genesis_hash: challenge.genesis_hash, public_key: i.publicKey, key_hash: challenge.pq_key_hash, statement: challenge.statement, registration_hash: v.registrationHash, wallet_signature: i.walletSignature, pq_signature: i.pqSignature })
      .select("id,status,registration_hash,key_hash,wallet")
      .single(),
    "Could not save identity",
  );
  return row;
}

async function savePrep(ownerId: string, kind: string, wallet: string, subject: string, built: { message: Uint8Array; lastValidBlockHeight: number }, payload: Record<string, unknown>) {
  const d = await db();
  const row = must(
    await d
      .from("chain_preparations")
      .insert({ owner_id: ownerId, kind, wallet, cluster: env().cluster, subject, message_hash: messageHash(built.message), message_b64: b64(built.message), payload: { ...payload, lastValidBlockHeight: built.lastValidBlockHeight }, expires_at: new Date(Date.now() + PREP_TTL_MS).toISOString() })
      .select("id,expires_at")
      .single(),
  );
  return row;
}

export async function prepareAnchor(ownerId: string, identityId: string) {
  const d = await db();
  const idt = must(await d.from("pq_identities").select("*").eq("id", identityId).maybeSingle());
  if (!idt || idt.owner_id !== ownerId) throw new Error("Identity not found in your workspace.");
  if (idt.status === "anchored") throw new Error("Already anchored.");
  if (idt.cluster !== env().cluster) throw new Error(`Identity was registered for ${idt.cluster}.`);
  const conn = sol.connection();
  await sol.assertGenesis(conn, env().cluster);
  const memo = anchorMemo(idt.registration_hash);
  const built = await sol.buildMemoTx(conn, idt.wallet, memo);
  const prep = await savePrep(ownerId, "anchor", idt.wallet, identityId, built, { memo });
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(built.tx), memo };
}

export async function submitPrepared(ownerId: string, preparationId: string, signedTx: string) {
  const d = await db();
  const prep = must(await d.from("chain_preparations").select("*").eq("id", preparationId).maybeSingle());
  if (!prep || prep.owner_id !== ownerId) throw new Error("Preparation not found.");
  if (prep.submitted_at) throw new Error("This preparation was already submitted.");
  if (Date.parse(prep.expires_at) <= Date.now()) throw new Error("This preparation expired. Prepare again.");
  const raw = checkSubmission({ messageHash: prep.message_hash, messageB64: prep.message_b64 }, signedTx);
  const consumed = must(await d.rpc("consume_preparation", { _id: preparationId, _owner: ownerId, _hash: prep.message_hash }));
  if (!consumed || !consumed.id) throw new Error("This preparation was already used or expired.");
  const conn = sol.connection();
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
  must(await d.from("chain_preparations").update({ signature }).eq("id", preparationId));
  return { signature };
}

/** Idempotent: re-reads the confirmed transaction and records the result once. */
export async function confirmPrepared(ownerId: string, preparationId: string): Promise<{ status: "pending" | "confirmed"; detail: string; id?: string }> {
  const d = await db();
  const prep = must(await d.from("chain_preparations").select("*").eq("id", preparationId).maybeSingle());
  if (!prep || prep.owner_id !== ownerId) throw new Error("Preparation not found.");
  if (!prep.signature) throw new Error("Nothing was submitted for this preparation.");
  const conn = sol.connection();
  const tx = await sol.readConfirmedTx(conn, prep.signature);
  if (!tx) return { status: "pending", detail: "Waiting for confirmation…" };
  if (tx.err) throw new Error(`Transaction failed on chain: ${JSON.stringify(tx.err)}`);
  if (messageHash(tx.serialized) !== prep.message_hash) throw new Error("Confirmed transaction differs from the prepared message.");
  if (!tx.signers.includes(prep.wallet)) throw new Error("Wallet did not sign the confirmed transaction.");

  if (prep.kind === "anchor") {
    const memoIx = tx.ixs.find((x) => x.program === sol.MEMO_PROGRAM_ID.toBase58());
    if (!memoIx || new TextDecoder().decode(memoIx.data) !== prep.payload.memo) throw new Error("Memo does not commit the registration hash.");
    await d.from("pq_identities").update({ status: "anchored", anchor_signature: prep.signature, anchor_slot: tx.slot, anchored_at: new Date().toISOString() }).eq("id", prep.subject).is("anchor_signature", null);
    return { status: "confirmed", detail: `Anchored in slot ${tx.slot}.`, id: prep.subject };
  }
  if (prep.kind === "launch") {
    const existing = must(await d.from("launches").select("id,passport_id").eq("signature", prep.signature).maybeSingle());
    if (existing) return { status: "confirmed", detail: "Already recorded.", id: existing.passport_id };
    const p = prep.payload as any;
    if (!tx.ixs.some((x) => x.program === DBC_PROGRAM_ID)) throw new Error("Confirmed transaction did not call Meteora DBC.");
    const pool = await sol.readPool(conn, p.pool);
    if (!pool) return { status: "pending", detail: "Pool account not visible yet…" };
    if (pool.baseMint !== p.baseMint || pool.config !== p.config || pool.creator !== prep.wallet) throw new Error("On-chain pool does not match the passport terms.");
    const meta = await sol.readTokenMetadata(conn, p.baseMint);
    if (!meta || meta.uri !== p.metadataUri) throw new Error("On-chain metadata URI does not match the pinned passport.");
    if (meta.isMutable) throw new Error("Token metadata is mutable; Fleuri passports require immutable metadata.");
    const passport = must(
      await d.from("passports").upsert({ identity_id: p.identityId, manifest: p.passport.manifest, manifest_hash: p.passport.manifestHash, signature: p.passport.signature, metadata_uri: p.metadataUri, metadata_hash: p.metadataHash, base_mint: p.baseMint, pool: p.pool, cluster: prep.cluster }, { onConflict: "manifest_hash" }).select("id").single(),
    );
    const lifecycle = mapLifecycle(pool);
    await d.from("launches").upsert({ passport_id: passport.id, owner_id: ownerId, creator_wallet: prep.wallet, cluster: prep.cluster, base_mint: p.baseMint, pool: p.pool, config: p.config, signature: prep.signature, slot: tx.slot, lifecycle }, { onConflict: "signature", ignoreDuplicates: true });
    return { status: "confirmed", detail: `Launched in slot ${tx.slot}.`, id: passport.id };
  }
  if (prep.kind === "migrate") {
    const launch = must(await d.from("launches").select("*").eq("id", prep.subject).single());
    await d.from("launches").update({ migration_signature: prep.signature }).eq("id", launch.id).is("migration_signature", null);
    await refreshLifecycle(launch.id);
    return { status: "confirmed", detail: `Migration confirmed in slot ${tx.slot}.`, id: launch.passport_id };
  }
  throw new Error("Unknown preparation kind.");
}

// ---------- launch ----------
async function chainTerms(conn: ReturnType<typeof sol.connection>, configAddr: string) {
  const r = await sol.readDbcConfig(conn, configAddr);
  if (r.problems.length) throw new Error(`DBC config not eligible: ${r.problems.join("; ")}`);
  return r;
}

export async function startLaunch(ownerId: string, identityId: string, baseMint: string) {
  if (!isSolanaAddress(baseMint)) throw new Error("Invalid base mint address.");
  const e = env();
  if (!e.dbcConfig) throw new Error("METEORA_DBC_CONFIG is not configured on the server.");
  const d = await db();
  const idt = must(await d.from("pq_identities").select("*").eq("id", identityId).maybeSingle());
  if (!idt || idt.owner_id !== ownerId) throw new Error("Identity not found in your workspace.");
  if (idt.status !== "anchored") throw new Error("Anchor this identity on chain before launching.");
  const conn = sol.connection();
  const genesis = await sol.assertGenesis(conn, e.cluster);
  const r = await chainTerms(conn, e.dbcConfig);
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  must(await d.from("launch_nonces").insert({ nonce, owner_id: ownerId, identity_id: identityId, expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString() }));
  const template: Omit<PassportManifest, "token"> & { token: Pick<PassportManifest["token"], "baseMint" | "decimals" | "totalSupply"> } = {
    schema: PASSPORT_SCHEMA,
    domain: e.origin,
    cluster: e.cluster,
    genesisHash: genesis,
    dbcProgram: DBC_PROGRAM_ID,
    creatorWallet: idt.wallet,
    identity: { alg: "ML-DSA-65", keyHash: idt.key_hash, registrationHash: idt.registration_hash, anchorSignature: idt.anchor_signature },
    launchNonce: nonce,
    token: { baseMint, decimals: r.terms.decimals, totalSupply: r.terms.totalSupply },
    quote: { mint: SOL_MINT, symbol: "SOL" },
    config: { address: e.dbcConfig, snapshotHash: r.snapshotHash, snapshot: r.snapshot },
    pool: { address: sol.derivePool(baseMint, e.dbcConfig) },
    fees: r.terms.fees,
    lp: r.terms.lp,
    migration: r.terms.migration,
    authority: r.terms.authority,
    devBuy: { enabled: false },
  };
  return { template, expiresAt: new Date(Date.now() + NONCE_TTL_MS).toISOString() };
}

export async function pinImage(dataB64: string, mime: string) {
  const bytes = fromB64(dataB64);
  if (bytes.length > 1_000_000) throw new Error("Image must be at most 1 MB.");
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new Error("Use PNG, JPEG, GIF or WebP.");
  const cid = await sol.pinBytes(bytes, "image", mime);
  return { imageUri: `ipfs://${cid}`, imageSha256: sha256Hex(bytes) };
}

export async function prepareLaunch(ownerId: string, signed: unknown) {
  const off = verifyPassportOffline(signed);
  if (!off.passport || off.checks.some((c) => c.status !== "pass")) throw new Error(off.checks.find((c) => c.status !== "pass")?.detail ?? "Invalid passport.");
  const m = off.passport.manifest;
  const e = env();
  const d = await db();
  const idt = must(await d.from("pq_identities").select("*").eq("key_hash", m.identity.keyHash).maybeSingle());
  if (!idt || idt.owner_id !== ownerId) throw new Error("Passport identity is not yours.");
  if (idt.status !== "anchored" || idt.registration_hash !== m.identity.registrationHash || idt.anchor_signature !== m.identity.anchorSignature) throw new Error("Passport identity does not match the anchored registration.");
  if (idt.public_key !== off.passport.publicKey) throw new Error("Passport key differs from the registered key.");
  if (m.creatorWallet !== idt.wallet) throw new Error("Creator wallet must be the identity's registered wallet.");
  if (m.cluster !== e.cluster || m.domain !== e.origin) throw new Error("Passport cluster/domain does not match this server.");
  const conn = sol.connection();
  const genesis = await sol.assertGenesis(conn, e.cluster);
  const r = await chainTerms(conn, e.dbcConfig!);
  const expected = { genesisHash: genesis, config: { address: e.dbcConfig, snapshotHash: r.snapshotHash, snapshot: r.snapshot }, pool: { address: sol.derivePool(m.token.baseMint, e.dbcConfig!) }, fees: r.terms.fees, lp: r.terms.lp, migration: r.terms.migration, authority: r.terms.authority, decimals: r.terms.decimals, totalSupply: r.terms.totalSupply };
  const got = { genesisHash: m.genesisHash, config: m.config, pool: m.pool, fees: m.fees, lp: m.lp, migration: m.migration, authority: m.authority, decimals: m.token.decimals, totalSupply: m.token.totalSupply };
  if (canonicalize(expected) !== canonicalize(got)) throw new Error("Passport economics differ from the live DBC config. Start the launch again.");
  if (await conn.getAccountInfo(new PublicKey(m.token.baseMint))) throw new Error("Base mint already exists; use a fresh mint keypair.");
  const nonce = must(await d.rpc("consume_launch_nonce", { _nonce: m.launchNonce, _owner: ownerId, _identity: idt.id }));
  if (!nonce || !nonce.nonce) throw new Error("Launch nonce was already used or expired.");
  const gatewayImage = m.token.imageUri.replace("ipfs://", e.gateway);
  const metadataBytes = utf8(canonicalize({ name: m.token.name, symbol: m.token.symbol, image: gatewayImage, description: `Launched with a Fleuri ML-DSA-65 launch passport. Provenance only; not quantum-safe custody.`, external_url: `https://${e.origin}/verify?hash=${off.passport.manifestHash}`, properties: { fleuri_passport: off.passport } }));
  const cid = await sol.pinBytes(metadataBytes, `fleuri-passport-${off.passport.manifestHash.slice(0, 12)}.json`, "application/json");
  const metadataUri = `${e.gateway}${cid}`;
  if (metadataUri.length > 200) throw new Error("Metadata URI too long.");
  const built = await sol.buildCreatePoolTx(conn, { config: e.dbcConfig!, baseMint: m.token.baseMint, creator: m.creatorWallet, name: m.token.name, symbol: m.token.symbol, uri: metadataUri });
  const prep = await savePrep(ownerId, "launch", m.creatorWallet, m.token.baseMint, built, { identityId: idt.id, baseMint: m.token.baseMint, pool: m.pool.address, config: e.dbcConfig, metadataUri, metadataHash: sha256Hex(metadataBytes), passport: off.passport });
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(built.tx), metadataUri, signers: built.signers };
}

export async function refreshLifecycle(launchId: string) {
  const d = await db();
  const l = must(await d.from("launches").select("*").eq("id", launchId).maybeSingle());
  if (!l) throw new Error("Launch not found.");
  const pool = await sol.readPool(sol.connection(), l.pool);
  if (!pool) throw new Error("Pool not readable.");
  const lifecycle = mapLifecycle(pool);
  await d.from("launches").update({ lifecycle, checked_at: new Date().toISOString() }).eq("id", launchId);
  return { lifecycle, quoteReserve: pool.quoteReserve.toString(), threshold: pool.migrationQuoteThreshold.toString() };
}

export async function prepareMigration(ownerId: string, launchId: string) {
  const e = env();
  if (!e.dammV2Config) throw new Error("METEORA_DAMM_V2_CONFIG is not set; manual migration is unavailable (Meteora keepers may still migrate).");
  const d = await db();
  const l = must(await d.from("launches").select("*").eq("id", launchId).maybeSingle());
  if (!l || l.owner_id !== ownerId) throw new Error("Launch not found in your workspace.");
  const st = await refreshLifecycle(launchId);
  if (st.lifecycle === "curve_active") throw new Error("Curve has not reached its migration threshold yet.");
  if (st.lifecycle === "damm_v2_live") throw new Error("Already migrated to DAMM v2.");
  const conn = sol.connection();
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const payer = new PublicKey(l.creator_wallet);
  const res = await client.migration.migrateToDammV2({ payer, pool: new PublicKey(l.pool), dammConfig: new PublicKey(e.dammV2Config) });
  const bh = await conn.getLatestBlockhash("confirmed");
  res.transaction.feePayer = payer;
  res.transaction.recentBlockhash = bh.blockhash;
  const nfts = [res.firstPositionNftKeypair, res.secondPositionNftKeypair];
  const built = sol.finalizeUnsigned(res.transaction, payer, bh, [l.creator_wallet, ...nfts.map((k) => k.publicKey.toBase58())]);
  res.transaction.partialSign(...nfts); // ephemeral position-NFT mints generated by the SDK; not user funds keys
  const prep = await savePrep(ownerId, "migrate", l.creator_wallet, launchId, built, {});
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(res.transaction) };
}

// ---------- public verify ----------
export async function verifyPublic(input: { passport?: unknown; hash?: string }) {
  const d = await db();
  let raw = input.passport;
  let rec: any = null;
  if (!raw && input.hash) {
    rec = must(await d.from("passports").select("*").eq("manifest_hash", input.hash).maybeSingle());
    if (!rec) return { checks: [{ id: "canonical", label: "Canonical payload", status: "fail", detail: "No confirmed passport with that hash." } as Check], passport: null, launch: null };
    const idt = must(await d.from("pq_identities").select("public_key").eq("id", rec.identity_id).single());
    raw = { format: "fleuri.signed-passport/v1", manifest: rec.manifest, manifestHash: rec.manifest_hash, alg: "ML-DSA-65", publicKey: idt.public_key, signature: rec.signature };
  }
  const off = verifyPassportOffline(raw);
  const checks = [...off.checks];
  const add = (id: string, label: string, status: Check["status"], detail: string) => checks.push({ id, label, status, detail });
  if (!off.passport) return { checks, passport: null, launch: null };
  const m = off.passport.manifest;
  rec ??= must(await d.from("passports").select("*").eq("manifest_hash", off.passport.manifestHash).maybeSingle());
  const launch = rec ? must(await d.from("launches").select("*").eq("passport_id", rec.id).maybeSingle()) : null;
  const e = sol.solEnv();
  let conn: ReturnType<typeof sol.connection> | null = null;
  if (e.cluster === m.cluster && e.rpcUrl) {
    try {
      conn = sol.connection();
      await sol.assertGenesis(conn, m.cluster);
      if (m.genesisHash !== GENESIS[m.cluster]) throw new Error("genesis mismatch");
    } catch {
      conn = null;
    }
  }
  const noRpc = e.cluster !== m.cluster ? `This server reads ${e.cluster ?? "no cluster"}, passport is for ${m.cluster}.` : "RPC unavailable.";
  // identity anchor: trust only the registered + chain-anchored identity, not the passport's own key
  const idt = must(await d.from("pq_identities").select("*").eq("key_hash", m.identity.keyHash).maybeSingle());
  if (!idt) add("anchor", "Trusted identity anchor", "fail", "No registered Fleuri identity has this key.");
  else if (idt.public_key !== off.passport.publicKey || idt.registration_hash !== m.identity.registrationHash || idt.wallet !== m.creatorWallet) add("anchor", "Trusted identity anchor", "fail", "Passport key/wallet differs from the registered identity.");
  else if (idt.status !== "anchored" || idt.anchor_signature !== m.identity.anchorSignature) add("anchor", "Trusted identity anchor", "pending", "Identity registered but its SPL Memo anchor is not confirmed.");
  else if (!conn) add("anchor", "Trusted identity anchor", "unavailable", noRpc);
  else {
    const t = await sol.readConfirmedTx(conn, idt.anchor_signature).catch(() => null);
    const memo = t?.ixs.find((x) => x.program === sol.MEMO_PROGRAM_ID.toBase58());
    const ok = !!t && !t.err && t.signers.includes(idt.wallet) && !!memo && new TextDecoder().decode(memo.data) === anchorMemo(idt.registration_hash);
    add("anchor", "Trusted identity anchor", ok ? "pass" : "fail", ok ? `Memo anchor confirmed in slot ${t!.slot}, signed by ${idt.wallet.slice(0, 6)}…` : "Anchor transaction does not commit this registration.");
  }
  // chain terms
  if (!conn) add("terms", "Chain terms (DBC config)", "unavailable", noRpc);
  else {
    try {
      const r = await sol.readDbcConfig(conn, m.config.address);
      add("terms", "Chain terms (DBC config)", r.snapshotHash === m.config.snapshotHash ? "pass" : "fail", r.snapshotHash === m.config.snapshotHash ? "Live config matches the signed snapshot." : "Live config no longer matches the signed snapshot.");
    } catch (err) {
      add("terms", "Chain terms (DBC config)", "fail", (err as Error).message);
    }
  }
  // mint / pool / metadata
  if (!launch) add("onchain", "Mint, pool & metadata", "pending", "No confirmed launch recorded for this passport.");
  else if (!conn) add("onchain", "Mint, pool & metadata", "unavailable", noRpc);
  else {
    const pool = await sol.readPool(conn, launch.pool).catch(() => null);
    const meta = await sol.readTokenMetadata(conn, launch.base_mint).catch(() => null);
    const ok = !!pool && pool.baseMint === m.token.baseMint && pool.config === m.config.address && launch.pool === m.pool.address && !!meta && meta.uri === rec.metadata_uri && !meta.isMutable;
    add("onchain", "Mint, pool & metadata", ok ? "pass" : "fail", ok ? `Pool ${launch.pool.slice(0, 6)}… and immutable metadata match.` : "On-chain pool or metadata does not match.");
    if (pool) {
      const lc = mapLifecycle(pool);
      add("lifecycle", "Graduation state", "pass", { curve_active: "Bonding curve active", curve_completed: "Curve completed — awaiting migration", migration_pending: "Migration to DAMM v2 in progress", damm_v2_live: "Live on DAMM v2" }[lc]);
    }
  }
  if (!checks.some((c) => c.id === "lifecycle")) add("lifecycle", "Graduation state", launch ? "unavailable" : "pending", launch ? noRpc : "Not launched.");
  return { checks, passport: off.passport, launch, metadataUri: rec?.metadata_uri ?? null };
}
