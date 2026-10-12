// Server-only Graduation Watchtower reads. Read-only: no signing, no database writes. Accounts are
// decoded with the installed Meteora SDK IDL coders (which check discriminators); positions are
// discovered only from the pool's own migration transaction, in a bounded signature scan.
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  DynamicBondingCurveClient, createDammV2Program, deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveDammV2PoolAddress,
  derivePositionAddress, derivePositionNftAccount, DAMM_V2_MIGRATION_FEE_ADDRESS,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { deriveFeeVaultAuthorityAddress, deriveTokenVaultAddress } from "@meteora-ag/dynamic-fee-sharing-sdk";
import { accountKeys, type RawTx } from "@/pq/observatory";
import { b58decode } from "@/pq/memo-reader";
import {
  DAMM_V2_PROGRAM, DBC_PROGRAM, DFS_PROGRAM, MIGRATION_DAMM_V2_IX, TOKEN_PROGRAM, summarize,
  type ConfigFacts, type DammPoolFacts, type Discovery, type MintFacts, type PoolFacts, type PositionFacts, type VaultFacts, type WatchInput,
} from "@/pq/watchtower";
import * as sol from "./solana.server";
import { readVault } from "./pollen.server";
import { PublicError, RpcError, rpc } from "./observatory.server";

export const MAX_POSITIONS = 20; // bounded position discovery per pool
const POSITION_DISC = [170, 188, 143, 228, 122, 64, 247, 208]; // DAMM v2 Position (installed IDL; checked by tests)
// Fallback discovery budget: a conservative, explicit request/time budget (never an automatic deep scan).
export const SIG_PAGE = 100;
export const MAX_SIG_PAGES = 2;          // ≤ 200 signatures of the DAMM v2 pool
export const DISCOVERY_MAX_REQUESTS = 3; // 2 signature pages + 1 transaction read
export const DISCOVERY_MAX_MS = 6000;

const s = (v: any) => (v == null ? "" : typeof v === "string" ? v : v.toBase58 ? v.toBase58() : v.toString());
const n = (v: any) => Number(v?.toString?.() ?? v ?? 0);
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
const b58 = (d: Uint8Array) => new PublicKey(d).toBase58();

export const READ_TIMEOUT_MS = 8000;
/** Every SDK/connection read is bounded; a timeout becomes a safe public error and stops the lookup. */
export async function bounded<T>(p: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new PublicError("The chain read timed out. Try again later.")), ms); })]); }
  finally { if (t) clearTimeout(t); }
}

async function ready() {
  const e = sol.solEnv();
  if (!e.cluster || !e.rpcUrl) throw new PublicError("The Solana network is not configured.");
  const conn = sol.connection();
  let genesisHash: string;
  try { genesisHash = await bounded(sol.assertGenesis(conn, e.cluster)); } catch { throw new PublicError("The configured network could not be verified right now."); }
  return { conn, cluster: e.cluster, genesisHash, rpcUrl: e.rpcUrl };
}

async function multi(conn: Connection, keys: string[]) {
  try {
    const r = await bounded(conn.getMultipleAccountsInfoAndContext(keys.map((k) => new PublicKey(k)), "confirmed"));
    return { slot: r.context.slot, infos: r.value as (AccountInfo<Buffer> | null)[] };
  } catch (e) { throw e instanceof PublicError ? e : new PublicError("The chain read failed. Try again later."); }
}

/** SPL mint base layout (82 bytes; Token-2022 shares it): COption authority, supply, decimals, isInitialized, COption freeze. */
export const mintFacts = (address: string, i: AccountInfo<Buffer> | null): MintFacts => {
  if (!i) return { address, owner: null, decimals: null, supply: null, initialized: null, mintAuthority: null, freezeAuthority: null };
  const d = i.data; const ok = d.length >= 82;
  if (!ok) return { address, owner: i.owner.toBase58(), decimals: null, supply: null, initialized: null, mintAuthority: null, freezeAuthority: null };
  const opt = (o: number) => (d.readUInt32LE(o) === 1 ? b58(d.subarray(o + 4, o + 36)) : null);
  return { address, owner: i.owner.toBase58(), decimals: d[44], supply: u64(d, 36).toString(), initialized: d[45] === 1, mintAuthority: opt(0), freezeAuthority: opt(46) };
};
/** SPL token-account base layout (165 bytes): mint, owner, amount, …, state at byte 108. */
export const tokenAccount = (i: AccountInfo<Buffer> | null) =>
  i && i.data.length >= 165 ? { program: i.owner.toBase58(), mint: b58(i.data.subarray(0, 32)), holder: b58(i.data.subarray(32, 64)), amount: u64(i.data, 64).toString(), state: i.data[108] as number } : null;

