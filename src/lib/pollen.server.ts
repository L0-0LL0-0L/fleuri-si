import bs58 from "bs58";
// Pollen: real Meteora Dynamic Fee Sharing vaults. Builds reviewed, simulated, unsigned SDK
// transactions; the owner's wallet signs (plus a browser-generated base key for PDA creation).
import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicFeeSharingClient, deriveFeeVaultPdaAddress } from "@meteora-ag/dynamic-fee-sharing-sdk";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DFS_PROGRAM_ID, POLLEN_MINTS, claimable, pdaProblems, dfsEvents, compareVault, dbcPartnerRouting, parseAmount, parseTerms, type PollenTermsT } from "@/pq/pollen";
import { isSolanaAddress } from "@/pq/registration";
import { DBC_PROGRAM_ID } from "@/pq/passport";
import * as sol from "./solana.server";

async function db() { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); return supabaseAdmin as any; }
const must = (r: { data: any; error: any }) => { if (r.error) throw new Error(r.error.message); return r.data; };
const pk = (s: string, what: string) => { if (!isSolanaAddress(s)) throw new Error(`Invalid ${what}.`); return new PublicKey(s); };
const NULL_KEY = "11111111111111111111111111111111";

async function ready() {
  const e = sol.solEnv();
  if (!e.cluster) throw new Error("SOLANA_CLUSTER is invalid.");
  const conn = sol.connection();
  await sol.assertGenesis(conn, e.cluster);
  const prog = await conn.getAccountInfo(new PublicKey(DFS_PROGRAM_ID));
  if (!prog?.executable) throw new Error("Meteora Dynamic Fee Sharing is not deployed on this cluster.");
  return { conn, cluster: e.cluster };
}

/** Reads a vault from chain; throws unless it is a DFS account for a supported mint. */
export async function readVault(conn: Connection, address: string) {
  const a = pk(address, "vault address");
  const info = await conn.getAccountInfo(a);
  if (!info) throw new Error("No account at this address.");
  if (info.owner.toBase58() !== DFS_PROGRAM_ID) throw new Error("This account is not owned by Meteora Dynamic Fee Sharing.");
  const client = new DynamicFeeSharingClient(conn, "confirmed");
  const v: any = await client.getFeeVault(a);
  const mint = v.tokenMint.toBase58();
  const mintInfo = await conn.getAccountInfo(v.tokenMint);
  const supported = mint in POLLEN_MINTS && mintInfo?.owner.equals(TOKEN_PROGRAM_ID);
  // Exact program math from on-chain checkpoints; not the SDK's lifetime-funds approximation.
  const fps = BigInt(v.feePerShare.toString());
  const users = (v.users as any[]).filter((u) => u.address.toBase58() !== NULL_KEY && Number(u.share) > 0).map((u) => {
    const share = BigInt(u.share.toString()); const claimed = BigInt(u.feeClaimed.toString());
    const unclaimed = claimable(share, fps, BigInt(u.feePerShareCheckpoint.toString()));
    return { address: u.address.toBase58(), share: Number(share), claimed: claimed.toString(), unclaimed: unclaimed.toString(), earned: (claimed + unclaimed).toString() };
  });
  const totalClaimed = users.reduce((a, u) => a + BigInt(u.claimed), 0n);
  const totalUnclaimed = users.reduce((a, u) => a + BigInt(u.unclaimed), 0n);
  const b = { totalFundedFee: v.totalFundedFee.toString(), totalClaimedFee: totalClaimed.toString(), totalUnclaimedFee: totalUnclaimed.toString() };
  return {
    address, mint, supported: !!supported, symbol: POLLEN_MINTS[mint]?.symbol ?? "unsupported", decimals: POLLEN_MINTS[mint]?.decimals ?? null,
    feeVaultType: Number(v.feeVaultType), pdaIssues: pdaProblems({ feeVaultType: Number(v.feeVaultType), derived: deriveFeeVaultPdaAddress(v.base, v.tokenMint).toBase58(), address }),
    owner: v.owner.toBase58(), base: v.base.toBase58(), tokenVault: v.tokenVault.toBase58(), totalShare: Number(v.totalShare),
    funded: b.totalFundedFee, claimed: b.totalClaimedFee, unclaimed: b.totalUnclaimedFee, dust: (BigInt(b.totalFundedFee) - BigInt(b.totalClaimedFee) - BigInt(b.totalUnclaimedFee)).toString(), feePerShare: fps.toString(),
    recipients: users,
    // Recipient address by on-chain user index ("" for empty slots); claim events reference this index.
    recipientSlots: (v.users as any[]).map((u) => (u.address.toBase58() === NULL_KEY ? "" : u.address.toBase58())),
  };
}

