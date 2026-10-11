// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64, utf8 } from "./canonical";
import { CTX_PASSPORT, CTX_REGISTRATION, generatePqKeypair, pqKeyHash, pqSign, type PqKeypair } from "./mldsa";
import { buildStatement, CHALLENGE_TTL_MS, GENESIS, registrationHash } from "./registration";
import { RECEIPT_BUNDLE_FORMAT, buildManifest, receiptHash, receiptMemo, receiptMessage, signReceipt, verifyAnchor, verifyReceiptBundle, type IdentityProof } from "./receipt";
import { buildSeed } from "@/domain/seed";
import { bundleFromStored, contentHash, freezeMarket, inputHash, makeInput, outputHash, runTrial, snapshotPolicy } from "@/domain/greenhouse";

import { DOMAIN, identityFor, runFixture } from "./receipt-fixtures";
let kp: PqKeypair, wallet: Keypair, identity: IdentityProof, run: any;
function make(over: { run?: any; id?: IdentityProof } = {}) {
  const r = over.run ?? run, idt = over.id ?? identity;
  const experiment = bundleFromStored(r);
  const manifest = buildManifest({ run: r, experiment, identity: idt, receiptId: "44444444-4444-4444-8444-444444444444", createdAt: "2026-10-11T01:00:00Z", domain: DOMAIN });
  const s = signReceipt(manifest, kp);
  return { format: RECEIPT_BUNDLE_FORMAT, manifest, manifestHash: s.manifestHash, alg: "ML-DSA-65", publicKey: s.publicKey, signature: s.signature, identityProof: idt, experiment, anchorHint: null } as any;
}
const st = (v: ReturnType<typeof verifyReceiptBundle>, id: string) => v.checks.find((c) => c.id === id)?.status;

beforeAll(() => { kp = generatePqKeypair(); wallet = Keypair.generate(); identity = identityFor(kp, wallet); run = runFixture(); });