function decodeConfig(address: string, owner: string, c: any): ConfigFacts {
  const lv = (x: any) => ({ isInitialized: n(x?.isInitialized), vestingPercentage: n(x?.vestingPercentage), bpsPerPeriod: n(x?.bpsPerPeriod), numberOfPeriods: n(x?.numberOfPeriods), frequency: n(x?.frequency), cliffDurationFromMigrationTime: n(x?.cliffDurationFromMigrationTime) });
  return {
    address, owner, quoteMint: s(c.quoteMint), feeClaimer: s(c.feeClaimer), leftoverReceiver: s(c.leftoverReceiver),
    collectFeeMode: n(c.collectFeeMode), migrationOption: n(c.migrationOption), migrationFeeOption: n(c.migrationFeeOption), tokenType: n(c.tokenType), quoteTokenFlag: n(c.quoteTokenFlag), tokenDecimal: n(c.tokenDecimal),
    partnerLiquidityPercentage: n(c.partnerLiquidityPercentage), partnerPermanentLockedLiquidityPercentage: n(c.partnerPermanentLockedLiquidityPercentage),
    creatorLiquidityPercentage: n(c.creatorLiquidityPercentage), creatorPermanentLockedLiquidityPercentage: n(c.creatorPermanentLockedLiquidityPercentage),
    partnerVesting: lv(c.partnerLiquidityVestingInfo), creatorVesting: lv(c.creatorLiquidityVestingInfo),
    migrationQuoteThreshold: s(c.migrationQuoteThreshold), migratedPoolFeeBps: n(c.migratedPoolFeeBps), migratedCollectFeeMode: n(c.migratedCollectFeeMode), migratedDynamicFee: n(c.migratedDynamicFee), migratedCompoundingFeeBps: n(c.migratedCompoundingFeeBps),
    lockedVesting: { amountPerPeriod: s(c.lockedVestingConfig?.amountPerPeriod), numberOfPeriod: s(c.lockedVestingConfig?.numberOfPeriod), cliffUnlockAmount: s(c.lockedVestingConfig?.cliffUnlockAmount) },
    creatorTradingFeePercentage: n(c.creatorTradingFeePercentage),
  };
}

function decodeDamm(address: string, owner: string, p: any): DammPoolFacts {
  const raw = p.poolFees?.baseFee?.baseFeeInfo?.data as number[] | undefined;
  return {
    address, owner, tokenAMint: s(p.tokenAMint), tokenBMint: s(p.tokenBMint), liquidity: s(p.liquidity), permanentLockLiquidity: s(p.permanentLockLiquidity),
    collectFeeMode: n(p.collectFeeMode), poolStatus: n(p.poolStatus), activationType: n(p.activationType), creator: s(p.creator),
    dynamicFeeInitialized: n(p.poolFees?.dynamicFee?.initialized), protocolFeePercent: n(p.poolFees?.protocolFeePercent), referralFeePercent: n(p.poolFees?.referralFeePercent),
    compoundingFeeBps: n(p.poolFees?.compoundingFeeBps), baseFeeBytesHex: raw ? Array.from(raw, (x) => x.toString(16).padStart(2, "0")).join("") : "", totalPositions: s(p.metrics?.totalPosition),
  };
}

