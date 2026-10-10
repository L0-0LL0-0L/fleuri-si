// Living passports: dated current observations next to the immutable signed promises,
// plus portable evidence-bundle export. Observations are recorded append-only and deduplicated,
// only from confirmed-commitment reads.
import { DAMM_V2_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { canonicalize, sha256Hex } from "@/pq/canonical";
import { mapLifecycle } from "@/pq/chain-pure";
import { readUpgradeAuthority } from "@/pq/chain-read";
import { BUNDLE_FORMAT, SYSTEM_PROGRAM } from "@/pq/evidence";
import { DBC_PROGRAM_ID, type Check, type PassportManifest } from "@/pq/passport";
import * as sol from "./solana.server";

export type Fact = Check & { evidence?: string; group: "promise-kept" | "lifecycle" | "program" | "liquidity" };

async function db() { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); return supabaseAdmin as any; }
const must = (r: { data: any; error: any }) => { if (r.error) throw new Error(r.error.message); return r.data; };

async function loadByHash(hash: string) {
  const d = await db();
  const rec = must(await d.from("passports").select("*").eq("manifest_hash", hash).maybeSingle());
  if (!rec) throw new Error("No passport recorded with this hash.");
  const launch = must(await d.from("launches").select("*").eq("passport_id", rec.id).maybeSingle());
  const identity = must(await d.from("pq_identities").select("*").eq("id", rec.identity_id).maybeSingle());
  return { d, rec, launch, identity, m: rec.manifest as PassportManifest };
}

