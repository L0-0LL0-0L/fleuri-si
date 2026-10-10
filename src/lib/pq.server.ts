// Server-only PQ identity / passport / real-launch business logic. Uses the service-role client
// for writes after the caller is authenticated; never receives private keys.
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DynamicBondingCurveClient, DAMM_V2_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { b64, canonicalize, fromB64, hex, sha256Hex, utf8 } from "@/pq/canonical";
import { checkSubmission, mapLifecycle, messageHash, needsMigrationLocker } from "@/pq/chain-pure";
import { pqKeyHash } from "@/pq/mldsa";
import { DBC_PROGRAM_ID, SOL_MINT, verifyPassportOffline, type Check, type PassportManifest, PASSPORT_SCHEMA } from "@/pq/passport";
import { CHALLENGE_TTL_MS, GENESIS, anchorMemo, buildStatement, isSolanaAddress, validateRegistration, validateIdentityProof, registrationHash } from "@/pq/registration";
import * as sol from "./solana.server";
import { compareConfig, expectedTerms, parseDraft } from "@/pq/config-draft";
import { buildConfigParams } from "@/pq/config-build";

const PREP_TTL_MS = 90_000;
const NONCE_TTL_MS = 15 * 60_000;

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}
function must(r: { data: any; error: any }, msg = "Database error"): any {
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
  if (challenge?.used_at && challenge.owner_id === ownerId) {
    const existing = must(await d.from("pq_identities").select("*").eq("registration_hash", registrationHash(challenge.statement)).maybeSingle());
    if (!existing || existing.owner_id !== ownerId || existing.public_key !== i.publicKey) throw new Error("This challenge was already used.");
    validateIdentityProof({...existing, wallet_signature: i.walletSignature, pq_signature: i.pqSignature});
    return existing;
  }
  const v = validateRegistration({ challenge, ownerId, now: Date.now(), publicKeyB64: i.publicKey, walletSignatureB64: i.walletSignature, pqSignatureB64: i.pqSignature });
  const row = must(await d.rpc("register_pq_identity", {_challenge: i.challengeId, _owner: ownerId, _proof: {...i, registrationHash: v.registrationHash}}), "Could not save identity");
  return row;
}

