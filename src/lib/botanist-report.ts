// Botanist field report builder. Point-in-time facts only; anything not read is labelled
// unavailable, never inferred. Readers are injected so the exact output is testable offline.
import { jsonSafe } from "@/pq/botanist";

export type ReportDeps = {
  getSlot: () => Promise<number>;
  now?: () => string;
  readAnyMint: (mint: string) => Promise<any>;
  readTokenMetadata: (mint: string) => Promise<any | null>;
  readUpgradeAuthority: (program: string) => Promise<any>;
  largestAccounts: (mint: string) => Promise<{ address: string; amount: string }[]>;
  findLaunch: (mint: string) => Promise<any | null>;
  readPool: (pool: string) => Promise<any | null>;
  readDbcConfig: (config: string) => Promise<any>;
  dbcProgram: string;
  cluster: string;
};
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const msg = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 200);

export async function buildReport(d: ReportDeps, mint: string) {
  const observedSlot = await d.getSlot(); const observedAt = (d.now ?? (() => new Date().toISOString()))();
  const facts: Record<string, any> = {}; const unavailable: Record<string, string> = {};
  const m = await d.readAnyMint(mint); // throws for non-mints: quotes already refused those
  facts.mint = { address: mint, program: m.program, decimals: m.decimals, supply: m.supply, mintAuthority: m.mintAuthority ?? null, freezeAuthority: m.freezeAuthority ?? null, mintAuthorityRevoked: !m.mintAuthority, freezeAuthorityRevoked: !m.freezeAuthority, token2022Extensions: m.extensions ?? [] };
  try {
    const md = await d.readTokenMetadata(mint);
    if (md) facts.metadata = { name: md.name ?? null, symbol: md.symbol ?? null, uri: md.uri ?? null, updateAuthority: md.updateAuthority ?? null, isMutable: md.isMutable ?? null };
    else { facts.metadata = null; unavailable.metadata = "No Metaplex metadata account for this mint."; }
  } catch (e) { facts.metadata = null; unavailable.metadata = msg(e); }
  try { const tp = await d.readUpgradeAuthority(m.program === "token-2022" ? TOKEN22 : TOKEN); if (tp.status === "ok") facts.tokenProgram = tp; else unavailable.tokenProgram = tp.reason; } catch (e) { unavailable.tokenProgram = msg(e); }
  try {
    const top = (await d.largestAccounts(mint)).slice(0, 10).map((a) => ({ account: a.address, amount: String(a.amount) }));
    const supply = BigInt(m.supply); const sum = top.reduce((s, a) => s + BigInt(a.amount), 0n);
    facts.holders = { topAccounts: top.map((a) => ({ ...a, shareBps: supply > 0n ? Number((BigInt(a.amount) * 10_000n) / supply) : null })), top10ShareBps: supply > 0n ? Number((sum * 10_000n) / supply) : null, note: "Token accounts, not people; pools and exchanges hold on behalf of many." };
  } catch (e) { unavailable.holders = `Largest accounts unavailable from RPC: ${msg(e)}`; }
  let launch: any = null;
  try { launch = await d.findLaunch(mint); } catch (e) { unavailable.protocol = `Fleuri launch lookup unavailable: ${msg(e)}`; }
  if (launch) {
    const manifest: any = launch.passports?.manifest ?? null;
    facts.fleuri = { passport: launch.passports?.manifest_hash ?? null, launchTx: launch.signature, recordedLifecycle: launch.lifecycle, originalCreator: launch.creator_wallet, pool: launch.pool, config: launch.config };
    try {
      const p = await d.readPool(launch.pool);
      if (!p) { facts.dbc = null; unavailable.dbcPool = "DBC pool account not found."; }
      else facts.dbc = { pool: launch.pool, currentCreator: p.creator, creatorChanged: p.creator !== launch.creator_wallet, migrated: p.isMigrated === 1, migrationProgress: p.migrationProgress ?? null, quoteReserveLamports: p.quoteReserve, migrationQuoteThresholdLamports: p.migrationQuoteThreshold ?? null, dammV2Pool: p.dammV2Confirmed ? p.dammV2Pool : null, dammV2Confirmed: !!p.dammV2Confirmed };
    } catch (e) { facts.dbc = null; unavailable.dbcPool = msg(e); }
    try {
      const c = await d.readDbcConfig(launch.config); const t = c.terms;
      const signedFeeClaimer = manifest?.fees?.feeClaimer ?? null;
      facts.dbcConfig = { address: launch.config, feeClaimer: t.fees.feeClaimer, signedFeeClaimer, matchesSigned: signedFeeClaimer === null ? null : t.fees.feeClaimer === signedFeeClaimer, baseFeeBps: t.fees.baseFeeBps, dynamicFeeEnabled: t.fees.dynamicFeeEnabled, creatorTradingFeePercent: t.fees.creatorTradingFeePercent, partnerTradingFeePercent: t.fees.partnerTradingFeePercent, migrationQuoteThresholdLamports: t.migration.quoteThresholdLamports, migrationTarget: t.migration.target, migratedPoolFeeBps: t.migration.migratedPoolFeeBps, signedQuoteThresholdLamports: manifest?.migration?.quoteThresholdLamports ?? null, lp: t.lp, eligibilityProblems: c.problems ?? [] };
    } catch (e) { unavailable.dbcConfig = msg(e); }
    try { const u = await d.readUpgradeAuthority(d.dbcProgram); if (u.status === "ok") facts.dbcProgram = u; else unavailable.dbcProgram = u.reason; } catch (e) { unavailable.dbcProgram = msg(e); }
  } else if (!unavailable.protocol) unavailable.protocol = "Not a fleuri launch: DBC config, signed promises and graduation are not applicable.";
  unavailable.lp = "LP position and lock state are not proven by this report; Meteora position accounts were not decoded.";
  const evidence = { explorer: `https://solscan.io/token/${mint}${d.cluster === "mainnet-beta" ? "" : `?cluster=${d.cluster}`}`, ...(launch ? { launchTx: `https://solscan.io/tx/${launch.signature}${d.cluster === "mainnet-beta" ? "" : `?cluster=${d.cluster}`}` } : {}) };
  return jsonSafe({ format: "fleuri.botanist.report/v1", cluster: d.cluster, observedSlot, observedAt, observedSlotNote: "Starting slot of this observation; individual reads may land in slightly later slots.", mint, facts, unavailable, evidence, disclaimer: "Point-in-time chain observations. Not an audit, not a safety rating and not financial advice." });
}