/** Lists current DAMM v2 positions of one pool: Position discriminator + pool at offset 8. */
export async function listPoolPositions(rpcUrl: string, damm: string, totalPositions: string): Promise<Discovery & { nftMints: string[] }> {
  const base = { method: "program_accounts" as const, signature: null, pagesRead: 1 };
  // metrics.totalPosition is a cumulative counter (includes closed positions); it is reported, never used as a current count.
  try {
    const { b58encode } = await import("@/pq/observatory");
    const res = await rpc<{ pubkey: string; account: { data: [string, string]; owner: string } }[]>(rpcUrl, "getProgramAccounts", [DAMM_V2_PROGRAM, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 40, length: 32 }, filters: [{ memcmp: { offset: 0, bytes: b58encode(Uint8Array.from(POSITION_DISC)) } }, { memcmp: { offset: 8, bytes: damm } }] }]);
    if (!Array.isArray(res)) throw new RpcError("unavailable");
    if (res.length > MAX_POSITIONS) return { ...base, status: "truncated", detail: `More than ${MAX_POSITIONS} positions; ownership is unknown.`, positions: [], nftMints: [] };
    const rows = res.map((r) => ({ pos: r.pubkey, nft: b58(Uint8Array.from(atob(r.account.data[0]), (c) => c.charCodeAt(0))) })).sort((a, b) => a.pos.localeCompare(b.pos));
    return { ...base, status: rows.length ? "found" : "not_found", detail: rows.length ? `${rows.length} open position account(s) listed by the RPC at read time. The pool's cumulative counter (${totalPositions}) also counts closed positions, so it is not an open-position count.` : "The RPC listed no positions for this pool.", positions: rows.map((r) => r.pos), nftMints: rows.map((r) => r.nft) };
  } catch (e) {
    const rl = e instanceof RpcError && e.kind === "rate_limited";
    return { ...base, status: "unavailable", detail: rl ? "The RPC rate-limited the position listing; ownership is unknown." : "The RPC could not list positions; ownership is unknown.", positions: [], nftMints: [] };
  }
}