export async function inspect(address: string) {
  const { conn, cluster } = await ready();
  const slot = await conn.getSlot("confirmed");
  const vault = await readVault(conn, address);
  const d = await db();
  const assoc = must(await d.from("pollen_associations").select("launch_id,wallet,created_at,launches(base_mint,pool,config)").eq("vault", address));
  return { cluster, slot, vault, associations: assoc };
}

export async function prepareCreate(savePrep: SavePrep, ownerId: string, input: { wallet: string; base: string; terms: unknown }) {
  const terms = parseTerms(input.terms);
  const { conn, cluster } = await ready();
  const wallet = pk(input.wallet, "wallet"), base = pk(input.base, "base key"), mint = new PublicKey(terms.mint);
  if (!(await conn.getAccountInfo(mint))?.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("Mint is not a standard SPL Token on this cluster.");
  const vault = deriveFeeVaultPdaAddress(base, mint).toBase58();
  if (await conn.getAccountInfo(new PublicKey(vault))) throw new Error("A vault already exists for this base key; generate a new one.");
  const client = new DynamicFeeSharingClient(conn, "confirmed");
  const tx = await client.createFeeVaultPda({ base, tokenMint: mint, tokenProgram: TOKEN_PROGRAM_ID, owner: wallet, payer: wallet, userShare: terms.recipients.map((r) => ({ address: new PublicKey(r.address), share: r.bps })) });
  const built = sol.finalizeUnsigned(tx, wallet, await conn.getLatestBlockhash("confirmed"), [input.wallet, input.base], [DFS_PROGRAM_ID]);
  const cost = await sol.estimateWalletCost(conn, built.message, input.wallet);
  const prep = await savePrep(ownerId, "pollen_create", input.wallet, vault, built, { terms, vault, base: input.base });
  return { preparationId: prep.id, expiresAt: prep.expires_at, transaction: sol.unsignedB64(built.tx), cluster, vault, terms, cost };
}

export async function prepareFund(savePrep: SavePrep, ownerId: string, input: { wallet: string; vault: string; amount: string }) {
  const { conn, cluster } = await ready();
  const v = await readVault(conn, input.vault);
  if (!v.supported || v.decimals == null) throw new Error("Vault token is not supported for funding here.");
  const amount = parseAmount(input.amount, v.decimals);
  const client = new DynamicFeeSharingClient(conn, "confirmed");
  const tx = await client.fundFeeVault({ fundAmount: new BN(amount.toString()), funder: pk(input.wallet, "wallet"), feeVault: new PublicKey(input.vault) });
  const built = sol.finalizeUnsigned(tx, new PublicKey(input.wallet), await conn.getLatestBlockhash("confirmed"), [input.wallet], [DFS_PROGRAM_ID]);
  const cost = await sol.estimateWalletCost(conn, built.message, input.wallet);
  if (!cost.ok) throw new Error(cost.error);
  const prep = await savePrep(ownerId, "pollen_fund", input.wallet, input.vault, built, { vault: input.vault, amount: amount.toString(), fundedBefore: v.funded });
  return { preparationId: prep.id, transaction: sol.unsignedB64(built.tx), cluster, amount: amount.toString(), symbol: v.symbol, decimals: v.decimals, cost };
}

export async function prepareClaim(savePrep: SavePrep, ownerId: string, input: { wallet: string; vault: string }) {
  const { conn, cluster } = await ready();
  const v = await readVault(conn, input.vault);
  const me = v.recipients.find((r) => r.address === input.wallet);
  if (!v.supported) throw new Error("Only USDC and wrapped-SOL vaults are supported for claims here.");
  if (!me) throw new Error("The connected wallet is not a recipient of this vault.");
  if (BigInt(me.unclaimed) === 0n) throw new Error("Nothing unclaimed for this wallet yet.");
  const client = new DynamicFeeSharingClient(conn, "confirmed");
  const tx = await client.claimUserFee({ feeVault: new PublicKey(input.vault), user: new PublicKey(input.wallet), payer: new PublicKey(input.wallet) });
  const built = sol.finalizeUnsigned(tx, new PublicKey(input.wallet), await conn.getLatestBlockhash("confirmed"), [input.wallet], [DFS_PROGRAM_ID]);
  const cost = await sol.estimateWalletCost(conn, built.message, input.wallet);
  if (!cost.ok) throw new Error(cost.error);
  const prep = await savePrep(ownerId, "pollen_claim", input.wallet, input.vault, built, { vault: input.vault, expected: me.unclaimed, claimedBefore: me.claimed });
  return { preparationId: prep.id, transaction: sol.unsignedB64(built.tx), cluster, expected: me.unclaimed, symbol: v.symbol, decimals: v.decimals, cost };
}

/** DBC partner-fee routing eligibility for a launch's pool into a vault. */
export async function routingFor(conn: Connection, launch: { pool: string; config: string }, vaultAddr: string, signer: string) {
  const v = await readVault(conn, vaultAddr);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  const cfg: any = await dbc.state.getPoolConfig(new PublicKey(launch.config));
  const pool = await sol.readPool(conn, launch.pool);
  return { vault: v, ...dbcPartnerRouting({ feeClaimer: cfg.feeClaimer.toBase58(), quoteMint: cfg.quoteMint.toBase58(), collectFeeMode: Number(cfg.collectFeeMode), vault: vaultAddr, vaultMint: v.mint, signer, recipients: v.recipients.map((r) => r.address), migrated: pool?.isMigrated === 1, pdaIssues: v.pdaIssues }) };
}

export async function prepareRoute(savePrep: SavePrep, ownerId: string, input: { wallet: string; vault: string; launchId: string }) {
  const { conn, cluster } = await ready();
  const d = await db();
  const launch = must(await d.from("launches").select("*").eq("id", input.launchId).maybeSingle());
  if (!launch) throw new Error("Launch not found.");
  const r = await routingFor(conn, launch, input.vault, input.wallet);
  if (!r.eligible) throw new Error(r.reasons.join(" "));
  const client = new DynamicFeeSharingClient(conn, "confirmed");
  const tx = await client.fundByClaimDbcPartnerTradingFee({ signer: new PublicKey(input.wallet), feeClaimer: new PublicKey(input.vault), feeVault: new PublicKey(input.vault), poolConfig: new PublicKey(launch.config), virtualPool: new PublicKey(launch.pool) });
  const built = sol.finalizeUnsigned(tx, new PublicKey(input.wallet), await conn.getLatestBlockhash("confirmed"), [input.wallet], [DFS_PROGRAM_ID]);
  const cost = await sol.estimateWalletCost(conn, built.message, input.wallet);
  if (!cost.ok) throw new Error(cost.error);
  const prep = await savePrep(ownerId, "pollen_route", input.wallet, input.vault, built, { vault: input.vault, launchId: launch.id, fundedBefore: r.vault.funded });
  return { preparationId: prep.id, transaction: sol.unsignedB64(built.tx), cluster, cost };
}

/** Confirmation branch: re-reads the vault and accepts only proven on-chain effects. */
export async function confirmPollen(prep: any, tx: { slot: number; ixs: { program: string }[]; signers: string[] }, conn: Connection, ownerId: string) {
  const d = await db();
  if (!tx.ixs.some((x) => x.program === DFS_PROGRAM_ID)) throw new Error("Confirmed transaction did not call Dynamic Fee Sharing.");
  const done = async (detail: string) => { must(await d.from("chain_preparations").update({ confirmed_at: new Date().toISOString(), payload: { ...prep.payload, verifiedSlot: tx.slot } }).eq("id", prep.id).eq("owner_id", ownerId)); return { status: "confirmed" as const, detail, id: prep.subject }; };
  const v = await readVault(conn, prep.subject);
  if (prep.kind === "pollen_create") {
    if (!tx.signers.includes(prep.payload.base)) throw new Error("The reviewed base key did not sign.");
    const issues = compareVault({ mint: v.mint, owner: v.owner, users: v.recipients }, prep.payload.terms as PollenTermsT, prep.wallet);
    if (issues.length) throw new Error(`On-chain vault differs from the reviewed terms: ${issues.join(", ")}`);
    must(await d.from("pollen_vaults").upsert({ address: v.address, cluster: prep.cluster, mint: v.mint, owner_wallet: v.owner, base: v.base, created_signature: prep.signature, recorded_by: ownerId, recipients: v.recipients.map((r) => ({ address: r.address, bps: r.share })) }, { onConflict: "address", ignoreDuplicates: true }));
    return done(`Vault ${v.address} created in slot ${tx.slot}; allocations match exactly and are now fixed.`);
  }
  // Attribute only this transaction's own DFS events (emit_cpi), never a global counter delta.
  const t = await conn.getTransaction(prep.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t?.meta) return { status: "pending" as const, detail: "Waiting for the confirmed transaction…" };
  if (t.meta.err) throw new Error(`Transaction failed on chain: ${JSON.stringify(t.meta.err)}`);
  const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses ?? undefined });
  const inner = (t.meta.innerInstructions ?? []).flatMap((g) => g.instructions).filter((ix) => keys.get(ix.programIdIndex)?.toBase58() === DFS_PROGRAM_ID).map((ix) => bs58.decode(ix.data));
  const evs = dfsEvents(inner, (b) => bs58.encode(b)).filter((e) => e.vault === prep.subject);
  if (prep.kind === "pollen_fund" || prep.kind === "pollen_route") {
    const f = evs.find((e) => e.kind === "fund");
    const extra = prep.kind === "pollen_fund" && f && f.amount.toString() !== prep.payload.amount ? ` (requested ${prep.payload.amount}; the program funds min(requested, your balance))` : "";
    return done(f ? `Confirmed in slot ${tx.slot}: this transaction funded ${f.amount} base units${extra}. Vault total now ${v.funded}.` : `Confirmed in slot ${tx.slot}; the funding event could not be decoded, so no amount is attributed to this transaction. Vault total now ${v.funded}.`);
  }
  if (prep.kind === "pollen_claim") {
    const c = evs.find((e) => e.kind === "claim" && e.user === prep.wallet);
    return done(c ? `Claimed ${c.amount} base units in slot ${tx.slot}.` : `Confirmed in slot ${tx.slot}; the claim event could not be decoded, so no amount is attributed.`);
  }
  throw new Error("Unknown Pollen action.");
}

