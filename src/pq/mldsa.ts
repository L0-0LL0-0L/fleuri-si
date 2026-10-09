// FIPS 204 ML-DSA-65 identity keys. Fresh CSPRNG seed — never derived from a wallet signature.
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { concat, sha256Hex, utf8 } from "./canonical";

export const PQ_ALG = "ML-DSA-65" as const;
export const CTX_REGISTRATION = utf8("fleuri/pq-identity-registration/v1");
export const CTX_PASSPORT = utf8("fleuri/launch-passport/v1");
export const PUBLIC_KEY_BYTES = 1952;
export const SIGNATURE_BYTES = 3309;

export interface PqKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generatePqKeypair(): PqKeypair {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    return ml_dsa65.keygen(seed);
  } finally {
    seed.fill(0);
  }
}

export const pqKeyHash = (publicKey: Uint8Array) => sha256Hex(concat(utf8("fleuri:pq-key:v1\n"), publicKey));

export function pqSign(secretKey: Uint8Array, msg: Uint8Array, context: Uint8Array) {
  return ml_dsa65.sign(msg, secretKey, { context });
}

export function pqVerify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array, context: Uint8Array) {
  if (publicKey.length !== PUBLIC_KEY_BYTES || sig.length !== SIGNATURE_BYTES) return false;
  try {
    return ml_dsa65.verify(sig, msg, publicKey, { context });
  } catch {
    return false;
  }
}
