// Portable, versioned launch evidence bundle and a standalone verifier.
// The verifier never consults Fleuri's database: it re-derives every chain fact through an
// injected reader (a caller-selected RPC + IPFS gateway in the browser or CLI). Claimed hashes,
// addresses and observations inside the bundle are treated as hints and re-checked.
import { z } from "zod";
import { canonicalize, sha256Hex, utf8 } from "./canonical";
import { DBC_PROGRAM_ID, verifyPassportOffline, type Check, type PassportManifest, type SignedPassportT } from "./passport";
import { GENESIS, anchorMemo, validateIdentityProof, type Cluster } from "./registration";
import type { ReadTx } from "./chain-read";

export const BUNDLE_FORMAT = "fleuri.evidence-bundle/v1";
export const MAX_BUNDLE_BYTES = 120_000;
const sig = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
const h64 = z.string().regex(/^[0-9a-f]{64}$/);

export const EvidenceBundle = z.object({
  format: z.literal(BUNDLE_FORMAT),
  exportedAt: z.string().max(40),
  cluster: z.enum(["devnet", "mainnet-beta"]),
  passport: z.unknown(),
  registration: z.object({
    ownerId: z.string().uuid(),
    statement: z.string().max(16384),
    publicKey: z.string().max(4096),
    walletSignature: z.string().max(200),
    pqSignature: z.string().max(6000),
    registrationHash: h64,
  }).strict(),
  anchorSignature: sig,
  launchSignature: sig,
  metadata: z.object({ uri: z.string().max(200), sha256: h64 }).strict(),
  image: z.object({ uri: z.string().max(200), sha256: h64.nullable() }).strict(),
  // Informational only; the verifier never trusts these.
  observations: z.array(z.unknown()).max(200).optional(),
}).strict();
export type EvidenceBundleT = z.infer<typeof EvidenceBundle>;

export type TxRead = { status: "ok"; tx: ReadTx } | { status: "missing" } | { status: "unsupported"; reason: string };
export interface EvidenceReader {
  genesis(): Promise<string>;
  tx(signature: string): Promise<TxRead>;
  dbcConfig(address: string): Promise<{ problems: string[]; terms: any; snapshot: Record<string, unknown>; snapshotHash: string }>;
  metadata(mint: string): Promise<{ name: string; symbol: string; uri: string; isMutable: boolean; updateAuthority: string } | null>;
  mint(mint: string): Promise<{ decimals: number; supply: bigint; mintAuthority: string | null; freezeAuthority: string | null }>;
  derivePool(mint: string, config: string): string;
  ipfs(uri: string, maxBytes: number): Promise<Uint8Array>;
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export function configTermsMatch(r: { problems: string[]; terms: any; snapshot: unknown; snapshotHash: string }, m: PassportManifest) {
  const expected = { config: { address: m.config.address, snapshotHash: r.snapshotHash, snapshot: r.snapshot }, fees: r.terms.fees, lp: r.terms.lp, migration: r.terms.migration, authority: r.terms.authority, decimals: r.terms.decimals, totalSupply: r.terms.totalSupply };
  const got = { config: m.config, fees: m.fees, lp: m.lp, migration: m.migration, authority: m.authority, decimals: m.token.decimals, totalSupply: m.token.totalSupply };
  return r.problems.length === 0 && canonicalize(expected) === canonicalize(got);
}

const contains = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return true; }
  return false;
};

