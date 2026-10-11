// Server-only Research Receipt orchestration. The server never receives a private key: it freezes
// a draft, verifies the browser's ML-DSA signature, and records results via service-role RPCs.
import { canonicalize } from "@/pq/canonical";
import { validateIdentityProof } from "@/pq/registration";
import { RECEIPT_BUNDLE_FORMAT, buildManifest, commitmentProblems, isLegacyManifest, parseReceiptManifest, receiptHash, receiptMemo, verifyReceiptBundle, verifyReceiptSignature, type IdentityProof } from "@/pq/receipt";
import { bundleFromStored, verifyBundle } from "@/domain/greenhouse";

const RUN_COLS = "id,owner_id,status,created_at,finished_at,input,output,input_hash,output_hash,content_hash";
const ID_COLS = "id,owner_id,wallet,cluster,genesis_hash,public_key,key_hash,statement,registration_hash,wallet_signature,pq_signature,status,anchor_signature";
export const PUBLIC_COLS = "id,status,manifest,manifest_hash,experiment,public_key,signature,identity_proof,signed_at,published,published_at,anchor_status,anchor_signature,anchor_slot,anchored_at,created_at";
const must = (r: { data: any; error: any }, msg = "Database error") => { if (r.error) throw new Error(`${msg}: ${r.error.message}`); return r.data; };
const proofOf = (i: any): IdentityProof => ({ owner_id: i.owner_id, wallet: i.wallet, cluster: i.cluster, genesis_hash: i.genesis_hash, public_key: i.public_key, key_hash: i.key_hash, statement: i.statement, registration_hash: i.registration_hash, wallet_signature: i.wallet_signature, pq_signature: i.pq_signature });

/** Freeze (or recover) a draft for the caller's own completed trial. Never reads live agents. */
export async function prepareReceipt(db: any, owner: string, input: { requestId: string; runId: string; identityId: string }, domain: string, now = () => new Date()) {
  const existing = must(await db.from("research_receipts").select("id,status,run_id,identity_id,manifest,manifest_hash").eq("owner_id", owner).eq("request_id", input.requestId).maybeSingle());
  if (existing) {
    if (existing.run_id !== input.runId || existing.identity_id !== input.identityId) throw new Error("This request id was already used for a different trial or identity.");
    return { id: existing.id, status: existing.status, manifest: existing.manifest, manifestHash: existing.manifest_hash, recovered: true };
  }
  const run = must(await db.from("greenhouse_runs").select(RUN_COLS).eq("id", input.runId).eq("owner_id", owner).maybeSingle());
  if (!run || run.status !== "done" || !run.output) throw new Error("Only your own completed, saved trials can be attested.");
  const experiment = bundleFromStored(run);
  const replay = verifyBundle(experiment);
  if (replay.status === "unsupported") throw new Error(`This trial uses an engine this build cannot replay (${run.input?.engineVersion}). Receipts require exact replay.`);
  if (replay.status !== "verified") throw new Error(`The stored trial failed exact replay: ${replay.detail}`);
  const idt = must(await db.from("pq_identities").select(ID_COLS).eq("id", input.identityId).eq("owner_id", owner).maybeSingle());
  if (!idt || idt.status === "revoked") throw new Error("Choose one of your registered PQ identities.");
  const f = validateIdentityProof(proofOf(idt));
  if (f.domain !== domain) throw new Error("This identity was registered for a different Fleuri domain.");
  const receiptId = crypto.randomUUID();
  const manifest = buildManifest({ run, experiment, identity: proofOf(idt), receiptId, createdAt: now().toISOString(), domain });
  const manifestHash = receiptHash(manifest);
  const r = must(await db.rpc("research_create_draft", { _owner: owner, _request: input.requestId, _r: { id: receiptId, run_id: run.id, identity_id: idt.id, manifest, manifest_hash: manifestHash, experiment } }), "Could not save the draft");
  return { id: r.id, status: r.status, manifest: r.manifest, manifestHash: r.manifest_hash, recovered: !r.created };
}

