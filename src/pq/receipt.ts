// Agent Research Receipts: a human's registered Fleuri PQ identity attests a saved Greenhouse
// trial (virtual, scheduled-rules engine). Pure and isomorphic — the browser, server and CLI
// all use these functions. Nothing here proves a strategy is good or that anything ran on chain.
import { z } from "zod";
import { b64, canonicalize, domainHash, fromB64, utf8 } from "./canonical";
import { CTX_RECEIPT, PQ_ALG, pqKeyHash, pqSign, pqVerify } from "./mldsa";
import { GENESIS, isSolanaAddress, validateIdentityProof } from "./registration";
import { BUNDLE_FORMAT, SUPPORTED_ENGINES, boundedJson, bundleIntegrity, hashOf, verifyBundle } from "@/domain/greenhouse";
import { jsonByteLength, parseStrictJson } from "./strict-json";

/** v2 is current. v1 (legacy) also committed a private server idempotency id; it still verifies offline. */
export const RECEIPT_SCHEMA = "fleuri.research-receipt/v2";
export const RECEIPT_SCHEMA_V1 = "fleuri.research-receipt/v1";
export const RECEIPT_BUNDLE_FORMAT = "fleuri.research-receipt-bundle/v1";
export const RECEIPT_MAX_BYTES = 2_600_000;
export const RECEIPT_SCOPE = "Attests that this registered Fleuri identity reviewed this saved Greenhouse trial: a deterministic vSOL sandbox run of the scheduled rules engine (archetype and risk only). Free-text strategy was recorded but not executed. Not AI training, not a safety or performance certification, not on-chain trading.";
export const receiptMemo = (manifestHash: string) => `fleuri:receipt:v1:${manifestHash}`;
/** The full original Greenhouse bundle is committed with Greenhouse's own float-preserving hash. */
export const experimentDigest = (experiment: unknown) => hashOf("fleuri.research-receipt.experiment.v1", experiment);

const h64 = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const addr = z.string().refine(isSolanaAddress, "Invalid Solana address");
const iso = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), "Invalid timestamp");
const Common = {
  domain: z.string().min(3).max(120),
  receiptId: uuid,
  createdAt: iso,
  cluster: z.enum(["devnet", "mainnet-beta"]),
  genesisHash: addr,
  issuer: z.object({ wallet: addr, alg: z.literal(PQ_ALG), keyHash: h64, registrationHash: h64 }).strict(),
  source: z.object({
    runId: uuid, runCreatedAt: z.string().max(40), runFinishedAt: z.string().max(40).nullable(),
    bundleFormat: z.literal(BUNDLE_FORMAT), engineVersion: z.string().max(40), scenarioVersion: z.string().max(40),
    inputHash: h64, outputHash: h64, contentHash: h64, experimentDigest: h64,
  }).strict(),
  trial: z.object({
    seed: z.number().int().min(0).max(0xffffffff), repetitions: z.number().int().min(1).max(5), cycles: z.number().int().min(5).max(60),
    scenarios: z.array(z.string().max(40)).min(1).max(4), agentIds: z.array(z.string().max(40)).min(1).max(4),
    policies: z.array(z.object({ agentId: z.string().max(40), handle: z.string().max(20), archetype: z.string().max(20), risk: z.number().int().min(1).max(5), policyHash: h64 }).strict()).min(1).max(4),
  }).strict(),
  scope: z.literal(RECEIPT_SCOPE),
};
const ManifestV2 = z.object({ schema: z.literal(RECEIPT_SCHEMA), ...Common }).strict();
const ManifestV1 = z.object({ schema: z.literal(RECEIPT_SCHEMA_V1), requestId: uuid, ...Common }).strict();
export const ReceiptManifest = z.discriminatedUnion("schema", [ManifestV2, ManifestV1]);
export type ReceiptManifestT = z.infer<typeof ReceiptManifest>;
export const isLegacyManifest = (m: { schema: string }) => m.schema === RECEIPT_SCHEMA_V1;
export const receiptHash = (m: ReceiptManifestT) => domainHash(m.schema === RECEIPT_SCHEMA_V1 ? "fleuri:research-receipt:v1" : "fleuri:research-receipt:v2", m);