export async function importVault(ownerId: string, address: string) {
  const { conn, cluster } = await ready();
  const v = await readVault(conn, address);
  if (!v.supported) throw new Error("Only USDC and wrapped-SOL vaults are supported.");
  const d = await db();
  must(await d.from("pollen_vaults").upsert({ address, cluster, mint: v.mint, owner_wallet: v.owner, base: v.base, recorded_by: ownerId, recipients: v.recipients.map((r) => ({ address: r.address, bps: r.share })) }, { onConflict: "address", ignoreDuplicates: true }));
  return v;
}

/** Association is evidence-backed: caller owns the launch and the vault owner is the launch creator. Not proof of routing. */
export async function associate(ownerId: string, vault: string, launchId: string) {
  const { conn } = await ready();
  const d = await db();
  const launch = must(await d.from("launches").select("*").eq("id", launchId).maybeSingle());
  if (!launch || launch.owner_id !== ownerId) throw new Error("Launch not found in your workspace.");
  const v = await importVault(ownerId, vault);
  if (v.owner !== launch.creator_wallet) throw new Error("The vault owner must be this launch's creator wallet.");
  void conn;
  must(await d.from("pollen_associations").upsert({ vault, launch_id: launchId, owner_id: ownerId, wallet: launch.creator_wallet }, { onConflict: "vault,launch_id", ignoreDuplicates: true }));
  return { ok: true };
}

export async function forLaunch(launchId: string, signer: string | null) {
  const { conn } = await ready();
  const d = await db();
  const launch = must(await d.from("launches").select("id,pool,config").eq("id", launchId).maybeSingle());
  if (!launch) throw new Error("Launch not found.");
  const rows = must(await d.from("pollen_associations").select("vault").eq("launch_id", launchId));
  const out = [];
  for (const r of rows) {
    try { out.push({ address: r.vault, ...(await routingFor(conn, launch, r.vault, signer ?? "")) }); }
    catch (e) { out.push({ address: r.vault, error: (e as Error).message }); }
  }
  return out;
}

export async function listVaults() {
  const d = await db();
  return must(await d.from("pollen_vaults").select("*").order("created_at", { ascending: false }).limit(50));
}

export type SavePrep = (ownerId: string, kind: string, wallet: string, subject: string, built: any, payload: Record<string, unknown>) => Promise<{ id: string; expires_at: string }>;
export const DBC = DBC_PROGRAM_ID;