async function savePrep(ownerId: string, kind: string, wallet: string, subject: string, built: {tx: Transaction; message: Uint8Array; lastValidBlockHeight: number}, payload: Record<string, unknown>) {
  const d = await db();
  const row = must(
    await d
      .from("chain_preparations")
      .insert({ owner_id: ownerId, kind, wallet, cluster: env().cluster, subject, message_hash: messageHash(built.message), message_b64: b64(built.message), transaction_b64: sol.unsignedB64(built.tx), payload: { ...payload, lastValidBlockHeight: built.lastValidBlockHeight }, expires_at: new Date(Date.now() + PREP_TTL_MS).toISOString() })
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
  if (prep.cluster !== env().cluster) throw new Error(`Preparation is for ${prep.cluster}, not this server's current cluster.`);
  const raw = checkSubmission({ messageHash: prep.message_hash, messageB64: prep.message_b64 }, signedTx);
  const signature = bs58.encode(Transaction.from(raw).signature!);
  const conn = sol.connection();
  await sol.assertGenesis(conn, prep.cluster);
  if (!prep.submitted_at && (Date.parse(prep.expires_at) <= Date.now() || await conn.getBlockHeight("confirmed") > prep.payload.lastValidBlockHeight)) throw new Error("Preparation expired. Start again before signing a new transaction.");
  const claimed = must(await d.rpc("claim_chain_submission", {_id: preparationId, _owner: ownerId, _hash: prep.message_hash, _signature: signature, _transaction: b64(raw)}));
  if (!claimed?.id) throw new Error("Could not claim this exact transaction.");
  const prior = await sol.readConfirmedTx(conn, signature);
  if (!prior) {
    if (await conn.getBlockHeight("confirmed") > prep.payload.lastValidBlockHeight) throw new Error("Blockhash expired. Check confirmation before starting again.");
    const sent = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
    if (sent !== signature) throw new Error("RPC returned a different transaction signature.");
  }
  return { signature };
}

export async function retryPrepared(ownerId: string, preparationId: string) {
  const d=await db(); const prep=must(await d.from("chain_preparations").select("*").eq("id",preparationId).maybeSingle());
  if (!prep || prep.owner_id!==ownerId || !prep.signed_transaction_b64) throw new Error("No signed transaction to retry in this workspace.");
  return submitPrepared(ownerId,preparationId,prep.signed_transaction_b64);
}

/** Idempotent: re-reads the confirmed transaction and records the result once. */
export async function confirmPrepared(ownerId: string, preparationId: string): Promise<{ status: "pending" | "confirmed"; detail: string; id?: string }> {
  const d = await db();
  const prep = must(await d.from("chain_preparations").select("*").eq("id", preparationId).maybeSingle());
  if (!prep || prep.owner_id !== ownerId) throw new Error("Preparation not found.");
  if (!prep.signature) throw new Error("Nothing was submitted for this preparation.");
  if (prep.cluster !== env().cluster) throw new Error("Preparation belongs to a different cluster.");
  const conn = sol.connection();
  await sol.assertGenesis(conn, prep.cluster);
  const tx = await sol.readConfirmedTx(conn, prep.signature);
  if (!tx) return { status: "pending", detail: "Waiting for confirmation…" };
  if (messageHash(tx.serialized) !== prep.message_hash) throw new Error("Confirmed transaction differs from the prepared message.");
  if (!tx.signers.includes(prep.wallet)) throw new Error("Wallet did not sign the confirmed transaction.");
  if (tx.err) {
    // Confirmation is terminal even when the chain reports failure. Keep the
    // signed audit record, clear the pending queue, and never publish a launch.
    must(await d.from("chain_preparations").update({confirmed_at:new Date().toISOString(),payload:{...prep.payload,confirmationError:tx.err}}).eq("id",preparationId).eq("owner_id",ownerId));
    throw new Error(`Transaction failed on chain: ${JSON.stringify(tx.err)}`);
  }

  if (prep.kind === "anchor") {
    const memoIx = tx.ixs.find((x) => x.program === sol.MEMO_PROGRAM_ID.toBase58());
    if (!memoIx || new TextDecoder().decode(memoIx.data) !== prep.payload.memo) throw new Error("Memo does not commit the registration hash.");
    must(await d.from("pq_identities").update({ status: "anchored", anchor_signature: prep.signature, anchor_slot: tx.slot, anchored_at: new Date().toISOString() }).eq("id", prep.subject).eq("owner_id",ownerId).is("anchor_signature", null));
    must(await d.from("chain_preparations").update({confirmed_at: new Date().toISOString()}).eq("id",preparationId));
    return { status: "confirmed", detail: `Anchored in slot ${tx.slot}.`, id: prep.subject };
  }
  if (prep.kind === "launch") {
    const p = prep.payload as any;
    if (!tx.ixs.some((x) => x.program === DBC_PROGRAM_ID)) throw new Error("Confirmed transaction did not call Meteora DBC.");
    const pool = await sol.readPool(conn, p.pool);
    if (!pool) return { status: "pending", detail: "Pool account not visible yet…" };
    if (pool.baseMint !== p.baseMint || pool.config !== p.config || pool.creator !== prep.wallet) throw new Error("On-chain pool does not match the passport terms.");
    const meta = await sol.readTokenMetadata(conn, p.baseMint);
    if (!meta || meta.uri !== p.metadataUri || meta.name !== p.passport.manifest.token.name || meta.symbol !== p.passport.manifest.token.symbol || meta.isMutable || meta.updateAuthority !== PublicKey.default.toBase58()) throw new Error("On-chain immutable metadata does not match the passport.");
    const mint = await sol.readTokenMint(conn,p.baseMint);
    const m = p.passport.manifest;
    if (mint.decimals !== m.token.decimals || mint.supply > BigInt(m.token.totalSupply) || mint.mintAuthority || mint.freezeAuthority) throw new Error("Mint supply, decimals or authorities differ from the signed policy.");
    const config = await chainTerms(conn,p.config);
    assertConfigTerms(config,m);
    const lifecycle = mapLifecycle(pool);
    const passportId = must(await d.rpc("record_launch_confirmation",{_id:preparationId,_owner:ownerId,_slot:tx.slot,_lifecycle:lifecycle}));
    return { status: "confirmed", detail: `Launched in slot ${tx.slot}.`, id: passportId };
  }
  if (prep.kind === "migrate") {
    const launch = must(await d.from("launches").select("*").eq("id", prep.subject).single());
    if (launch.owner_id !== ownerId || launch.creator_wallet !== prep.wallet) throw new Error("Migration belongs to another owner or wallet.");
    if (!tx.ixs.some((x) => x.program === DBC_PROGRAM_ID)) throw new Error("Confirmed migration transaction did not call Meteora DBC.");
    if (prep.payload.stage === "locker") {
      const pool = await sol.readPool(conn, launch.pool);
      if (!pool || pool.migrationProgress < 2) return { status: "pending", detail: "Vesting escrow transaction confirmed; waiting for pool state…" };
      if (pool.baseMint !== launch.base_mint || pool.config !== launch.config || pool.creator !== prep.wallet) throw new Error("Vesting pool differs from the launch.");
      must(await d.from("chain_preparations").update({ confirmed_at: new Date().toISOString() }).eq("id", preparationId));
      return { status: "confirmed", detail: "Vesting escrow confirmed. Select Migrate again to create the DAMM v2 pool.", id: launch.passport_id };
    }
    must(await d.from("launches").update({ migration_signature: prep.signature }).eq("id", launch.id).is("migration_signature", null));
    const refreshed=await refreshLifecycle(launch.id);
    if(refreshed.lifecycle!=="damm_v2_live") return {status:"pending",detail:"Migration submitted; waiting for the actual DAMM v2 pool."};
    must(await d.from("chain_preparations").update({confirmed_at: new Date().toISOString()}).eq("id",preparationId));
    return { status: "confirmed", detail: `Migration confirmed in slot ${tx.slot}.`, id: launch.passport_id };
  }
  if (prep.kind === "config") {
    if (!tx.ixs.some((x) => x.program === DBC_PROGRAM_ID)) throw new Error("Confirmed config transaction did not call Meteora DBC.");
    if (!tx.signers.includes(prep.subject)) throw new Error("The prepared config key did not sign the confirmed transaction.");
    const r = await sol.readDbcConfig(conn, prep.subject);
    const issues = [...r.problems, ...compareConfig(r.terms as any, prep.payload.expected)];
    if (issues.length) throw new Error(`Confirmed config differs from the reviewed terms: ${issues.join("; ")}`);
    must(await d.from("chain_preparations").update({ confirmed_at: new Date().toISOString(), payload: { ...prep.payload, verifiedSlot: tx.slot, snapshotHash: r.snapshotHash } }).eq("id", preparationId).eq("owner_id", ownerId));
    return { status: "confirmed", detail: `Config ${prep.subject} confirmed in slot ${tx.slot} and matches every reviewed term.`, id: prep.subject };
  }
  throw new Error("Unknown preparation kind.");
}

// ---------- DBC config creation ----------
/** Prepares an SDK createConfig. Recipients come only from the owner's reviewed draft. */
export async function prepareConfig(ownerId: string, input: { wallet: string; config: string; draft: unknown }) {
  if (!isSolanaAddress(input.wallet) || !isSolanaAddress(input.config)) throw new Error("Invalid wallet or config address.");
  if (input.wallet === input.config) throw new Error("The config key must be a fresh key, not your wallet.");
  const draft = parseDraft(input.draft);
  const e = env();
  const conn = sol.connection();
  await sol.assertGenesis(conn, e.cluster);
  if (await conn.getAccountInfo(new PublicKey(input.config))) throw new Error("That config address already exists. Generate a fresh key.");
  const params = buildConfigParams(draft);
  const expected = expectedTerms(draft, params);
  const built = await sol.buildCreateConfigTx(conn, { config: input.config, wallet: input.wallet, feeClaimer: draft.feeClaimer, leftoverReceiver: draft.leftoverReceiver, params });
  const cost = await sol.estimateWalletCost(conn, built.message, input.wallet);
  const prep = await savePrep(ownerId, "config", input.wallet, input.config, built, { draft, expected });
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(built.tx), cluster: e.cluster, config: input.config, expected, cost };
}

