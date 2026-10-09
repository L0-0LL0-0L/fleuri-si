// Browser-only PQ key holder. Only the ENCRYPTED key file touches localStorage; the decrypted
// secret lives in memory until lock(), tab close, or 15 minutes of idle time.
import { useSyncExternalStore } from "react";
import { decryptEnvelope, encryptKeypair, parseEnvelope, type KeyEnvelope } from "./vault";
import { generatePqKeypair, type PqKeypair } from "./mldsa";

const KEY = "fleuri.pq.keyfile.v1";
const ACK = "fleuri.pq.backup-ack.v1";
const IDLE_MS = 15 * 60_000;

interface Snap { envelope: KeyEnvelope | null; unlocked: boolean; backupAck: boolean; ready: boolean }
let snap: Snap = { envelope: null, unlocked: false, backupAck: false, ready: false };
let secret: PqKeypair | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const emit = (p: Partial<Snap>) => {
  snap = { ...snap, ...p };
  subs.forEach((f) => f());
};

export function loadLocal() {
  if (typeof window === "undefined" || snap.ready) return;
  let envelope: KeyEnvelope | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) envelope = parseEnvelope(raw);
  } catch {
    envelope = null;
  }
  emit({ envelope, backupAck: !!envelope && localStorage.getItem(ACK) === envelope.keyHash, ready: true });
}

function arm() {
  clearTimeout(timer);
  timer = setTimeout(lock, IDLE_MS);
}

export function lock() {
  secret?.secretKey.fill(0);
  secret = null;
  clearTimeout(timer);
  emit({ unlocked: false });
}

export async function createIdentity(password: string) {
  const kp = generatePqKeypair();
  const env = await encryptKeypair(kp, password);
  localStorage.setItem(KEY, JSON.stringify(env));
  localStorage.removeItem(ACK);
  secret = kp;
  arm();
  emit({ envelope: env, unlocked: true, backupAck: false });
  return env;
}

export async function unlock(password: string) {
  if (!snap.envelope) throw new Error("No key file on this device.");
  secret = await decryptEnvelope(snap.envelope, password);
  arm();
  emit({ unlocked: true });
}

/** Restores from a backup file; verifies the password before replacing anything. */
export async function restoreBackup(fileText: string, password: string) {
  const env = parseEnvelope(fileText);
  const kp = await decryptEnvelope(env, password);
  localStorage.setItem(KEY, JSON.stringify(env));
  secret?.secretKey.fill(0);
  secret = kp;
  arm();
  emit({ envelope: env, unlocked: true, backupAck: localStorage.getItem(ACK) === env.keyHash });
}

export function backupBlob() {
  if (!snap.envelope) throw new Error("No key file.");
  return new Blob([JSON.stringify(snap.envelope, null, 2)], { type: "application/json" });
}

export function acknowledgeBackup() {
  if (!snap.envelope) return;
  localStorage.setItem(ACK, snap.envelope.keyHash);
  emit({ backupAck: true });
}

export function forgetLocal() {
  lock();
  localStorage.removeItem(KEY);
  localStorage.removeItem(ACK);
  emit({ envelope: null, backupAck: false });
}

/** Runs fn with the unlocked keypair; never exposes the secret outside the call. */
export function withSecret<T>(fn: (kp: PqKeypair) => T): T {
  if (!secret) throw new Error("Unlock your PQ identity first.");
  arm();
  return fn(secret);
}

export function usePqLocal() {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => snap,
    () => snap,
  );
}