/** Bounded walk back to the DAMM v2 pool's first transaction and decode DBC migration_damm_v2 from it. */
export async function discoverPositions(rpcUrl: string, pool: string, damm: string, now: () => number = Date.now): Promise<Discovery & { nftMints: string[] }> {
  let before: string | undefined; let oldest: string | null = null; let pages = 0; let requests = 0;
  const t0 = now();
  const budget = () => ({ maxRequests: DISCOVERY_MAX_REQUESTS, maxMs: DISCOVERY_MAX_MS, requests });
  const out = (status: Discovery["status"], signature: string | null, detail: string, extra: { positions: string[]; nftMints: string[] } = { positions: [], nftMints: [] }) =>
    ({ method: "migration_tx" as const, status, signature, pagesRead: pages, detail, budget: budget(), ...extra });
  const over = () => requests >= DISCOVERY_MAX_REQUESTS || now() - t0 > DISCOVERY_MAX_MS;
  const call = async <T,>(m: string, p: unknown[]) => {
    const left = DISCOVERY_MAX_MS - (now() - t0);
    requests++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([rpc<T>(rpcUrl, m, p), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new RpcError("unavailable")), Math.max(0, left)); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const lim = `Scan budget: ${MAX_SIG_PAGES * SIG_PAGE} signatures, ${DISCOVERY_MAX_REQUESTS} requests, ${DISCOVERY_MAX_MS / 1000}s.`;
  try {
    for (; pages < MAX_SIG_PAGES; ) {
      if (over()) return out("truncated", null, `Budget reached before the migration transaction. ${lim} Position ownership is unknown.`);
      const list = await call<{ signature: string }[]>("getSignaturesForAddress", [damm, { limit: SIG_PAGE, before, commitment: "confirmed" }]);
      pages++;
      if (!Array.isArray(list)) throw new RpcError("unavailable");
      if (list.length) { before = list[list.length - 1].signature; oldest = before; }
      if (list.length < SIG_PAGE) break;
      if (pages === MAX_SIG_PAGES) return out("truncated", null, `More than ${MAX_SIG_PAGES * SIG_PAGE} signatures; the migration transaction was not reached. ${lim} Position ownership is unknown.`);
    }
    if (!oldest) return out("not_found", null, "The pool has no signatures.");
    if (over()) return out("truncated", oldest, `Budget reached before reading the oldest transaction. ${lim} Position ownership is unknown.`);
    const tx = await call<RawTx | null>("getTransaction", [oldest, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    if (!tx || !tx.meta || tx.meta.err !== null) return out("not_found", oldest, "The oldest transaction is unavailable or failed, so position ownership is unknown.");
    const keys = accountKeys(tx);
    const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
    for (const ix of all) {
      if (keys[ix.programIdIndex] !== DBC_PROGRAM) continue;
      const d = b58decode(ix.data);
      if (!MIGRATION_DAMM_V2_IX.every((b, i) => d[i] === b)) continue;
      const a = ix.accounts.map((k) => keys[k]);
      if (a[0] !== pool || a[4] !== damm) continue;
      return out("found", oldest, `Positions taken from the pool's own migration_damm_v2 instruction (partial: positions split or added later are not scanned). ${lim}`, { positions: [a[7], a[10]], nftMints: [a[5], a[8]] });
    }
    return out("not_found", oldest, "The oldest transaction read is not this launch's DBC migration, so position ownership is unknown.");
  } catch (e) {
    const rl = e instanceof RpcError && e.kind === "rate_limited";
    return out("unavailable", null, rl ? "The RPC rate-limited the scan; position ownership is unknown." : "The RPC was unavailable or the scan timed out; position ownership is unknown.");
  }
}

/** A DFS vault, with layout/type/mint/token-vault checks. Null when the account is not a decodable DFS vault. */
export async function tryVault(conn: Connection, address: string): Promise<VaultFacts | null> {
  let v: Awaited<ReturnType<typeof readVault>>;
  try { v = await bounded(readVault(conn, address)); } catch (e) { if (e instanceof PublicError) throw e; return null; }
  if (!v) return null;
  const issues: string[] = [];
  if (!v.supported) issues.push("The vault's token is not a supported SPL Token mint (USDC or wrapped SOL).");
  if (v.feeVaultType !== 0 && v.feeVaultType !== 1) issues.push(`Unknown fee vault type ${v.feeVaultType}.`);
  if (v.tokenVault !== deriveTokenVaultAddress(new PublicKey(address)).toBase58()) issues.push("The vault's token account is not the program-derived token vault.");
  try {
    const [ti, mi] = await bounded(Promise.all([conn.getAccountInfo(new PublicKey(v.tokenVault), "confirmed"), conn.getAccountInfo(new PublicKey(v.mint), "confirmed")]));
    const t = tokenAccount(ti as AccountInfo<Buffer> | null);
    const mf = mintFacts(v.mint, (mi as AccountInfo<Buffer> | null) ?? null);
    if (!t) issues.push("The vault's token account could not be read.");
    else {
      if (t.program !== TOKEN_PROGRAM) issues.push("The vault's token account is not an SPL Token account.");
      if (t.mint !== v.mint) issues.push("The vault's token account holds a different mint.");
      if (t.holder !== deriveFeeVaultAuthorityAddress().toBase58()) issues.push("The vault's token account is not controlled by the fee-sharing program's vault authority.");
      if (t.state !== 1) issues.push("The vault's token account is not in an initialized, unfrozen state.");
    }
    if (mf.owner !== TOKEN_PROGRAM || mf.initialized !== true) issues.push("The vault's mint is not an initialized SPL Token mint.");
  } catch (e) { if (e instanceof PublicError && /timed out/.test(e.message)) throw e; issues.push("The vault's token account could not be read."); }
  return { address: v.address, mint: v.mint, tokenVault: v.tokenVault, recipients: v.recipients.map((r) => r.address), pdaIssues: v.pdaIssues, issues, feeVaultType: v.feeVaultType, slot: v.accountSlot ?? null };
}

export async function watch(poolAddress: string, extraVault?: string) {
  const { conn, cluster, genesisHash, rpcUrl } = await ready();
  const dbcClient = new DynamicBondingCurveClient(conn, "confirmed");
  const dbcCoder = (dbcClient.state as any).program.coder.accounts;
  const dammCoder = (createDammV2Program(conn) as any).coder.accounts;

  // 1. the pool
  const r1 = await multi(conn, [poolAddress]);
  const pi = r1.infos[0];
  if (!pi) throw new PublicError("No account at this address.");
  if (pi.owner.toBase58() !== DBC_PROGRAM) throw new PublicError("This account is not owned by Meteora Dynamic Bonding Curve.");
  let raw: any;
  try { raw = dbcCoder.decode("virtualPool", pi.data); } catch { throw new PublicError("This DBC account is not a virtual pool."); }
  const ps = raw.poolState ?? raw;
  const pool: PoolFacts = {
    address: poolAddress, config: s(ps.config), creator: s(ps.creator), baseMint: s(ps.baseMint), baseVault: s(ps.baseVault), quoteVault: s(ps.quoteVault),
    quoteReserve: s(ps.quoteReserve), baseReserve: s(ps.baseReserve), isMigrated: n(ps.isMigrated), migrationProgress: n(ps.migrationProgress), finishCurveTimestamp: s(ps.finishCurveTimestamp),
    partnerQuoteFee: s(ps.partnerQuoteFee), creatorQuoteFee: s(ps.creatorQuoteFee), partnerBaseFee: s(ps.partnerBaseFee), creatorBaseFee: s(ps.creatorBaseFee),
    derivedAddress: null, derivedBaseVault: null, derivedQuoteVault: null,
  };

  // 2. config + base mint
  const r2 = await multi(conn, [pool.config, pool.baseMint]);
  let config: ConfigFacts | null = null;
  const ci = r2.infos[0];
  if (ci && ci.owner.toBase58() === DBC_PROGRAM) { try { config = decodeConfig(pool.config, DBC_PROGRAM, dbcCoder.decode("poolConfig", ci.data)); } catch { config = null; } }
  const baseMint = mintFacts(pool.baseMint, r2.infos[1]);

  const damm: WatchInput["damm"] = { derived: null, derivationNote: "", account: "not_read", facts: null };
  let quoteMint: MintFacts | null = null; let dammSlot: number | null = null;
  const candidates = new Set<string>();
  if (config) {
    try {
      pool.derivedAddress = deriveDbcPoolAddress(new PublicKey(config.quoteMint), new PublicKey(pool.baseMint), new PublicKey(pool.config)).toBase58();
      pool.derivedBaseVault = deriveDbcTokenVaultAddress(new PublicKey(poolAddress), new PublicKey(pool.baseMint)).toBase58();
      pool.derivedQuoteVault = deriveDbcTokenVaultAddress(new PublicKey(poolAddress), new PublicKey(config.quoteMint)).toBase58();
    } catch { /* stays unknown */ }
    const dammConfig = config.migrationOption === 1 ? (DAMM_V2_MIGRATION_FEE_ADDRESS as PublicKey[])[config.migrationFeeOption] : undefined;
    if (config.migrationOption !== 1) damm.derivationNote = "Not a DAMM v2 migration target.";
    else if (config.migrationFeeOption > 6 || !dammConfig) damm.derivationNote = `Migration fee option ${config.migrationFeeOption} has no DAMM v2 config in the installed SDK, so the pool address can't be derived (unsupported).`;
    else {
      damm.derived = deriveDammV2PoolAddress(dammConfig, new PublicKey(pool.baseMint), new PublicKey(config.quoteMint)).toBase58();
      damm.derivationNote = config.migrationFeeOption === 6 ? "Customizable option 6: derived with the installed SDK's customizable DAMM v2 config key (DAMM_V2_MIGRATION_FEE_ADDRESS[6]) and the base/quote mints, as the SDK's migrateToDammV2 does. If no pool exists there, this launch can't be tracked by that derivation." : `Derived from fixed DAMM v2 fee preset ${config.migrationFeeOption}.`;
    }
    // 3. quote mint + derived DAMM v2 pool + DFS-candidate fee claimer / creator
    for (const a of [config.feeClaimer, pool.creator, extraVault]) if (a) candidates.add(a);
    const keys = [config.quoteMint, ...(damm.derived ? [damm.derived] : []), ...candidates];
    const r3 = await multi(conn, keys);
    dammSlot = r3.slot;
    quoteMint = mintFacts(config.quoteMint, r3.infos[0]);
    if (damm.derived) {
      const di = r3.infos[1];
      if (!di) damm.account = "missing";
      else if (di.owner.toBase58() !== DAMM_V2_PROGRAM) damm.account = "wrong_owner";
      else { try { damm.facts = decodeDamm(damm.derived, DAMM_V2_PROGRAM, dammCoder.decode("pool", di.data)); damm.account = "ok"; } catch { damm.account = "undecodable"; } }
    }
    const offs = damm.derived ? 2 : 1;
    [...candidates].forEach((a, i) => { if (r3.infos[offs + i]?.owner.toBase58() !== DFS_PROGRAM) candidates.delete(a); });
  }
  const vaults = (await Promise.all([...candidates].map((a) => tryVault(conn, a)))).filter((v): v is VaultFacts => !!v);

  // 4. migration positions (bounded discovery) + their NFT accounts and mints
  let discovery: Discovery | null = null; const positions: PositionFacts[] = []; const positionErrors: { address: string; reason: string }[] = [];
  let posSlot: number | null = null; let nowUnix: number | null = null;
  const dammOk = damm.account === "ok" && !!damm.facts && !!config && damm.facts.tokenAMint === pool.baseMint && damm.facts.tokenBMint === config.quoteMint;
  if (dammOk) {
    let d = await listPoolPositions(rpcUrl, damm.derived!, damm.facts!.totalPositions);
    if (d.status === "unavailable") d = await discoverPositions(rpcUrl, poolAddress, damm.derived!);
    const { nftMints, ...rest } = d; discovery = rest;
    if (d.status === "found") {
      const nftAccts = nftMints.map((m) => derivePositionNftAccount(new PublicKey(m)).toBase58());
      const r4 = await multi(conn, [...d.positions, ...nftMints, ...nftAccts]);
      posSlot = r4.slot;
      try { nowUnix = await bounded(conn.getBlockTime(r4.slot), 4000); } catch { nowUnix = null; }
      d.positions.forEach((addr, k) => {
        const info = r4.infos[k];
        if (!info) { positionErrors.push({ address: addr, reason: "No position account exists here (never created, or closed)." }); return; }
        let p: any;
        try { p = dammCoder.decode("position", info.data); } catch { positionErrors.push({ address: addr, reason: "The account does not decode as a DAMM v2 position." }); return; }
        const nftMint = s(p.nftMint);
        const N = d.positions.length; const mi = r4.infos[N + k], ai = r4.infos[2 * N + k];
        const nftAcct = tokenAccount(ai ?? null);
        const mf = mintFacts(nftMints[k], mi ?? null);
        const iv = p.innerVesting ?? {};
        positions.push({
          address: addr, owner: info.owner.toBase58(), pool: s(p.pool), nftMint, derivedAddress: derivePositionAddress(new PublicKey(nftMint)).toBase58(),
          unlockedLiquidity: s(p.unlockedLiquidity), vestedLiquidity: s(p.vestedLiquidity), permanentLockedLiquidity: s(p.permanentLockedLiquidity), feeAPending: s(p.feeAPending), feeBPending: s(p.feeBPending),
          innerVesting: { cliffPoint: s(iv.cliffPoint) || "0", periodFrequency: s(iv.periodFrequency) || "0", cliffUnlockLiquidity: s(iv.cliffUnlockLiquidity) || "0", liquidityPerPeriod: s(iv.liquidityPerPeriod) || "0", totalReleasedLiquidity: s(iv.totalReleasedLiquidity) || "0", numberOfPeriod: n(iv.numberOfPeriod) },
          nft: nftMint === nftMints[k]
            ? { account: nftAccts[k], derivedAccount: derivePositionNftAccount(new PublicKey(nftMint)).toBase58(), tokenProgram: ai?.owner.toBase58() ?? null, mint: nftAcct?.mint ?? null, holder: nftAcct?.holder ?? null, amount: nftAcct?.amount ?? null, mintOwner: mf.owner, mintSupply: mf.supply, mintDecimals: mf.decimals, state: nftAcct?.state ?? null, mintInitialized: mf.initialized ?? null }
            : null,
          slot: r4.slot,
        });
        if (nftMint !== nftMints[k]) positionErrors.push({ address: addr, reason: "The position's NFT mint differs from the migration's NFT mint." });
      });
      // Discover any holder vaults not already checked.
      for (const p of positions) { const h = p.nft?.holder; if (h && !vaults.some((v) => v.address === h)) { const v = await tryVault(conn, h); if (v) vaults.push(v); } }
    }
  }

  const input: WatchInput = {
    cluster, genesisHash, fetchedAt: new Date().toISOString(),
    slots: { pool: r1.slot, config: r2.slot, damm: dammSlot, positions: posSlot }, nowUnix,
    pool, config, baseMint, quoteMint, damm, discovery, positions, positionErrors, vaults,
  };
  return { input, summary: summarize(input) };
}

/** Public launch metadata only; the page still works when the database is unavailable. */
export async function knownLaunches() {
  const cluster = sol.solEnv().cluster ?? null;
  let launches: { pool: string; base_mint: string; cluster: string }[] = [];
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).from("launches").select("pool,base_mint,cluster").order("created_at", { ascending: false }).limit(25);
    if (!error) launches = data ?? [];
  } catch { /* optional */ }
  return { cluster, launches };
}