/** Verify everything independently, then record. A lost response can be retried with the same or a fresh valid signature. */
export async function submitReceiptSignature(db: any, owner: string, input: { id: string; publicKey: string; signature: string }) {
  const row = must(await db.from("research_receipts").select("id,owner_id,status,run_id,identity_id,manifest,manifest_hash,experiment,public_key").eq("id", input.id).eq("owner_id", owner).maybeSingle());
  if (!row) throw new Error("Receipt draft not found in your workspace.");
  const m = parseReceiptManifest(row.manifest);
  if (receiptHash(m) !== row.manifest_hash) throw new Error("Stored draft is inconsistent with its hash.");
  const idt = must(await db.from("pq_identities").select(ID_COLS).eq("id", row.identity_id).eq("owner_id", owner).maybeSingle());
  if (!idt || idt.status === "revoked") throw new Error("The draft's identity is no longer available.");
  validateIdentityProof(proofOf(idt), m.domain);
  if (idt.public_key !== input.publicKey || idt.key_hash !== m.issuer.keyHash || idt.wallet !== m.issuer.wallet || idt.registration_hash !== m.issuer.registrationHash) throw new Error("The signing key is not the identity named in this draft.");
  if (!verifyReceiptSignature(m, input.publicKey, input.signature)) throw new Error("ML-DSA-65 receipt signature is invalid for this exact draft.");
  const probs = commitmentProblems(m, row.experiment);
  if (probs.length) throw new Error(`Draft no longer matches its experiment: ${probs.join("; ")}`);
  const run = must(await db.from("greenhouse_runs").select("id,input_hash,output_hash,content_hash").eq("id", row.run_id).eq("owner_id", owner).maybeSingle());
  if (!run || run.input_hash !== m.source.inputHash || run.output_hash !== m.source.outputHash || run.content_hash !== m.source.contentHash) throw new Error("Source trial no longer matches the draft.");
  if (verifyBundle(row.experiment).status !== "verified") throw new Error("Experiment no longer replays exactly.");
  const r = must(await db.rpc("research_sign", { _owner: owner, _id: row.id, _hash: row.manifest_hash, _public_key: input.publicKey, _signature: input.signature, _proof: proofOf(idt) }), "Could not record the signature");
  return { id: r.id, status: r.status, recovered: !r.applied };
}

export function exportBundle(row: any) {
  if (row.status !== "signed") throw new Error("Only signed receipts can be exported.");
  return {
    format: RECEIPT_BUNDLE_FORMAT, manifest: row.manifest, manifestHash: row.manifest_hash, alg: "ML-DSA-65",
    publicKey: row.public_key, signature: row.signature, identityProof: row.identity_proof, experiment: row.experiment,
    anchorHint: row.anchor_status === "confirmed" && row.anchor_signature ? { signature: row.anchor_signature, slot: row.anchor_slot == null ? null : Number(row.anchor_slot), memo: receiptMemo(row.manifest_hash) } : null,
  };
}

/** Confirmation hook for chain_preparations kind receipt_anchor; called after message/signer checks. */
export async function confirmReceiptAnchor(db: any, prep: any, tx: { slot: number; err: unknown; signers: string[]; ixs: { program: string; data: Uint8Array }[] }, memoProgram: string, ownerId: string) {
  const row = must(await db.from("research_receipts").select("id,manifest,manifest_hash,anchor_preparation_id,anchor_status").eq("id", prep.subject).eq("owner_id", ownerId).maybeSingle());
  if (!row || row.anchor_preparation_id !== prep.id) throw new Error("This preparation is not linked to your receipt.");
  const memo = receiptMemo(row.manifest_hash);
  const memos = tx.ixs.filter((x) => x.program === memoProgram).map((x) => new TextDecoder().decode(x.data));
  if (prep.payload?.memo !== memo || !memos.includes(memo)) throw new Error("Memo does not commit this receipt's hash.");
  if (!tx.signers.includes(row.manifest.issuer.wallet)) throw new Error("The receipt issuer wallet did not sign the anchor.");
  const ok = !tx.err;
  const r = must(await db.rpc("research_record_anchor", { _owner: ownerId, _id: row.id, _prep: prep.id, _ok: ok, _signature: prep.signature, _slot: tx.slot }));
  if (!ok) throw new Error(`Anchor transaction failed on chain: ${canonicalize(JSON.parse(JSON.stringify(tx.err)))}`);
  return { status: "confirmed" as const, detail: `Receipt hash anchored in slot ${tx.slot}${r.applied ? "" : " (already recorded)"}. Solana records the hash; signature validity is checked off-chain.`, id: row.id };
}