// ---------- launch ----------
async function chainTerms(conn: ReturnType<typeof sol.connection>, configAddr: string) {
  const r = await sol.readDbcConfig(conn, configAddr);
  if (r.problems.length) throw new Error(`DBC config not eligible: ${r.problems.join("; ")}`);
  return r;
}

export function assertConfigTerms(r: Awaited<ReturnType<typeof sol.readDbcConfig>>, m: PassportManifest) {
  const expected = {config:{address:m.config.address,snapshotHash:r.snapshotHash,snapshot:r.snapshot},fees:r.terms.fees,lp:r.terms.lp,migration:r.terms.migration,authority:r.terms.authority,decimals:r.terms.decimals,totalSupply:r.terms.totalSupply};
  const got = {config:m.config,fees:m.fees,lp:m.lp,migration:m.migration,authority:m.authority,decimals:m.token.decimals,totalSupply:m.token.totalSupply};
  if(r.problems.length || canonicalize(expected)!==canonicalize(got)) throw new Error("Signed economics or authority policy differ from the on-chain DBC config.");
}

async function assertIdentityAnchor(conn: ReturnType<typeof sol.connection>, i: any, domain?: string) {
  validateIdentityProof(i,domain);
  if(i.status!=="anchored" || !i.anchor_signature) throw new Error("Identity is not anchored.");
  const t=await sol.readConfirmedTx(conn,i.anchor_signature);
  if(!t) throw new Error("Identity anchor transaction is unavailable.");
  const memo=t.ixs.find(x=>x.program===sol.MEMO_PROGRAM_ID.toBase58());
  if(t.err || !t.signers.includes(i.wallet) || !memo || new TextDecoder().decode(memo.data)!==anchorMemo(i.registration_hash)) throw new Error("Invalid identity anchor transaction.");
  return t;
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
  if(idt.cluster!==e.cluster) throw new Error("Identity is registered on another cluster.");
  await assertIdentityAnchor(conn,idt,e.origin);
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

export function validateImage(bytes:Uint8Array,mime:string) {
  if(bytes.length===0 || bytes.length>1_000_000) throw new Error("Image must be between 1 byte and 1 MB.");
  const starts=(a:number[])=>a.every((n,i)=>bytes[i]===n);
  const text=(start:number,end:number)=>new TextDecoder().decode(bytes.subarray(start,end));
  const valid = mime==="image/png"?starts([137,80,78,71,13,10,26,10]):mime==="image/jpeg"?starts([255,216,255]):mime==="image/gif"?["GIF87a","GIF89a"].includes(text(0,6)):mime==="image/webp"?text(0,4)==="RIFF"&&text(8,12)==="WEBP":false;
  if(!valid) throw new Error("Image contents must match PNG, JPEG, GIF or WebP.");
}
export async function pinImage(dataB64: string, mime: string) {
  const bytes = fromB64(dataB64);
  validateImage(bytes,mime);
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
  const nonce = must(await d.from("launch_nonces").select("*").eq("nonce",m.launchNonce).eq("owner_id",ownerId).eq("identity_id",idt.id).maybeSingle());
  if(!nonce) throw new Error("Unknown launch nonce or wrong owner.");
  if(nonce.used_at) {
    const cached=must(await d.from("chain_preparations").select("*").eq("id",nonce.preparation_id).eq("owner_id",ownerId).maybeSingle());
    if(!cached || canonicalize(cached.payload.passport)!==canonicalize(off.passport)) throw new Error("Launch nonce was used for different terms.");
    if(!cached.submitted_at && Date.parse(cached.expires_at)<=Date.now()) throw new Error("Preparation expired. Rebuild this unsigned draft.");
    return {preparationId:cached.id,expiresAt:cached.expires_at,transaction:cached.transaction_b64,metadataUri:cached.payload.metadataUri,signers:[m.creatorWallet,m.token.baseMint]};
  }
  if(Date.parse(nonce.expires_at)<=Date.now()) throw new Error("Launch nonce expired. Rebuild this unsigned draft.");
  const conn = sol.connection();
  const genesis = await sol.assertGenesis(conn, e.cluster);
  await assertIdentityAnchor(conn,idt,m.domain);
  const r = await chainTerms(conn, e.dbcConfig!);
  const expected = { genesisHash: genesis, config: { address: e.dbcConfig, snapshotHash: r.snapshotHash, snapshot: r.snapshot }, pool: { address: sol.derivePool(m.token.baseMint, e.dbcConfig!) }, fees: r.terms.fees, lp: r.terms.lp, migration: r.terms.migration, authority: r.terms.authority, decimals: r.terms.decimals, totalSupply: r.terms.totalSupply };
  const got = { genesisHash: m.genesisHash, config: m.config, pool: m.pool, fees: m.fees, lp: m.lp, migration: m.migration, authority: m.authority, decimals: m.token.decimals, totalSupply: m.token.totalSupply };
  if (canonicalize(expected) !== canonicalize(got)) throw new Error("Passport economics differ from the live DBC config. Start the launch again.");
  if (await conn.getAccountInfo(new PublicKey(m.token.baseMint))) throw new Error("Base mint already exists; use a fresh mint keypair.");
  const gatewayImage = m.token.imageUri.replace("ipfs://", e.gateway);
  const metadataBytes = utf8(canonicalize({ name: m.token.name, symbol: m.token.symbol, image: gatewayImage, description: `Launched with a Fleuri ML-DSA-65 launch passport. Provenance only; not quantum-safe custody.`, external_url: `${e.origin}/passport/${off.passport.manifestHash}`, ...(m.token.website?{website:m.token.website}:{}), ...(m.token.twitter?{twitter:m.token.twitter}:{}), properties: { fleuri_passport: off.passport } }));
  const cid = await sol.pinBytes(metadataBytes, `fleuri-passport-${off.passport.manifestHash.slice(0, 12)}.json`, "application/json");
  const metadataUri = `${e.gateway}${cid}`;
  if (metadataUri.length > 200) throw new Error("Metadata URI too long.");
  const built = await sol.buildCreatePoolTx(conn, { config: e.dbcConfig!, baseMint: m.token.baseMint, creator: m.creatorWallet, name: m.token.name, symbol: m.token.symbol, uri: metadataUri });
  const payload={identityId:idt.id,baseMint:m.token.baseMint,pool:m.pool.address,config:e.dbcConfig,metadataUri,metadataHash:sha256Hex(metadataBytes),passport:off.passport,lastValidBlockHeight:built.lastValidBlockHeight};
  const prep=must(await d.rpc("create_launch_preparation",{_owner:ownerId,_nonce:m.launchNonce,_identity:idt.id,_row:{wallet:m.creatorWallet,cluster:e.cluster,subject:m.token.baseMint,message_hash:messageHash(built.message),message_b64:b64(built.message),transaction_b64:sol.unsignedB64(built.tx),payload,expires_at:new Date(Date.now()+PREP_TTL_MS).toISOString()}}));
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: prep.transaction_b64, metadataUri: prep.payload.metadataUri, signers: built.signers };
}