export interface IdentityProof { owner_id: string; wallet: string; cluster: string; genesis_hash: string; public_key: string; key_hash: string; statement: string; registration_hash: string; wallet_signature: string; pq_signature: string }
const ProofShape = z.object({ owner_id: uuid, wallet: z.string().max(60), cluster: z.string().max(20), genesis_hash: z.string().max(60), public_key: z.string().max(4096), key_hash: h64, statement: z.string().max(16384), registration_hash: h64, wallet_signature: z.string().max(200), pq_signature: z.string().max(6000) }).strict();
const AnchorHint = z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/), slot: z.number().int().nonnegative().nullable(), memo: z.string().max(120) }).strict().nullable();

export const ReceiptBundle = z.object({
  format: z.literal(RECEIPT_BUNDLE_FORMAT),
  manifest: z.unknown(),
  manifestHash: h64,
  alg: z.literal(PQ_ALG),
  publicKey: z.string().max(4096),
  signature: z.string().max(6000),
  identityProof: ProofShape,
  experiment: z.unknown(),
  /** UNSIGNED annotation: a hint for optional chain verification. Never trusted as proof. */
  anchorHint: AnchorHint,
}).strict();
export type ReceiptBundleT = z.infer<typeof ReceiptBundle>;

export interface DraftSource {
  run: { id: string; created_at: string; finished_at: string | null; input: any; output: any; input_hash: string; output_hash: string | null; content_hash: string | null };
  experiment: unknown; // bundleFromStored(run)
  identity: IdentityProof;
  receiptId: string; createdAt: string; domain: string;
}
/** Builds the immutable manifest. The caller must already have verified the experiment replays. */
export function buildManifest(d: DraftSource): ReceiptManifestT {
  const i = d.run.input;
  const cl = d.identity.cluster as keyof typeof GENESIS;
  if (!/^[0-9a-f]{64}$/.test(d.run.output_hash ?? "") || !/^[0-9a-f]{64}$/.test(d.run.content_hash ?? "")) throw new Error("The trial is missing its stored output/content checksums.");
  const m = {
    schema: RECEIPT_SCHEMA, domain: d.domain, receiptId: d.receiptId, createdAt: d.createdAt,
    cluster: cl, genesisHash: GENESIS[cl],
    issuer: { wallet: d.identity.wallet, alg: PQ_ALG, keyHash: d.identity.key_hash, registrationHash: d.identity.registration_hash },
    source: { runId: d.run.id, runCreatedAt: d.run.created_at, runFinishedAt: d.run.finished_at, bundleFormat: BUNDLE_FORMAT, engineVersion: i.engineVersion, scenarioVersion: i.scenarioVersion,
      inputHash: d.run.input_hash, outputHash: d.run.output_hash!, contentHash: d.run.content_hash!, experimentDigest: experimentDigest(d.experiment) },
    trial: { seed: i.config.seed, repetitions: i.config.repetitions, cycles: i.config.cycles, scenarios: i.config.scenarios, agentIds: i.config.agentIds,
      policies: i.policies.map((p: any) => ({ agentId: p.agentId, handle: p.handle, archetype: p.archetype, risk: p.risk, policyHash: p.policyHash })) },
    scope: RECEIPT_SCOPE,
  };
  return parseReceiptManifest(m);
}
export function parseReceiptManifest(raw: unknown): ReceiptManifestT {
  if (utf8(canonicalize(raw)).length > 16_000) throw new Error("Receipt manifest too large.");
  const r = ReceiptManifest.safeParse(raw);
  if (!r.success) throw new Error(`Invalid receipt manifest: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  if (r.data.genesisHash !== GENESIS[r.data.cluster]) throw new Error("Genesis does not match the receipt cluster.");
  return r.data;
}
/** Exact message bytes signed with the dedicated research-receipt context. */
export const receiptMessage = (m: ReceiptManifestT) => utf8(`${m.schema === RECEIPT_SCHEMA_V1 ? "Fleuri research receipt" : "Fleuri research receipt v2"}\n${receiptHash(m)}`);
export function signReceipt(m: ReceiptManifestT, kp: { publicKey: Uint8Array; secretKey: Uint8Array }) {
  const manifest = parseReceiptManifest(m);
  if (pqKeyHash(kp.publicKey) !== manifest.issuer.keyHash) throw new Error("The unlocked key is not the identity named in this receipt.");
  return { manifestHash: receiptHash(manifest), publicKey: b64(kp.publicKey), signature: b64(pqSign(kp.secretKey, receiptMessage(manifest), CTX_RECEIPT)) };
}
export function verifyReceiptSignature(m: ReceiptManifestT, publicKeyB64: string, signatureB64: string) {
  try { const pk = fromB64(publicKeyB64); return pqKeyHash(pk) === m.issuer.keyHash && pqVerify(pk, receiptMessage(m), fromB64(signatureB64), CTX_RECEIPT); } catch { return false; }
}

/** Experiment commitments: digest, original stored claims and settings/policies all match. */
export function commitmentProblems(m: ReceiptManifestT, experiment: any): string[] {
  const out: string[] = [];
  if (experimentDigest(experiment) !== m.source.experimentDigest) out.push("experiment digest differs from the signed commitment");
  const e = experiment ?? {};
  const i = e.input ?? {};
  const eq = (a: unknown, b: unknown) => { try { return canonicalize(a) === canonicalize(b); } catch { return false; } };
  if (e.format !== m.source.bundleFormat) out.push("bundle format");
  if (e.runId !== m.source.runId || e.createdAt !== m.source.runCreatedAt) out.push("source run id or time");
  if (e.inputHash !== m.source.inputHash || e.outputHash !== m.source.outputHash || e.contentHash !== m.source.contentHash) out.push("stored checksum claims");
  if (i.engineVersion !== m.source.engineVersion || i.scenarioVersion !== m.source.scenarioVersion) out.push("engine/scenario versions");
  const c = i.config ?? {};
  if (!eq({ seed: c.seed, repetitions: c.repetitions, cycles: c.cycles, scenarios: c.scenarios, agentIds: c.agentIds }, { seed: m.trial.seed, repetitions: m.trial.repetitions, cycles: m.trial.cycles, scenarios: m.trial.scenarios, agentIds: m.trial.agentIds })) out.push("trial settings");
  const pols = Array.isArray(i.policies) ? i.policies.map((p: any) => ({ agentId: p?.agentId, handle: p?.handle, archetype: p?.archetype, risk: p?.risk, policyHash: p?.policyHash })) : null;
  if (!pols || !eq(pols, m.trial.policies)) out.push("policy snapshots");
  out.push(...bundleIntegrity(experiment));
  return out;
}

export type RStatus = "pass" | "fail" | "unavailable" | "unsupported";
export interface RCheck { id: "schema" | "commitments" | "identity" | "signature" | "replay" | "anchor"; label: string; status: RStatus; detail: string }
export interface ReceiptVerification { checks: RCheck[]; manifest: ReceiptManifestT | null; bundle: ReceiptBundleT | null; valid: boolean }

/** Offline verification: no Fleuri database, no network. Anchor is reported as unavailable here. */
export function verifyReceiptBundle(raw: unknown, opts: { domain?: string } = {}): ReceiptVerification {
  const fail = (detail: string): ReceiptVerification => ({ checks: [{ id: "schema", label: "Schema & bounds", status: "fail", detail }], manifest: null, bundle: null, valid: false });
  try {
    let obj = raw;
    if (typeof raw === "string") { try { obj = parseStrictJson(raw, { maxBytes: RECEIPT_MAX_BYTES, maxDepth: 16 }); } catch (e) { return fail(`Rejected: ${(e as Error).message}.`); } }
    const bad = boundedJson(obj, 14);
    if (bad) return fail(`Rejected: ${bad}.`);
    if (typeof raw !== "string" && jsonByteLength(obj) > RECEIPT_MAX_BYTES) return fail("Receipt is larger than the 2.6 MB limit.");
    const b = ReceiptBundle.safeParse(obj);
    if (!b.success) return fail(`Unexpected or missing field: ${b.error.issues[0]?.path.join(".") || "(root)"} ${b.error.issues[0]?.message}`);
    let m: ReceiptManifestT;
    try { m = parseReceiptManifest(b.data.manifest); } catch (e) { return fail((e as Error).message); }
    const checks: RCheck[] = [{ id: "schema", label: "Schema & bounds", status: "pass", detail: isLegacyManifest(m) ? `${RECEIPT_SCHEMA_V1} (legacy): strict fields, bounded size and depth. This older format also commits a private request identifier.` : `${RECEIPT_SCHEMA}, strict fields, no duplicate keys, bounded size and depth.` }];
    const probs = receiptHash(m) !== b.data.manifestHash ? ["manifest hash"] : commitmentProblems(m, b.data.experiment);
    checks.push({ id: "commitments", label: "Commitment integrity", status: probs.length ? "fail" : "pass", detail: probs.length ? `Integrity failed: ${probs.join("; ")}.` : "Manifest hash, experiment digest, every policy snapshot and settings match, and the stored input/output/content checksums recompute over the bundled data." });
    let idOk = false, idDetail = "";
    try {
      const f = validateIdentityProof(b.data.identityProof, opts.domain);
      const p = b.data.identityProof;
      if (p.wallet !== m.issuer.wallet || p.key_hash !== m.issuer.keyHash || p.registration_hash !== m.issuer.registrationHash || p.cluster !== m.cluster || p.genesis_hash !== m.genesisHash || f.domain !== m.domain || p.public_key !== b.data.publicKey) throw new Error("Registration does not match the receipt issuer, key, cluster or domain.");
      idOk = true; idDetail = `Wallet ${m.issuer.wallet.slice(0, 6)}… and ML-DSA key ${m.issuer.keyHash.slice(0, 10)}… dual-signed the registration on ${m.cluster}.`;
    } catch (e) { idDetail = (e as Error).message; }
    checks.push({ id: "identity", label: "Dual-signature identity binding", status: idOk ? "pass" : "fail", detail: idDetail });
    const sigOk = verifyReceiptSignature(m, b.data.publicKey, b.data.signature);
    checks.push({ id: "signature", label: "ML-DSA-65 receipt signature", status: sigOk ? "pass" : "fail", detail: sigOk ? "Valid signature with the research-receipt context. It shows which key attested these bytes, not that the strategy is good." : "Signature is not valid for this manifest, key and research-receipt context." });
    if (!SUPPORTED_ENGINES.includes(m.source.engineVersion as any)) checks.push({ id: "replay", label: "Deterministic replay", status: "unsupported", detail: `Engine ${m.source.engineVersion} is not supported by this build; replay unavailable.` });
    else { const r = verifyBundle(b.data.experiment); checks.push({ id: "replay", label: "Deterministic replay", status: r.status === "verified" ? "pass" : r.status === "unsupported" ? "unsupported" : "fail", detail: r.detail }); }
    checks.push({ id: "anchor", label: "Optional Memo anchor", status: "unavailable", detail: b.data.anchorHint ? "An unsigned anchor hint is present; check it against an RPC you choose." : "No anchor was recorded. Anchoring is optional." });
    const valid = checks.filter((c) => ["schema", "commitments", "identity", "signature"].includes(c.id)).every((c) => c.status === "pass") && checks.find((c) => c.id === "replay")!.status !== "fail";
    return { checks, manifest: m, bundle: b.data, valid };
  } catch (e) { return fail(`Could not check receipt: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
}

export interface AnchorReader { genesis(): Promise<string>; tx(sig: string): Promise<{ status: "ok"; tx: { slot: number; err: unknown; signers: string[]; ixs: { program: string; data: Uint8Array }[] } } | { status: "missing" } | { status: "unsupported"; reason: string }> }
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Re-reads the claimed anchor from a caller-chosen RPC. The hint's slot/signature are never trusted. */
export async function verifyAnchor(m: ReceiptManifestT, manifestHash: string, hint: { signature: string } | null, reader: AnchorReader): Promise<RCheck> {
  const c = (status: RStatus, detail: string): RCheck => ({ id: "anchor", label: "Optional Memo anchor", status, detail });
  if (!hint) return c("unavailable", "No anchor recorded.");
  let g: string, r: Awaited<ReturnType<AnchorReader["tx"]>>;
  try { g = await reader.genesis(); } catch { return c("unavailable", "RPC unreachable."); }
  if (g !== m.genesisHash) return c("fail", `RPC is on a different network than ${m.cluster}.`);
  try { r = await reader.tx(hint.signature); } catch { return c("unavailable", "RPC could not read the transaction."); }
  if (r.status === "missing") return c("unavailable", "Transaction not found at confirmed commitment on this RPC.");
  if (r.status === "unsupported") return c("unsupported", r.reason);
  const t = r.tx;
  if (t.err) return c("fail", "The anchor transaction failed on chain.");
  if (!t.signers.includes(m.issuer.wallet)) return c("fail", "The issuer wallet did not sign the anchor transaction.");
  const memos = t.ixs.filter((x) => x.program === MEMO_PROGRAM).map((x) => new TextDecoder().decode(x.data));
  if (!memos.includes(receiptMemo(manifestHash))) return c("fail", "No Memo instruction commits this receipt hash.");
  return c("pass", `Memo in slot ${t.slot} commits this receipt hash, signed by the issuer wallet. Solana records the hash; it does not verify ML-DSA.`);
}