export async function observeLiving(hash: string) {
  const { d, rec, launch, m } = await loadByHash(hash);
  const facts: Fact[] = [];
  const add = (f: Fact) => facts.push(f);
  const e = sol.solEnv();
  if (!launch) return { facts, history: [], slot: null, observedAt: null, note: "No confirmed launch is recorded for this passport yet." };
  if (e.cluster !== m.cluster) return { facts, history: [], slot: null, observedAt: null, note: `Server reads ${e.cluster ?? "no network"}; passport is for ${m.cluster}.` };
  const conn = sol.connection();
  await sol.assertGenesis(conn, m.cluster);
  const slot = await conn.getSlot("confirmed");
  const observedAt = new Date().toISOString();
  const ev: { kind: string; facts: Record<string, unknown> }[] = [];
  const snap: Record<string, unknown> = {};

  try {
    const mint = await sol.readTokenMint(conn, m.token.baseMint);
    snap.mintAuthority = mint.mintAuthority; snap.freezeAuthority = mint.freezeAuthority; snap.supply = mint.supply.toString();
    add({ id: "mint-authority", group: "promise-kept", label: "Mint authority", status: mint.mintAuthority ? "fail" : "pass", detail: mint.mintAuthority ? `Retained by ${mint.mintAuthority}` : "Revoked — no one can mint more.", evidence: m.token.baseMint });
    add({ id: "freeze-authority", group: "promise-kept", label: "Freeze authority", status: mint.freezeAuthority ? "fail" : "pass", detail: mint.freezeAuthority ? `Retained by ${mint.freezeAuthority}` : "Revoked — no one can freeze holders.", evidence: m.token.baseMint });
  } catch (err) { add({ id: "mint-authority", group: "promise-kept", label: "Mint and freeze authorities", status: "unavailable", detail: (err as Error).message }); }
  try {
    const meta = await sol.readTokenMetadata(conn, m.token.baseMint);
    snap.metadataUri = meta?.uri; snap.metadataMutable = meta?.isMutable; snap.updateAuthority = meta?.updateAuthority;
    const ok = !!meta && !meta.isMutable && meta.updateAuthority === SYSTEM_PROGRAM && meta.uri === rec.metadata_uri;
    add({ id: "metadata", group: "promise-kept", label: "Metadata immutable", status: meta ? (ok ? "pass" : "fail") : "unavailable", detail: !meta ? "Metadata account not found." : ok ? "Immutable; still points to the pinned passport metadata." : `Mutable=${meta.isMutable}, update authority ${meta.updateAuthority}, URI ${meta.uri}`, evidence: m.token.baseMint });
  } catch (err) { add({ id: "metadata", group: "promise-kept", label: "Metadata immutable", status: "unavailable", detail: (err as Error).message }); }
  try {
    const cfg = await sol.readDbcConfig(conn, m.config.address);
    const fc = cfg.terms.fees.feeClaimer, lr = cfg.terms.authority.leftoverReceiver;
    add({ id: "fee-claimer", group: "promise-kept", label: "Config fee recipient", status: fc === m.fees.feeClaimer ? "pass" : "fail", detail: `Partner fee claimer ${fc}${fc === m.fees.feeClaimer ? " (as signed)" : `; signed ${m.fees.feeClaimer}`}`, evidence: m.config.address });
    add({ id: "leftover", group: "promise-kept", label: "Leftover receiver", status: lr === m.authority.leftoverReceiver ? "pass" : "fail", detail: lr, evidence: m.config.address });
  } catch (err) { add({ id: "fee-claimer", group: "promise-kept", label: "Config fee recipients", status: "unavailable", detail: (err as Error).message }); }
  try {
    const pool = await sol.readPool(conn, launch.pool);
    if (!pool) add({ id: "creator", group: "lifecycle", label: "Pool creator", status: "unavailable", detail: "DBC pool not readable." });
    else {
      snap.creator = pool.creator;
      const same = pool.creator === m.creatorWallet;
      if (!same) ev.push({ kind: "creator_changed", facts: { from: m.creatorWallet, to: pool.creator } });
      add({ id: "creator", group: "lifecycle", label: "Original vs current creator", status: "pass", detail: same ? `Unchanged: ${pool.creator}` : `Pool creator changed from the signed ${m.creatorWallet} to ${pool.creator}. The original creator signature remains valid for the launch.`, evidence: launch.pool });
      const life = mapLifecycle(pool); snap.lifecycle = life;
      if (life !== "curve_active") ev.push({ kind: "graduated", facts: { lifecycle: life === "damm_v2_live" ? "migrated" : life } });
      add({ id: "graduation", group: "lifecycle", label: "Graduation", status: life === "damm_v2_live" ? "pass" : "pending", detail: `${Number(pool.quoteReserve) / 1e9} / ${Number(pool.migrationQuoteThreshold) / 1e9} SOL · ${life.replace(/_/g, " ")}`, evidence: launch.pool });
      if (pool.dammV2Pool) {
        if (pool.dammV2Confirmed) ev.push({ kind: "damm_v2_confirmed", facts: { pool: pool.dammV2Pool } });
        add({ id: "damm", group: "lifecycle", label: "Derived DAMM v2 pool", status: pool.dammV2Confirmed ? "pass" : pool.isMigrated ? "pending" : "unavailable", detail: pool.dammV2Confirmed ? `Exists and is owned by DAMM v2: ${pool.dammV2Pool}` : `Derived address ${pool.dammV2Pool} has no DAMM v2 account yet.`, evidence: pool.dammV2Pool });
      }
    }
  } catch (err) { add({ id: "creator", group: "lifecycle", label: "Pool state", status: "unavailable", detail: (err as Error).message }); }
  for (const [id, label, prog] of [["dbc-upgrade", "Meteora DBC program", DBC_PROGRAM_ID], ["damm-upgrade", "Meteora DAMM v2 program", DAMM_V2_PROGRAM_ID.toBase58()]] as const) {
    try {
      const u = await readUpgradeAuthority(conn, prog);
      snap[id] = u.authority;
      add({ id, group: "program", label: `${label} upgrade authority`, status: "pass", detail: u.immutable ? "Immutable — code cannot change." : `Upgradeable by ${u.authority} (last deployed slot ${u.slot}). The program owner can change its code.`, evidence: u.programData ?? prog });
    } catch (err) { add({ id, group: "program", label: `${label} upgrade authority`, status: "unavailable", detail: (err as Error).message }); }
  }
  add({ id: "lp", group: "liquidity", label: "LP position and lock", status: "unavailable", detail: "Signed LP shares are a config promise. Fleuri does not yet decode DAMM v2 position/lock accounts, so current LP ownership and locks are not shown as proven." });

  // Append-only, deduplicated history from confirmed reads only.
  const rows = [{ kind: "snapshot", facts: snap }, ...ev].map((x) => ({ launch_id: launch.id, kind: x.kind, observed_slot: slot, observed_at: observedAt, facts: x.facts, digest: sha256Hex(new TextEncoder().encode(canonicalize(x.facts as any))) }));
  try { await d.from("passport_observations").upsert(rows, { onConflict: "launch_id,kind,digest", ignoreDuplicates: true }); } catch { /* history is best-effort */ }
  const history = must(await d.from("passport_observations").select("kind,observed_slot,observed_at,facts").eq("launch_id", launch.id).neq("kind", "snapshot").order("observed_slot", { ascending: true }).limit(50));
  return { facts, history, slot, observedAt, note: null };
}

export async function exportBundle(hash: string) {
  const { d, rec, launch, identity, m } = await loadByHash(hash);
  if (!launch) throw new Error("No confirmed launch yet; nothing to export.");
  if (!identity?.anchor_signature) throw new Error("Identity anchor is missing.");
  const history = must(await d.from("passport_observations").select("kind,observed_slot,observed_at,facts").eq("launch_id", launch.id).order("observed_slot").limit(200));
  return {
    format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), cluster: m.cluster,
    passport: { format: "fleuri.signed-passport/v1", manifest: rec.manifest, manifestHash: rec.manifest_hash, alg: "ML-DSA-65", publicKey: identity.public_key, signature: rec.signature },
    registration: { ownerId: identity.owner_id, statement: identity.statement, publicKey: identity.public_key, walletSignature: identity.wallet_signature, pqSignature: identity.pq_signature, registrationHash: identity.registration_hash },
    anchorSignature: identity.anchor_signature, launchSignature: launch.signature,
    metadata: { uri: rec.metadata_uri, sha256: rec.metadata_hash }, image: { uri: m.token.imageUri, sha256: m.token.imageSha256 },
    observations: history,
  };
}