/** The message bytes to simulate: always the stored preparation's own message (never a fresh rebuild). */
export function anchorCostTarget(prep: { message_b64: string }, decode: (s: string) => Uint8Array) {
  if (!prep?.message_b64) throw new Error("Preparation has no stored message.");
  return decode(prep.message_b64);
}

/** Owner-only exact draft recovery by receipt id: the stored request/identity/hash binding is returned
 * to the owner so a different device resumes THIS draft instead of freezing a new one. */
export async function resumeDraft(db: any, owner: string, id: string) {
  const row = must(await db.from("research_receipts").select("id,owner_id,status,run_id,identity_id,request_id,manifest,manifest_hash").eq("id", id).eq("owner_id", owner).maybeSingle());
  if (!row || row.owner_id !== owner) throw new Error("Receipt draft not found in your workspace.");
  const m = parseReceiptManifest(row.manifest);
  if (receiptHash(m) !== row.manifest_hash) throw new Error("Stored draft is inconsistent with its hash.");
  if (m.source.runId !== row.run_id || m.receiptId !== row.id) throw new Error("Stored draft is not bound to its trial.");
  const idt = must(await db.from("pq_identities").select("id,key_hash,wallet,status").eq("id", row.identity_id).eq("owner_id", owner).maybeSingle());
  if (!idt || idt.key_hash !== m.issuer.keyHash || idt.wallet !== m.issuer.wallet) throw new Error("The draft's identity no longer matches.");
  return { id: row.id, status: row.status as string, runId: row.run_id as string, identityId: row.identity_id as string, requestId: row.request_id as string, manifest: m, manifestHash: row.manifest_hash as string };
}

/** Proposal-review receipt evidence: only caller-owned receipts that FULLY verify offline and are bound
 * to the same stored run checksums. Anchors are reported as recorded metadata, never chain-verified here. */
export async function verifiedEvidenceForRuns(db: any, owner: string, runIds: string[]) {
  if (!runIds.length) return [];
  const rows = must(await db.from("research_receipts").select(`${PUBLIC_COLS},run_id,owner_id`).eq("owner_id", owner).eq("status", "signed").in("run_id", runIds).limit(20));
  const runs = must(await db.from("greenhouse_runs").select("id,input_hash,output_hash,content_hash").eq("owner_id", owner).in("id", runIds));
  const byRun = new Map<string, any>((runs as any[]).map((r) => [r.id, r]));
  const out: any[] = [];
  for (const row of rows as any[]) {
    if (row.owner_id !== owner) continue;
    let v; try { v = verifyReceiptBundle(exportBundle(row)); } catch { continue; }
    const run = byRun.get(row.run_id); const m = v.manifest;
    if (!v.valid || !m || !run || m.source.runId !== row.run_id || m.source.inputHash !== run.input_hash || m.source.outputHash !== run.output_hash || m.source.contentHash !== run.content_hash) continue;
    out.push({ id: row.id, run_id: row.run_id, manifest_hash: row.manifest_hash, schema: m.schema, legacy: isLegacyManifest(m), signed_at: row.signed_at, published: row.published,
      issuer_key: m.issuer.keyHash, engine_version: m.source.engineVersion, policies: m.trial.policies.map((p) => ({ agentId: p.agentId, policyHash: p.policyHash })),
      verified: { signature: true, integrity: true, identity: true, replay: v.checks.find((c) => c.id === "replay")!.status as "pass" | "unsupported" },
      anchor: { recorded: row.anchor_status as string, signature: row.anchor_signature as string | null, chainVerified: false as const } });
  }
  return out;
}