export async function refreshLifecycle(launchId: string) {
  const d = await db();
  const l = must(await d.from("launches").select("*").eq("id", launchId).maybeSingle());
  if (!l) throw new Error("Launch not found.");
  if(l.cluster!==env().cluster) throw new Error("Launch belongs to another cluster.");
  const conn=sol.connection(); await sol.assertGenesis(conn,l.cluster);
  const pool = await sol.readPool(conn, l.pool);
  if (!pool) throw new Error("Pool not readable.");
  const lifecycle = mapLifecycle(pool);
  must(await d.from("launches").update({ lifecycle, damm_v2_pool:pool.dammV2Confirmed?pool.dammV2Pool:null, checked_at: new Date().toISOString() }).eq("id", launchId));
  return { lifecycle, quoteReserve: pool.quoteReserve.toString(), threshold: pool.migrationQuoteThreshold.toString() };
}

export async function prepareMigration(ownerId: string, launchId: string) {
  const e = env();
  const d = await db();
  const l = must(await d.from("launches").select("*").eq("id", launchId).maybeSingle());
  if (!l || l.owner_id !== ownerId) throw new Error("Launch not found in your workspace.");
  const st = await refreshLifecycle(launchId);
  if (st.lifecycle === "curve_active") throw new Error("Curve has not reached its migration threshold yet.");
  if (st.lifecycle === "damm_v2_live") throw new Error("Already migrated to DAMM v2.");
  const conn = sol.connection();
  await sol.assertGenesis(conn,e.cluster);
  const poolState=await sol.readPool(conn,l.pool);
  if (!poolState || poolState.baseMint !== l.base_mint || poolState.config !== l.config || poolState.creator !== l.creator_wallet) throw new Error("Pool differs from the confirmed launch.");
  const config = await sol.readDbcConfig(conn, l.config);
  if (config.problems.length) throw new Error(`DBC config not eligible: ${config.problems.join("; ")}`);
  if (needsMigrationLocker(config.cfg, poolState.migrationProgress)) {
    const built = await sol.buildMigrationLockerTx(conn, l.pool, l.creator_wallet);
    const prep = await savePrep(ownerId, "migrate", l.creator_wallet, launchId, built, { stage: "locker" });
    return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(built.tx), stage: "locker" as const };
  }
  const dammConfig=e.dammV2Config || poolState?.dammConfig;
  if(!dammConfig || dammConfig!==poolState?.dammConfig) throw new Error("DAMM v2 config must match the DBC migration fee option.");
  const configAccount=await conn.getAccountInfo(new PublicKey(dammConfig));
  if(!configAccount?.owner.equals(DAMM_V2_PROGRAM_ID)) throw new Error("DAMM v2 config is unavailable on this cluster.");
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const payer = new PublicKey(l.creator_wallet);
  const res = await client.migration.migrateToDammV2({ payer, pool: new PublicKey(l.pool), dammConfig: new PublicKey(dammConfig) });
  const bh = await conn.getLatestBlockhash("confirmed");
  res.transaction.feePayer = payer;
  res.transaction.recentBlockhash = bh.blockhash;
  const nfts = [res.firstPositionNftKeypair, res.secondPositionNftKeypair];
  const built = sol.finalizeUnsigned(res.transaction, payer, bh, [l.creator_wallet, ...nfts.map((k) => k.publicKey.toBase58())]);
  res.transaction.partialSign(...nfts); // ephemeral position-NFT mints generated by the SDK; not user funds keys
  const prep = await savePrep(ownerId, "migrate", l.creator_wallet, launchId, built, {});
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(res.transaction), stage: "pool" as const };
}

