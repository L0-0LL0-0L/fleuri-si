// Launch passport: strict manifest schema, canonical hash, ML-DSA-65 signature, offline verify.
// The manifest is signed WITHOUT the metadata URI; the signed passport is then pinned and its
// final URI committed in the launch transaction, so there is no circular CID signing.
import { z } from "zod";
import { b64, canonicalize, domainHash, fromB64, utf8 } from "./canonical";
import { CTX_PASSPORT, PQ_ALG, pqKeyHash, pqSign, pqVerify } from "./mldsa";
import { GENESIS, isSolanaAddress } from "./registration";

export const PASSPORT_SCHEMA = "fleuri.launch-passport/v1";
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const MAX_MANIFEST_BYTES = 24_000;

const addr = z.string().refine(isSolanaAddress, "Invalid Solana address");
const h64 = z.string().regex(/^[0-9a-f]{64}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
const pct = z.number().int().min(0).max(100);
const Scalar = z.union([z.string().max(200), z.number().int(), z.boolean(), z.null()]);
const httpsUrl = (s: string) => { try { const u = new URL(s); return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password; } catch { return false; } };
const twitterUrl = (s: string) => { try { const u = new URL(s); return u.protocol === "https:" && ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(u.hostname); } catch { return false; } };

export const Manifest = z
  .object({
    schema: z.literal(PASSPORT_SCHEMA),
    domain: z.string().min(3).max(120),
    cluster: z.enum(["devnet", "mainnet-beta"]),
    genesisHash: addr,
    dbcProgram: z.literal(DBC_PROGRAM_ID),
    creatorWallet: addr,
    identity: z.object({ alg: z.literal(PQ_ALG), keyHash: h64, registrationHash: h64, anchorSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) }).strict(),
    launchNonce: z.string().regex(/^[0-9a-f]{32}$/),
    token: z
      .object({
        baseMint: addr,
        name: z.string().min(1).max(32).refine(s => utf8(s).length <= 32, "Name exceeds 32 UTF-8 bytes"),
        symbol: z.string().regex(/^[A-Z0-9]{1,10}$/),
        imageUri: z.string().regex(/^ipfs:\/\/[A-Za-z0-9]{46,100}$/),
        imageSha256: h64.nullable(),
        website: z.string().max(200).refine(httpsUrl, "Website must be an https URL").optional(),
        twitter: z.string().max(200).refine(twitterUrl, "Twitter must be an https://x.com or https://twitter.com URL").optional(),
        decimals: z.number().int().min(6).max(9),
        totalSupply: uint,
      })
      .strict(),
    quote: z.object({ mint: z.literal(SOL_MINT), symbol: z.literal("SOL") }).strict(),
    config: z.object({ address: addr, snapshotHash: h64, snapshot: z.record(z.string().max(64), Scalar) }).strict(),
    pool: z.object({ address: addr }).strict(),
    fees: z
      .object({
        baseFeeBps: z.number().int().min(0).max(10_000),
        dynamicFeeEnabled: z.boolean(),
        feeClaimer: addr,
        creatorTradingFeePercent: pct,
        partnerTradingFeePercent: pct,
        poolCreationFeeLamports: uint,
      })
      .strict(),
    lp: z
      .object({
        creatorLiquidityPercent: pct,
        creatorPermanentLockedPercent: pct,
        partnerLiquidityPercent: pct,
        partnerPermanentLockedPercent: pct,
      })
      .strict(),
    migration: z
      .object({
        target: z.literal("DAMM_V2"),
        quoteThresholdLamports: uint,
        migrationFeeOption: z.number().int().min(0).max(6),
        migrationFeePercent: pct,
        creatorMigrationFeePercent: pct,
        migratedPoolFeeBps: z.number().int().min(0).max(10_000),
      })
      .strict(),
    authority: z
      .object({
        tokenUpdateAuthority: z.literal("immutable"),
        mintAuthority: z.literal("revoked"),
        freezeAuthority: z.literal("revoked"),
        leftoverReceiver: addr,
        policy: z.string().max(400),
      })
      .strict(),
    devBuy: z.object({ enabled: z.literal(false) }).strict(),
  })
  .strict();
export type PassportManifest = z.infer<typeof Manifest>;

export const SignedPassport = z
  .object({
    format: z.literal("fleuri.signed-passport/v1"),
    manifest: z.unknown(),
    manifestHash: h64,
    alg: z.literal(PQ_ALG),
    publicKey: z.string().max(4096),
    signature: z.string().max(6000),
  })
  .strict();
