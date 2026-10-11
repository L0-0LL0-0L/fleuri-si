// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { generatePqKeypair, type PqKeypair } from "@/pq/mldsa";
import { DOMAIN, identityFor, runFixture } from "@/pq/receipt-fixtures";
import { receiptMemo, signReceipt, verifyReceiptBundle } from "@/pq/receipt";
import { confirmReceiptAnchor, exportBundle, prepareReceipt, submitReceiptSignature } from "./research.server";
import { utf8 } from "@/pq/canonical";

const OWNER = "11111111-1111-4111-8111-111111111111", IDT = "44444444-4444-4444-8444-444444444444", REQ = "55555555-5555-4555-8555-555555555555";
let kp: PqKeypair, wallet: Keypair, idRow: any, run: any;

/** Minimal in-memory db that mimics the RPC semantics needed by the orchestration. */
function fakeDb() {
  const t: Record<string, any[]> = { research_receipts: [], greenhouse_runs: [{ ...run, owner_id: OWNER, status: "done" }], pq_identities: [idRow] };
  const from = (name: string) => {
    const f: [string, any][] = [];
    const q: any = { select: () => q, eq: (k: string, v: any) => (f.push([k, v]), q), maybeSingle: async () => ({ data: t[name].find((r) => f.every(([k, v]) => r[k] === v)) ?? null, error: null }) };
    return q;
  };
  const rpc = vi.fn(async (n: string, a: any) => {
    if (n === "research_create_draft") { const row = { id: a._r.id, owner_id: a._owner, request_id: a._request, run_id: a._r.run_id, identity_id: a._r.identity_id, status: "draft", manifest: structuredClone(a._r.manifest), manifest_hash: a._r.manifest_hash, experiment: JSON.parse(JSON.stringify(a._r.experiment)) }; t.research_receipts.push(row); return { data: { ...row, created: true }, error: null }; }
    if (n === "research_sign") { const r = t.research_receipts.find((x) => x.id === a._id); if (r.status === "signed") return { data: { id: r.id, status: "signed", applied: false }, error: null }; Object.assign(r, { status: "signed", public_key: a._public_key, signature: a._signature, identity_proof: a._proof }); return { data: { id: r.id, status: "signed", applied: true }, error: null }; }
    if (n === "research_record_anchor") return { data: { applied: true, anchor_status: a._ok ? "confirmed" : "failed" }, error: null };
    throw new Error(n);
  });
  return { t, from, rpc };
}

beforeAll(() => {
  kp = generatePqKeypair(); wallet = Keypair.generate(); run = runFixture();
  idRow = { id: IDT, status: "unanchored", anchor_signature: null, ...identityFor(kp, wallet) };
});