describe("research receipts", () => {
  it("a genuine receipt verifies offline with separate checks", () => {
    const v = verifyReceiptBundle(JSON.parse(JSON.stringify(make())), { domain: DOMAIN });
    expect(v.checks.map((c) => [c.id, c.status])).toEqual([["schema", "pass"], ["commitments", "pass"], ["identity", "pass"], ["signature", "pass"], ["replay", "pass"], ["anchor", "unavailable"]]);
    expect(v.valid).toBe(true);
  });
  it("uses a distinct ML-DSA context: passport/registration-context signatures are rejected", () => {
    const b = make();
    b.signature = b64(pqSign(kp.secretKey, receiptMessage(b.manifest), CTX_PASSPORT));
    expect(st(verifyReceiptBundle(b), "signature")).toBe("fail");
    b.signature = b64(pqSign(kp.secretKey, receiptMessage(b.manifest), CTX_REGISTRATION));
    expect(st(verifyReceiptBundle(b), "signature")).toBe("fail");
  });
  it("rejects a different key, wallet, cluster or domain", () => {
    const other = generatePqKeypair();
    const b1 = make(); const s = signReceipt({ ...b1.manifest }, kp); b1.publicKey = b64(other.publicKey); b1.signature = s.signature;
    expect(st(verifyReceiptBundle(b1), "signature")).toBe("fail");
    expect(() => signReceipt(b1.manifest, other)).toThrow(/not the identity/);
    const b2 = make(); b2.identityProof = identityFor(kp, Keypair.generate());
    expect(st(verifyReceiptBundle(b2), "identity")).toBe("fail");
    const b3 = make({ id: identityFor(kp, wallet, "mainnet-beta") }); b3.identityProof = identity;
    expect(st(verifyReceiptBundle(b3), "identity")).toBe("fail");
    expect(st(verifyReceiptBundle(make(), { domain: "https://evil.test" }), "identity")).toBe("fail");
  });
  it("flags any change to experiment metadata, results, settings or policies", () => {
    const edits: ((b: any) => void)[] = [
      (b) => { b.experiment.output.runs[0].returnPct += 0.000001; },
      (b) => { b.experiment.runId = "66666666-6666-4666-8666-666666666666"; },
      (b) => { b.experiment.createdAt = "2026-10-12T00:00:00Z"; },
      (b) => { b.experiment.note = "edited"; },
      (b) => { b.experiment.input.config.seed = 10; },
      (b) => { b.experiment.input.policies[0].handle = "evil"; },
      (b) => { b.manifest.trial.seed = 10; },
    ];
    for (const e of edits) { const b = make(); e(b); const v = verifyReceiptBundle(b); expect(v.valid).toBe(false); }
  });
  it("stored checksum mismatch is caught even when the manifest commits to it", () => {
    const bad = { ...run, output_hash: "f".repeat(64) };
    const v = verifyReceiptBundle(make({ run: bad }));
    expect(st(v, "commitments")).toBe("fail"); // integrity recomputes the stored claim even though the signer committed to it
    expect(st(v, "replay")).toBe("fail");
    expect(v.valid).toBe(false);
  });
  it("preserves exact floats: no rounding or relabelling of Greenhouse results", () => {
    const b = make();
    expect(JSON.stringify(b.experiment.output)).toBe(JSON.stringify(run.output));
    expect(b.manifest.source.engineVersion).toBe("greenhouse-rules-2");
  });
  it("unsupported engine shows unsupported replay, not verified or failed", () => {
    const old = structuredClone(run); old.input.engineVersion = "greenhouse-rules-1";
    old.input_hash = inputHash(old.input); old.content_hash = contentHash(old.input_hash, old.output_hash); // internally consistent legacy run
    const v = verifyReceiptBundle(make({ run: old }));
    expect(st(v, "replay")).toBe("unsupported"); expect(st(v, "signature")).toBe("pass"); expect(st(v, "commitments")).toBe("pass");
  });
  it("bounded strict parser: oversize, deep, unexpected and duplicate-shaped inputs are rejected", () => {
    expect(verifyReceiptBundle("x".repeat(2_600_001)).valid).toBe(false);
    expect(verifyReceiptBundle("{").checks[0].detail).toMatch(/Rejected/);
    let deep: any = 1; for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(verifyReceiptBundle({ ...make(), experiment: deep }).checks[0].status).toBe("fail");
    expect(verifyReceiptBundle({ ...make(), extra: 1 }).checks[0].detail).toMatch(/Unexpected/);
    expect(verifyReceiptBundle({ ...make(), manifest: { ...make().manifest, x: 1 } }).valid).toBe(false);
    expect(verifyReceiptBundle(null).valid).toBe(false);
    // duplicate JSON keys collapse in JSON.parse; the surviving (edited) value must still fail commitments
    const t = JSON.stringify(make()).replace('"seed":9', '"seed":9,"seed":10');
    expect(verifyReceiptBundle(t).valid).toBe(false);
  });
  it("anchor check never trusts the hint and distinguishes missing/failed/wrong memo", async () => {
    const b = make(); const m = b.manifest, h = b.manifestHash;
    const memo = (s: string) => ({ program: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", data: utf8(s) });
    const reader = (tx: any, g: string = GENESIS.devnet) => ({ genesis: async () => g, tx: async () => tx });
    const sig = { signature: "5".repeat(88) };
    const ok = { status: "ok", tx: { slot: 9, err: null, signers: [m.issuer.wallet], ixs: [memo(receiptMemo(h))] } };
    expect((await verifyAnchor(m, h, sig, reader(ok) as any)).status).toBe("pass");
    expect((await verifyAnchor(m, h, sig, reader(ok, GENESIS["mainnet-beta"] as string) as any)).status).toBe("fail");
    expect((await verifyAnchor(m, h, sig, reader({ status: "missing" }) as any)).status).toBe("unavailable");
    expect((await verifyAnchor(m, h, sig, reader({ ...ok, tx: { ...ok.tx, err: { x: 1 } } }) as any)).status).toBe("fail");
    expect((await verifyAnchor(m, h, sig, reader({ ...ok, tx: { ...ok.tx, ixs: [memo(receiptMemo("0".repeat(64)))] } }) as any)).status).toBe("fail");
    expect((await verifyAnchor(m, h, sig, reader({ ...ok, tx: { ...ok.tx, signers: ["x"] } }) as any)).status).toBe("fail");
    expect((await verifyAnchor(m, h, sig, { genesis: async () => { throw new Error("down"); }, tx: async () => ok } as any)).status).toBe("unavailable");
    expect(receiptHash(m)).toBe(h);
  });
});