export type SignedPassportT = Omit<z.infer<typeof SignedPassport>, "manifest"> & { manifest: PassportManifest };

export function parseManifest(raw: unknown): PassportManifest {
  const text = canonicalize(raw); // rejects non-finite, undefined, non-plain
  if (utf8(text).length > MAX_MANIFEST_BYTES) throw new Error("Manifest too large.");
  const r = Manifest.safeParse(raw);
  if (!r.success) throw new Error(`Invalid manifest: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  if (r.data.genesisHash !== GENESIS[r.data.cluster]) throw new Error("Genesis does not match the passport cluster.");
  if (r.data.fees.creatorTradingFeePercent + r.data.fees.partnerTradingFeePercent !== 100) throw new Error("Trading fee shares must total 100%.");
  if (Object.values(r.data.lp).reduce((a, b) => a + b, 0) !== 100) throw new Error("LP shares must total 100%.");
  if (BigInt(r.data.token.totalSupply) === 0n || BigInt(r.data.migration.quoteThresholdLamports) === 0n) throw new Error("Supply and migration threshold must be positive.");
  if (domainHash("fleuri:config-snapshot:v1", r.data.config.snapshot) !== r.data.config.snapshotHash) throw new Error("Config snapshot does not match its hash.");
  return r.data;
}

export const manifestHash = (m: PassportManifest) => domainHash("fleuri:passport:v1", m);

export function signPassport(m: PassportManifest, kp: { publicKey: Uint8Array; secretKey: Uint8Array }): SignedPassportT {
  const manifest = parseManifest(m);
  if (pqKeyHash(kp.publicKey) !== manifest.identity.keyHash) throw new Error("This key is not the identity named in the manifest.");
  const h = manifestHash(manifest);
  return { format: "fleuri.signed-passport/v1", manifest, manifestHash: h, alg: PQ_ALG, publicKey: b64(kp.publicKey), signature: b64(pqSign(kp.secretKey, utf8(h), CTX_PASSPORT)) };
}

export type CheckStatus = "pass" | "fail" | "pending" | "unavailable";
export interface Check { id: string; label: string; status: CheckStatus; detail: string }

/** Offline checks: canonical payload + PQ signature + key fingerprint. Never claims chain facts. */
export function verifyPassportOffline(raw: unknown): { passport: SignedPassportT | null; checks: Check[] } {
  const checks: Check[] = [];
  try { if (utf8(canonicalize(raw)).length > 40_000) throw new Error("Passport too large."); }
  catch (e) { return { passport: null, checks: [{id: "canonical", label: "Canonical payload", status: "fail", detail: (e as Error).message}] }; }
  const outer = SignedPassport.safeParse(raw);
  if (!outer.success) return { passport: null, checks: [{ id: "canonical", label: "Canonical payload", status: "fail", detail: "Not a Fleuri signed passport." }] };
  let m: PassportManifest;
  try {
    m = parseManifest(outer.data.manifest);
  } catch (e) {
    return { passport: null, checks: [{ id: "canonical", label: "Canonical payload", status: "fail", detail: (e as Error).message }] };
  }
  const h = manifestHash(m);
  checks.push(h === outer.data.manifestHash ? { id: "canonical", label: "Canonical payload", status: "pass", detail: `manifest hash ${h.slice(0, 16)}…` } : { id: "canonical", label: "Canonical payload", status: "fail", detail: "Manifest hash does not match its contents (terms were altered)." });
  let pk: Uint8Array | null = null;
  try {
    pk = fromB64(outer.data.publicKey);
  } catch {
    /* noop */
  }
  const keyOk = !!pk && pqKeyHash(pk) === m.identity.keyHash;
  let sigOk = false;
  try { sigOk = keyOk && h === outer.data.manifestHash && pqVerify(pk!, utf8(h), fromB64(outer.data.signature), CTX_PASSPORT); } catch { /* invalid base64 is a failed check */ }
  checks.push({ id: "signature", label: "ML-DSA-65 signature", status: sigOk ? "pass" : "fail", detail: !keyOk ? "Public key does not match the identity fingerprint." : sigOk ? "Valid FIPS 204 signature over the manifest hash." : "Signature does not verify." });
  return { passport: { ...outer.data, manifest: m }, checks };
}