describe("research receipt orchestration", () => {
  it("prepare → sign → export: offline-verifiable, registered (not anchored) identity suffices", async () => {
    const db = fakeDb();
    const d = await prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN);
    const s = signReceipt(d.manifest, kp);
    expect((await submitReceiptSignature(db, OWNER, { id: d.id, publicKey: s.publicKey, signature: s.signature })).status).toBe("signed");
    const v = verifyReceiptBundle(JSON.parse(JSON.stringify(exportBundle(db.t.research_receipts[0]))), { domain: DOMAIN });
    expect(v.valid).toBe(true);
  });
  it("retry recovers the same frozen draft; changed run/identity is a conflict", async () => {
    const db = fakeDb();
    const a = await prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN);
    const b = await prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN, () => new Date(0));
    expect(b).toMatchObject({ id: a.id, manifestHash: a.manifestHash, recovered: true });
    await expect(prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: "99999999-9999-4999-8999-999999999999" }, DOMAIN)).rejects.toThrow(/different trial or identity/);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("loads only the frozen stored trial and refuses tampered/unsupported/foreign runs or wrong domain", async () => {
    const db = fakeDb(); db.t.greenhouse_runs[0].output_hash = "f".repeat(64);
    await expect(prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN)).rejects.toThrow(/exact replay/);
    const db2 = fakeDb(); db2.t.greenhouse_runs[0].input = { ...run.input, engineVersion: "greenhouse-rules-1" };
    await expect(prepareReceipt(db2, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN)).rejects.toThrow(/cannot replay/);
    await expect(prepareReceipt(fakeDb(), "22222222-2222-4222-8222-222222222222", { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN)).rejects.toThrow(/your own/);
    await expect(prepareReceipt(fakeDb(), OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, "https://other.test")).rejects.toThrow(/domain/);
  });
  it("signature submission rejects wrong key, wrong document and a mutated experiment", async () => {
    const db = fakeDb();
    const d = await prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN);
    const other = generatePqKeypair();
    const forged = signReceipt({ ...d.manifest, issuer: { ...d.manifest.issuer, keyHash: (await import("@/pq/mldsa")).pqKeyHash(other.publicKey) } }, other);
    await expect(submitReceiptSignature(db, OWNER, { id: d.id, publicKey: forged.publicKey, signature: forged.signature })).rejects.toThrow(/not the identity/);
    const good = signReceipt(d.manifest, kp);
    const wrongDoc = signReceipt({ ...d.manifest, createdAt: "2020-01-01T00:00:00.000Z" }, kp);
    await expect(submitReceiptSignature(db, OWNER, { id: d.id, publicKey: good.publicKey, signature: wrongDoc.signature })).rejects.toThrow(/invalid/);
    db.t.research_receipts[0].experiment.output.runs[0].returnPct += 1;
    await expect(submitReceiptSignature(db, OWNER, { id: d.id, publicKey: good.publicKey, signature: good.signature })).rejects.toThrow(/no longer matches/);
  });
  it("a lost submit response is recoverable: re-submitting keeps the original signature", async () => {
    const db = fakeDb();
    const d = await prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN);
    const s1 = signReceipt(d.manifest, kp), s2 = signReceipt(d.manifest, kp);
    await submitReceiptSignature(db, OWNER, { id: d.id, publicKey: s1.publicKey, signature: s1.signature });
    expect((await submitReceiptSignature(db, OWNER, { id: d.id, publicKey: s2.publicKey, signature: s2.signature })).recovered).toBe(true);
    expect(db.t.research_receipts[0].signature).toBe(s1.signature);
  });
  it("anchor confirmation requires the exact memo and issuer signer; on-chain failure records a terminal failure", async () => {
    const db = fakeDb();
    const d = await prepareReceipt(db, OWNER, { requestId: REQ, runId: run.id, identityId: IDT }, DOMAIN);
    const memo = receiptMemo(d.manifestHash), MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    Object.assign(db.t.research_receipts[0], { anchor_preparation_id: "p1", anchor_status: "pending" });
    const prep = { id: "p1", subject: d.id, signature: "SIG", payload: { memo } };
    const tx = (o: any = {}) => ({ slot: 7, err: null, signers: [wallet.publicKey.toBase58()], ixs: [{ program: MEMO, data: utf8(memo) }], ...o });
    await expect(confirmReceiptAnchor(db, { ...prep, id: "p2" }, tx(), MEMO, OWNER)).rejects.toThrow(/not linked/);
    await expect(confirmReceiptAnchor(db, prep, tx({ ixs: [{ program: MEMO, data: utf8("other") }] }), MEMO, OWNER)).rejects.toThrow(/Memo/);
    await expect(confirmReceiptAnchor(db, prep, tx({ signers: ["x"] }), MEMO, OWNER)).rejects.toThrow(/issuer wallet/);
    await expect(confirmReceiptAnchor(db, prep, tx({ err: { InstructionError: [0, "x"] } }), MEMO, OWNER)).rejects.toThrow(/failed on chain/);
    expect(db.rpc).toHaveBeenLastCalledWith("research_record_anchor", expect.objectContaining({ _ok: false }));
    expect((await confirmReceiptAnchor(db, prep, tx(), MEMO, OWNER)).status).toBe("confirmed");
    expect(db.rpc).toHaveBeenLastCalledWith("research_record_anchor", expect.objectContaining({ _ok: true, _signature: "SIG", _slot: 7 }));
  });
});
