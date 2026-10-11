// @vitest-environment node
// Regressions for the independent review of the Research Receipts revision.
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { generatePqKeypair, type PqKeypair } from "./mldsa";
import { DOMAIN, identityFor, runFixture } from "./receipt-fixtures";
import { RECEIPT_BUNDLE_FORMAT, RECEIPT_SCHEMA_V1, buildManifest, parseReceiptManifest, receiptHash, signReceipt, verifyReceiptBundle, type IdentityProof } from "./receipt";
import { parseStrictJson, utf8Length } from "./strict-json";
import { bundleFromStored, bundleIntegrity, contentHash, inputHash, verifyBundle } from "@/domain/greenhouse";

let kp: PqKeypair, identity: IdentityProof, run: any;
beforeAll(() => { kp = generatePqKeypair(); identity = identityFor(kp, Keypair.generate()); run = runFixture(); });
const RID = "44444444-4444-4444-8444-444444444444";
function bundleFor(m: any, experiment: unknown) {
  const s = signReceipt(m, kp);
  return { format: RECEIPT_BUNDLE_FORMAT, manifest: m, manifestHash: s.manifestHash, alg: "ML-DSA-65", publicKey: s.publicKey, signature: s.signature, identityProof: identity, experiment, anchorHint: null };
}
function make(r = run) { const e = bundleFromStored(r); return bundleFor(buildManifest({ run: r, experiment: e, identity, receiptId: RID, createdAt: "2026-10-11T01:00:00Z", domain: DOMAIN }), e); }
const st = (v: ReturnType<typeof verifyReceiptBundle>, id: string) => v.checks.find((c) => c.id === id)?.status;

describe("bug 1: duplicate keys and byte bounds", () => {
  it('rejects "seed":10,"seed":9 inside the input object (JSON.parse would keep the last)', () => {
    const t = JSON.stringify(make());
    expect(verifyReceiptBundle(t).valid).toBe(true);
    const dup = t.replace('"seed":9', '"seed":10,"seed":9');
    expect(dup).not.toBe(t);
    const v = verifyReceiptBundle(dup);
    expect(v.valid).toBe(false); expect(v.checks[0].detail).toMatch(/duplicate key "seed"/);
  });
  it("rejects escaped-equivalent duplicate keys and duplicates at the root and deep inside", () => {
    const t = JSON.stringify(make());
    expect(verifyReceiptBundle(t.replace('"seed":9', '"\\u0073eed":10,"seed":9')).checks[0].detail).toMatch(/duplicate key/);
    expect(verifyReceiptBundle(t.replace('{"format"', '{"alg":"ML-DSA-65","format"')).checks[0].detail).toMatch(/duplicate key "alg"/);
    expect(() => parseStrictJson('{"a":[{"b":{"c":1,"c":1}}]}', { maxBytes: 100 })).toThrow(/duplicate key "c"/);
    expect(parseStrictJson('{"__proto__":{"x":1}}', { maxBytes: 100 })).toEqual(JSON.parse('{"__proto__":{"x":1}}'));
    expect(Object.getPrototypeOf(parseStrictJson('{"__proto__":{"x":1}}', { maxBytes: 100 }))).toBe(Object.prototype);
  });
  it("standalone Greenhouse bundles reject duplicate keys too", () => {
    const t = JSON.stringify(bundleFromStored(run));
    expect(verifyBundle(t).status).toBe("verified");
    expect(verifyBundle(t.replace('"seed":9', '"seed":10,"seed":9')).status).toBe("invalid");
  });
  it("bounds UTF-8 bytes (not UTF-16 length) for strings and objects before hashing/replay", () => {
    expect(utf8Length("é")).toBe(2); expect(utf8Length("😀")).toBe(4);
    const big = "é".repeat(1_400_000); // 1.4M chars, 2.8 MB of UTF-8
    expect(big.length).toBeLessThan(2_600_000);
    expect(verifyReceiptBundle(`"${big}"`).checks[0].detail).toMatch(/byte limit/);
    const old = structuredClone(make()) as any; old.experiment.input.engineVersion = "greenhouse-rules-1"; old.experiment.output.note = "x".repeat(2_700_000);
    const v = verifyReceiptBundle(old);
    expect(st(v, "schema")).toBe("fail"); expect(v.checks[0].detail).toMatch(/2.6 MB/);
  });
});

describe("bug 2: checksum claims are checked independently of replay support", () => {
  it("an engine relabel with the original inputHash fails integrity even when the signer committed to it", () => {
    const r = structuredClone(run); r.input.engineVersion = "greenhouse-rules-1"; // input_hash left unchanged
    const v = verifyReceiptBundle(make(r));
    expect(st(v, "signature")).toBe("pass");
    expect(st(v, "commitments")).toBe("fail");
    expect(v.checks.find((c) => c.id === "commitments")!.detail).toMatch(/input checksum/);
    expect(st(v, "replay")).toBe("unsupported"); // never replayed through a newer engine
    expect(v.valid).toBe(false);
  });
  it("a consistent legacy engine keeps signature + integrity and is explicitly unsupported for replay", () => {
    const r = structuredClone(run); r.input.engineVersion = "greenhouse-rules-1";
    r.input_hash = inputHash(r.input); r.content_hash = contentHash(r.input_hash, r.output_hash);
    const v = verifyReceiptBundle(make(r));
    expect([st(v, "signature"), st(v, "commitments"), st(v, "replay")]).toEqual(["pass", "pass", "unsupported"]);
    expect(v.valid).toBe(true);
  });
  it("bundleIntegrity checks shape and all three checksums", () => {
    const e: any = bundleFromStored(run);
    expect(bundleIntegrity(e)).toEqual([]);
    expect(bundleIntegrity({ ...e, output: { ...e.output, runs: [...e.output.runs, {}] } }).join()).toMatch(/output checksum/);
    expect(bundleIntegrity({ ...e, contentHash: "0".repeat(64) }).join()).toMatch(/content checksum/);
    expect(bundleIntegrity({ ...e, extra: 1 }).join()).toMatch(/shape/);
  });
});

describe("bug 3: private request id", () => {
  it("new manifests use v2 and contain no requestId", () => {
    const b = make();
    expect(b.manifest.schema).toBe("fleuri.research-receipt/v2");
    expect("requestId" in b.manifest).toBe(false);
    expect(() => parseReceiptManifest({ ...b.manifest, requestId: "55555555-5555-4555-8555-555555555555" })).toThrow();
  });
  it("legacy v1 receipts (with their committed requestId) still verify offline, with disclosure", () => {
    const e = bundleFromStored(run);
    const v2 = buildManifest({ run, experiment: e, identity, receiptId: RID, createdAt: "2026-10-11T01:00:00Z", domain: DOMAIN });
    const v1 = parseReceiptManifest({ ...v2, schema: RECEIPT_SCHEMA_V1, requestId: "55555555-5555-4555-8555-555555555555" });
    expect(receiptHash(v1)).not.toBe(receiptHash(v2));
    const v = verifyReceiptBundle(bundleFor(v1, e));
    expect(v.valid).toBe(true);
    expect(v.checks[0].detail).toMatch(/legacy.*private request identifier/);
    // A v2 signature cannot be relabelled as v1 (different hash domain and message).
    const b = bundleFor(v2, e); b.manifest = v1 as any; b.manifestHash = receiptHash(v1);
    expect(st(verifyReceiptBundle(b), "signature")).toBe("fail");
  });
});