// ---------- public verify ----------
export async function verifyPublic(input: { passport?: unknown; hash?: string }) {
  const d = await db();
  let raw = input.passport;
  let rec: any = null;
  if (raw === undefined && input.hash) {
    rec = must(await d.from("passports").select("*").eq("manifest_hash", input.hash).maybeSingle());
    if (!rec) return {checks: [{id:"canonical",label:"Confirmed passport",status:"fail",detail:"No confirmed passport with that hash."} as Check],passport:null,launch:null};
    const key = must(await d.from("pq_identities").select("public_key").eq("id", rec.identity_id).single());
    raw = {format:"fleuri.signed-passport/v1",manifest:rec.manifest,manifestHash:rec.manifest_hash,alg:"ML-DSA-65",publicKey:key.public_key,signature:rec.signature};
  }
  const off = verifyPassportOffline(raw);
  const checks = [...off.checks];
  const add = (id:string,label:string,status:Check["status"],detail:string) => checks.push({id,label,status,detail});
  if (!off.passport || checks.some(c=>c.status!=="pass")) return {checks,passport:off.passport,launch:null};
  const signed = off.passport;
  const m = signed.manifest;
  rec ??= must(await d.from("passports").select("*").eq("manifest_hash", signed.manifestHash).maybeSingle());
  const launch = rec ? must(await d.from("launches").select("*").eq("passport_id",rec.id).maybeSingle()) : null;
  const identity = must(await d.from("pq_identities").select("*").eq("key_hash",m.identity.keyHash).maybeSingle());
  let proofValid=false;
  try {
    if (!identity) throw new Error("No registered Fleuri identity has this key.");
    validateIdentityProof(identity,m.domain);
    if (identity.public_key!==signed.publicKey || identity.registration_hash!==m.identity.registrationHash || identity.wallet!==m.creatorWallet || identity.cluster!==m.cluster) throw new Error("Registered wallet, key, network or domain differs from the passport.");
    proofValid=true;
    add("registration","Dual-signature registration","pass","Both the Solana wallet and the independent ML-DSA-65 key signed the same registration statement.");
  } catch(e) { add("registration","Dual-signature registration","fail",(e as Error).message); }
  const e=sol.solEnv();
  let conn: ReturnType<typeof sol.connection>|null=null;
  let unavailable = e.cluster!==m.cluster ? `Server reads ${e.cluster ?? "no network"}; this passport is for ${m.cluster}.` : "RPC unavailable.";
  try {
    if(e.cluster===m.cluster && e.rpcUrl) { conn=sol.connection(); await sol.assertGenesis(conn,m.cluster); }
  } catch(err) {conn=null; unavailable=(err as Error).message;}
  if(!proofValid) add("anchor","Confirmed identity anchor","fail","Registration proof is invalid.");
  else if(identity.status!=="anchored" || identity.anchor_signature!==m.identity.anchorSignature) add("anchor","Confirmed identity anchor","pending","The named registration anchor has not been confirmed.");
  else if(!conn) add("anchor","Confirmed identity anchor","unavailable",unavailable);
  else {
    try {
      const t=await sol.readConfirmedTx(conn,identity.anchor_signature);
      if(!t) add("anchor","Confirmed identity anchor","unavailable","Anchor transaction is not available from this RPC.");
      else {
        const memo=t.ixs.find(x=>x.program===sol.MEMO_PROGRAM_ID.toBase58());
        const ok=!t.err && t.signers.includes(identity.wallet) && !!memo && new TextDecoder().decode(memo.data)===anchorMemo(identity.registration_hash);
        add("anchor","Confirmed identity anchor",ok?"pass":"fail",ok?`Registration hash anchored in slot ${t.slot}.`:"Memo or wallet signature does not match this identity.");
      }
    } catch(err) {add("anchor","Confirmed identity anchor","unavailable",(err as Error).message);}
  }
  if(!conn) add("terms","Signed economics and authority policy","unavailable",unavailable);
  else {
    try {
      const config=await sol.readDbcConfig(conn,m.config.address);
      try {assertConfigTerms(config,m); add("terms","Signed economics and authority policy","pass","All displayed fees, LP shares, supply, authorities and the complete config snapshot match the chain.");}
      catch(err) {add("terms","Signed economics and authority policy","fail",(err as Error).message);}
    } catch(err) {add("terms","Signed economics and authority policy","unavailable",(err as Error).message);}
  }
  if(!launch) {
    for(const [id,label] of [["transaction","Launch transaction"],["onchain","Mint, pool and immutable metadata"],["metadata","Pinned passport and image"],["lifecycle","Graduation state"]]) add(id,label,"pending","No confirmed launch recorded for this passport.");
    return {checks,passport:signed,launch:null,metadataUri:rec?.metadata_uri??null};
  }
  const recordOk=canonicalize(rec.manifest)===canonicalize(m) && rec.signature===signed.signature && rec.identity_id===identity?.id && launch.creator_wallet===m.creatorWallet && launch.cluster===m.cluster && launch.base_mint===m.token.baseMint && launch.pool===m.pool.address && m.pool.address===sol.derivePool(m.token.baseMint,m.config.address);
  if(!recordOk) {
    add("record","Recorded launch binding","fail","Recorded launch differs from the signed passport.");
    return {checks,passport:signed,launch,metadataUri:rec.metadata_uri};
  }
  add("record","Recorded launch binding","pass","Confirmed record names the signed creator, token and derived Meteora pool.");
  if(!conn) {
    for(const [id,label] of [["transaction","Launch transaction"],["onchain","Mint, pool and immutable metadata"],["lifecycle","Graduation state"]]) add(id,label,"unavailable",unavailable);
  } else {
    try {
      const prep=must(await d.from("chain_preparations").select("message_hash,payload,wallet").eq("signature",launch.signature).eq("kind","launch").maybeSingle());
      const tx=await sol.readConfirmedTx(conn,launch.signature);
      if(!tx) add("transaction","Launch transaction","unavailable","Confirmed launch transaction is not available from this RPC.");
      else {
        const ok=!!prep && !tx.err && tx.signers.includes(m.creatorWallet) && tx.ixs.some(x=>x.program===DBC_PROGRAM_ID) && messageHash(tx.serialized)===prep.message_hash && canonicalize(prep.payload.passport)===canonicalize(signed) && prep.wallet===m.creatorWallet;
        add("transaction","Launch transaction",ok?"pass":"fail",ok?`Exact prepared transaction, signed by the creator, confirmed in slot ${tx.slot}.`:"Transaction or prepared passport binding differs.");
      }
    } catch(err) {add("transaction","Launch transaction","unavailable",(err as Error).message);}
    try {
      const [pool,meta,mint]=await Promise.all([sol.readPool(conn,launch.pool),sol.readTokenMetadata(conn,m.token.baseMint),sol.readTokenMint(conn,m.token.baseMint)]);
      const ok=!!pool && pool.creator===m.creatorWallet && pool.baseMint===m.token.baseMint && pool.config===m.config.address && !!meta && meta.uri===rec.metadata_uri && meta.name===m.token.name && meta.symbol===m.token.symbol && !meta.isMutable && meta.updateAuthority===PublicKey.default.toBase58() && mint.decimals===m.token.decimals && mint.supply<=BigInt(m.token.totalSupply) && !mint.mintAuthority && !mint.freezeAuthority;
      add("onchain","Mint, pool and immutable metadata",ok?"pass":"fail",ok?"Creator, pool, immutable metadata, decimals and revoked mint/freeze authorities match. Circulating supply is within the signed cap.":"Pool, token supply, metadata or authority policy differs.");
      if(pool) {
        const life=mapLifecycle(pool);
        add("lifecycle","Graduation state","pass",{curve_active:"Bonding curve active",curve_completed:"Curve completed; awaiting migration",migration_pending:"Migration pending; DAMM v2 pool is not confirmed",damm_v2_live:`Live on DAMM v2: ${pool.dammV2Pool}`}[life]);
      } else add("lifecycle","Graduation state","unavailable","DBC pool is not readable.");
    } catch(err) {
      add("onchain","Mint, pool and immutable metadata","unavailable",(err as Error).message);
      add("lifecycle","Graduation state","unavailable","Pool state could not be read.");
    }
  }
  try {
    const bytes=await sol.fetchIpfsBytes(rec.metadata_uri,70_000);
    const doc=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    const imageCid=(typeof doc.image==="string"?doc.image:"").match(/(?:^ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{46,100})$/)?.[1];
    const ok=sha256Hex(bytes)===rec.metadata_hash && doc.name===m.token.name && doc.symbol===m.token.symbol && imageCid===m.token.imageUri.slice(7) && canonicalize(doc.properties?.fleuri_passport)===canonicalize(signed);
    add("metadata","Pinned passport and image URI",ok?"pass":"fail",ok?"Immutable JSON embeds this exact signed passport and the signed image content ID.":"Pinned JSON content or embedded passport differs.");
    if(ok && m.token.imageSha256) {
      const image=await sol.fetchIpfsBytes(m.token.imageUri,1_000_000);
      add("image","Image content hash",sha256Hex(image)===m.token.imageSha256?"pass":"fail","Downloaded image compared with the signed SHA-256 hash.");
    } else if(ok) add("image","Image content hash","unavailable","Passport binds the immutable image CID; no separate SHA-256 image hash was supplied.");
  } catch(err) {add("metadata","Pinned passport and image URI","unavailable",(err as Error).message);}
  return {checks,passport:signed,launch,metadataUri:rec.metadata_uri};
}
