// Encrypted ML-DSA key file. PBKDF2-SHA256 (600k) -> AES-256-GCM with fresh salt/IV.
// The header is bound as AES-GCM additional data so any tampering fails decryption.
import { z } from "zod";
import { b64, canonicalize, fromB64, utf8 } from "./canonical";
import { CTX_PASSPORT, PQ_ALG, PUBLIC_KEY_BYTES, pqKeyHash, pqSign, pqVerify, type PqKeypair } from "./mldsa";

export const KEYFILE_SCHEMA = "fleuri.pq-keyfile/v1" as const;
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSWORD = 12;

const Envelope = z
  .object({
    schema: z.literal(KEYFILE_SCHEMA),
    alg: z.literal(PQ_ALG),
    publicKey: z.string().max(4096),
    keyHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().max(40),
    kdf: z.object({ name: z.literal("PBKDF2-SHA256"), iterations: z.number().int().min(310_000).max(5_000_000), salt: z.string().max(64) }).strict(),
    cipher: z.object({ name: z.literal("AES-256-GCM"), iv: z.string().max(32) }).strict(),
    ciphertext: z.string().max(16384),
  })
  .strict();
export type KeyEnvelope = z.infer<typeof Envelope>;

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", utf8(password) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const aad = (e: Omit<KeyEnvelope, "ciphertext">) => utf8(canonicalize(e));

export async function encryptKeypair(kp: PqKeypair, password: string, iterations = KDF_ITERATIONS): Promise<KeyEnvelope> {
  if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    schema: KEYFILE_SCHEMA,
    alg: PQ_ALG,
    publicKey: b64(kp.publicKey),
    keyHash: pqKeyHash(kp.publicKey),
    createdAt: new Date().toISOString(),
    kdf: { name: "PBKDF2-SHA256" as const, iterations, salt: b64(salt) },
    cipher: { name: "AES-256-GCM" as const, iv: b64(iv) },
  };
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(header) as BufferSource }, key, kp.secretKey as BufferSource));
  return { ...header, ciphertext: b64(ct) };
}

export function parseEnvelope(raw: unknown): KeyEnvelope {
  const obj = typeof raw === "string" ? (() => { if (raw.length > 32768) throw new Error("Key file too large."); return JSON.parse(raw); })() : raw;
  const r = Envelope.safeParse(obj);
  if (!r.success) throw new Error("This is not a valid Fleuri key file.");
  const pk = fromB64(r.data.publicKey);
  if (pk.length !== PUBLIC_KEY_BYTES || pqKeyHash(pk) !== r.data.keyHash) throw new Error("Key file public key does not match its fingerprint.");
  return r.data;
}

/** Decrypts and proves possession (sign+verify) so a wrong or corrupted key never unlocks. */
export async function decryptEnvelope(env: KeyEnvelope, password: string): Promise<PqKeypair> {
  const { ciphertext, ...header } = parseEnvelope(env);
  let sk: Uint8Array;
  try {
    const key = await deriveKey(password, fromB64(header.kdf.salt), header.kdf.iterations);
    sk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(header.cipher.iv) as BufferSource, additionalData: aad(header) as BufferSource }, key, fromB64(ciphertext) as BufferSource));
  } catch {
    throw new Error("Wrong password, or the key file is corrupted.");
  }
  const publicKey = fromB64(header.publicKey);
  const probe = utf8("fleuri key-file possession check");
  if (!pqVerify(publicKey, probe, pqSign(sk, probe, CTX_PASSPORT), CTX_PASSPORT)) {
    sk.fill(0);
    throw new Error("Decrypted key does not match this key file's public key.");
  }
  return { publicKey, secretKey: sk };
}