export function parseBundle(raw: unknown): EvidenceBundleT {
  if (utf8(canonicalize(raw)).length > MAX_BUNDLE_BYTES) throw new Error("Evidence bundle too large.");
  const r = EvidenceBundle.safeParse(raw);
  if (!r.success) throw new Error(`Not a Fleuri evidence bundle: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  return r.data;
}

/**
 * Verifies a bundle without Fleuri's database. Any reader failure becomes `unavailable`;
 * only an actual mismatch between re-read chain/IPFS data and signed terms becomes `fail`.
 */
export async function verifyBundle(raw: unknown, reader: EvidenceReader): Promise<{ checks: Check[]; passport: SignedPassportT | null; observedAt: string }> {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: Check["status"], detail: string) => checks.push({ id, label, status, detail });
  const observedAt = new Date().toISOString();
  let b: EvidenceBundleT;
  try { b = parseBundle(raw); } catch (e) { add("bundle", "Bundle format", "fail", (e as Error).message); return { checks, passport: null, observedAt }; }
  const off = verifyPassportOffline(b.passport);
  checks.push(...off.checks);
  if (!off.passport || off.checks.some((c) => c.status !== "pass")) return { checks, passport: off.passport, observedAt };
  const p = off.passport; const m = p.manifest;
  if (m.cluster !== b.cluster) { add("bundle", "Bundle format", "fail", "Bundle network differs from the signed passport."); return { checks, passport: p, observedAt }; }

  // Registration: rebuild the identity solely from the signed statement.
  let regOk = false;
  try {
    const prefix = "Fleuri PQ identity registration\n";
    const f = JSON.parse(b.registration.statement.slice(prefix.length));
    validateIdentityProof({ owner_id: b.registration.ownerId, wallet: f.wallet, cluster: f.cluster, genesis_hash: f.genesisHash, public_key: b.registration.publicKey, key_hash: f.pqKeyHash, statement: b.registration.statement, registration_hash: b.registration.registrationHash, wallet_signature: b.registration.walletSignature, pq_signature: b.registration.pqSignature }, m.domain);
    if (b.registration.publicKey !== p.publicKey || b.registration.registrationHash !== m.identity.registrationHash || f.wallet !== m.creatorWallet || f.cluster !== m.cluster || f.pqKeyHash !== m.identity.keyHash) throw new Error("Registration names a different wallet, key or network than the passport.");
    regOk = true;
    add("registration", "Dual-signature registration", "pass", "Wallet (Ed25519) and ML-DSA-65 signatures over the same statement verify offline.");
  } catch (e) { add("registration", "Dual-signature registration", "fail", (e as Error).message); }

  let net = false;
  try {
    const g = await reader.genesis();
    net = g === GENESIS[m.cluster as Cluster];
    add("network", "Network genesis", net ? "pass" : "fail", net ? `RPC genesis matches ${m.cluster}.` : `RPC is on a different network (genesis ${g}).`);
  } catch (e) { add("network", "Network genesis", "unavailable", `RPC unreachable: ${(e as Error).message.slice(0, 120)}`); }
  const chainSkip = (id: string, label: string) => add(id, label, "unavailable", "Needs an RPC on the passport's network.");

  // Anchor: the passport names its anchor signature; the bundle copy must match it.
  if (!net) chainSkip("anchor", "Confirmed identity anchor (Memo)");
  else if (b.anchorSignature !== m.identity.anchorSignature) add("anchor", "Confirmed identity anchor (Memo)", "fail", "Bundle anchor signature differs from the one signed in the passport.");
  else if (!regOk) add("anchor", "Confirmed identity anchor (Memo)", "fail", "Registration proof is invalid.");
  else {
    try {
      const r = await reader.tx(b.anchorSignature);
      if (r.status === "missing") add("anchor", "Confirmed identity anchor (Memo)", "unavailable", "Anchor transaction not available from this RPC.");
      else if (r.status === "unsupported") add("anchor", "Confirmed identity anchor (Memo)", "unavailable", r.reason);
      else {
        const memo = r.tx.ixs.find((x) => x.program === MEMO);
        const ok = !r.tx.err && r.tx.signers.includes(m.creatorWallet) && !!memo && new TextDecoder().decode(memo.data) === anchorMemo(m.identity.registrationHash);
        add("anchor", "Confirmed identity anchor (Memo)", ok ? "pass" : "fail", ok ? `Registration hash anchored by the creator wallet in slot ${r.tx.slot}. Memo anchoring records the hash; Solana does not verify ML-DSA.` : "Memo text, signer or status does not match this identity.");
      }
    } catch (e) { add("anchor", "Confirmed identity anchor (Memo)", "unavailable", (e as Error).message.slice(0, 160)); }
  }

  const pool = reader.derivePool(m.token.baseMint, m.config.address);
  if (pool !== m.pool.address) add("pool", "Derived Meteora pool", "fail", "Signed pool address is not the DBC pool derived from mint + config.");
  else add("pool", "Derived Meteora pool", "pass", `Pool ${pool} derived independently from mint and config.`);

  if (!net) chainSkip("transaction", "Launch transaction");
  else {
    try {
      const r = await reader.tx(b.launchSignature);
      if (r.status === "missing") add("transaction", "Launch transaction", "unavailable", "Launch transaction not available from this RPC.");
      else if (r.status === "unsupported") add("transaction", "Launch transaction", "unavailable", r.reason);
      else {
        const ix = r.tx.ixs.find((x) => x.program === DBC_PROGRAM_ID && x.accounts.includes(m.token.baseMint) && x.accounts.includes(pool) && x.accounts.includes(m.config.address));
        const ok = !r.tx.err && r.tx.signers.includes(m.creatorWallet) && r.tx.signers.includes(m.token.baseMint) && !!ix && contains(ix.data, utf8(b.metadata.uri));
        add("transaction", "Launch transaction", ok ? "pass" : "fail", ok ? `Creator-signed DBC instruction creating this mint, config and pool with this metadata URI, confirmed in slot ${r.tx.slot}.` : "Transaction instructions, signers or metadata URI do not match the passport.");
      }
    } catch (e) { add("transaction", "Launch transaction", "unavailable", (e as Error).message.slice(0, 160)); }
  }

  if (!net) chainSkip("terms", "Signed economics vs config");
  else {
    try { const c = await reader.dbcConfig(m.config.address); const ok = configTermsMatch(c, m); add("terms", "Signed economics vs config", ok ? "pass" : "fail", ok ? "Full config snapshot, fees, LP split, supply and authorities match the account." : "On-chain config differs from the signed terms."); }
    catch (e) { add("terms", "Signed economics vs config", "unavailable", (e as Error).message.slice(0, 160)); }
  }

  if (!net) chainSkip("onchain", "Mint authorities and immutable metadata");
  else {
    try {
      const [meta, mint] = await Promise.all([reader.metadata(m.token.baseMint), reader.mint(m.token.baseMint)]);
      const ok = !!meta && meta.uri === b.metadata.uri && meta.name === m.token.name && meta.symbol === m.token.symbol && !meta.isMutable && meta.updateAuthority === SYSTEM_PROGRAM && mint.decimals === m.token.decimals && mint.supply <= BigInt(m.token.totalSupply) && !mint.mintAuthority && !mint.freezeAuthority;
      add("onchain", "Mint authorities and immutable metadata", ok ? "pass" : "fail", ok ? "Mint and freeze authorities revoked; metadata immutable and names this URI." : "Mint authority, metadata or supply differs from the signed policy.");
    } catch (e) { add("onchain", "Mint authorities and immutable metadata", "unavailable", (e as Error).message.slice(0, 160)); }
  }

  try {
    const bytes = await reader.ipfs(b.metadata.uri, 70_000);
    const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const imageCid = (typeof doc.image === "string" ? doc.image : "").match(/(?:^ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{46,100})$/)?.[1];
    const ok = sha256Hex(bytes) === b.metadata.sha256 && doc.name === m.token.name && doc.symbol === m.token.symbol && imageCid === m.token.imageUri.slice(7) && b.image.uri === m.token.imageUri && canonicalize(doc.properties?.fleuri_passport) === canonicalize(p);
    add("metadata", "Pinned metadata embeds this passport", ok ? "pass" : "fail", ok ? "Downloaded JSON hash matches and embeds this exact signed passport and image CID." : "Pinned JSON, its hash or embedded passport differs.");
    if (ok && m.token.imageSha256) {
      const img = await reader.ipfs(m.token.imageUri, 1_000_000);
      add("image", "Image content hash", sha256Hex(img) === m.token.imageSha256 ? "pass" : "fail", "Downloaded image compared with the signed SHA-256.");
    } else if (ok) add("image", "Image content hash", "unavailable", "Passport binds the image CID only; no separate SHA-256 was signed.");
  } catch (e) { add("metadata", "Pinned metadata embeds this passport", "unavailable", `Gateway: ${(e as Error).message.slice(0, 140)}`); }
  return { checks, passport: p, observedAt };
}

/** Bounded fetch of an immutable IPFS CID through a caller-chosen gateway (browser/CLI side). */
export async function gatewayFetch(gateway: string, uri: string, maxBytes: number) {
  const cid = uri.match(/(?:^ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{46,100})$/)?.[1];
  if (!cid) throw new Error("Not an immutable IPFS URI.");
  const g = new URL(gateway); if (g.protocol !== "https:" && g.hostname !== "localhost") throw new Error("Gateway must be https.");
  const r = await fetch(g.href.replace(/\/?$/, "/") + cid, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`gateway returned ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("Document too large.");
  return buf;
}
