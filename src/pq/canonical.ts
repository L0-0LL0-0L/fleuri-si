// Canonical JSON (sorted keys, no whitespace) + byte helpers. Isomorphic and dependency-light.
import { sha256 } from "@noble/hashes/sha2.js";

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

export function hex(b: Uint8Array) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function fromHex(s: string) {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function b64(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("invalid base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const sha256Hex = (b: Uint8Array) => hex(sha256(b));
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

/** Deterministic JSON. Rejects non-finite numbers, non-integers, undefined, and non-plain values. */
export function canonicalize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in canonical payload");
    if (!Number.isSafeInteger(v)) throw new Error("only safe integers allowed; encode amounts as strings");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error("non-plain object in canonical payload");
    const keys = Object.keys(v as object).sort();
    return `{${keys
      .map((k) => {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined) throw new Error(`undefined field "${k}"`);
        return `${JSON.stringify(k)}:${canonicalize(x)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`unsupported value type ${typeof v}`);
}

/** Domain-separated hash of a canonical payload. */
export function domainHash(domain: string, v: unknown) {
  return sha256Hex(concat(utf8(`${domain}\n`), utf8(canonicalize(v))));
}
