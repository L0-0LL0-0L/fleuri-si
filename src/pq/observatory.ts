// Pollen Observatory: pure, browser-safe decoding of Meteora Dynamic Fee Sharing (DFS) activity.
// Works on raw `getTransaction(..., {encoding:"json", maxSupportedTransactionVersion:0})` results.
// Attribution is proved only from successful instructions plus DFS emit_cpi events: an event counts
// only when DFS itself emitted it (event-authority account) directly under the invocation it belongs
// to, and the event's vault/source/payload match that invocation. Anything less stays "unknown".
import { b58decode } from "./memo-reader";
import { DFS_PROGRAM_ID } from "./pollen";

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const DFS_EVENT_AUTHORITY = "EjRrm5Ptzzbp4fft5k4oC9LvbXqVA4UV4Sc9RNULDhCA";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGqPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Anchor discriminators, as in the installed @meteora-ag SDK IDLs (checked by tests).
export const IX = {
  fundFee: [243, 236, 235, 235, 101, 24, 186, 178],
  fundByClaimingFee: [48, 226, 100, 60, 217, 101, 248, 182],
  claimFee: [169, 32, 79, 137, 136, 232, 70, 137],
} as const;
const EVENT_IX_TAG = [228, 69, 165, 46, 81, 203, 154, 29];
const EVT_FUND = [15, 14, 233, 140, 19, 195, 163, 7];
const EVT_CLAIM = [6, 36, 88, 232, 53, 193, 253, 98];

export type SourceLabel =
  | "dbc_creator_trading_fee" | "dbc_partner_trading_fee" | "damm_v2_position_fee" // trading fees
  | "dbc_creator_surplus" | "dbc_partner_surplus" | "dbc_migration_fee" | "damm_v2_reward" // not trading fees
  | "manual" | "unknown";

const SOURCES: { program: string; disc: number[]; label: SourceLabel }[] = [
  { program: DBC_PROGRAM, disc: [82, 220, 250, 189, 3, 85, 107, 45], label: "dbc_creator_trading_fee" }, // claim_creator_trading_fee
  { program: DBC_PROGRAM, disc: [238, 247, 213, 94, 110, 145, 88, 142], label: "dbc_creator_trading_fee" }, // claim_creator_trading_fee2
  { program: DBC_PROGRAM, disc: [8, 236, 89, 49, 152, 125, 177, 81], label: "dbc_partner_trading_fee" }, // claim_trading_fee
  { program: DBC_PROGRAM, disc: [84, 191, 71, 50, 9, 162, 55, 193], label: "dbc_partner_trading_fee" }, // claim_trading_fee2
  { program: DBC_PROGRAM, disc: [165, 3, 137, 7, 28, 134, 76, 80], label: "dbc_creator_surplus" },
  { program: DBC_PROGRAM, disc: [168, 173, 72, 100, 201, 98, 38, 92], label: "dbc_partner_surplus" },
  { program: DBC_PROGRAM, disc: [237, 142, 45, 23, 129, 6, 222, 162], label: "dbc_migration_fee" },
  { program: DAMM_V2_PROGRAM, disc: [180, 38, 154, 17, 133, 33, 162, 211], label: "damm_v2_position_fee" },
  { program: DAMM_V2_PROGRAM, disc: [149, 95, 181, 242, 94, 90, 158, 162], label: "damm_v2_reward" },
];
export const TRADING_FEE_SOURCES: SourceLabel[] = ["dbc_creator_trading_fee", "dbc_partner_trading_fee", "damm_v2_position_fee"];
export const SOURCE_TEXT: Record<SourceLabel, string> = {
  dbc_creator_trading_fee: "DBC creator trading fee", dbc_partner_trading_fee: "DBC partner trading fee", damm_v2_position_fee: "DAMM v2 position trading fee",
  dbc_creator_surplus: "DBC creator surplus (not a trading fee)", dbc_partner_surplus: "DBC partner surplus (not a trading fee)",
  dbc_migration_fee: "DBC migration fee (not a trading fee)", damm_v2_reward: "DAMM v2 farming reward (not a trading fee)",
  manual: "Manual deposit through the program", unknown: "Unknown source",
};

export function classifySource(program: string, payload: Uint8Array): SourceLabel {
  const s = SOURCES.find((x) => x.program === program && payload.length >= 8 && x.disc.every((b, i) => payload[i] === b));
  return s?.label ?? "unknown";
}

// ---- raw RPC shapes (json encoding) ----
export interface RawIx { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number | null }
export interface RawTx {
  slot?: number | null; blockTime?: number | null; version?: "legacy" | 0 | number;
  transaction: { message: { accountKeys: string[]; instructions: RawIx[] }; signatures?: string[] };
  meta: null | { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } | null; innerInstructions?: { index: number; instructions: RawIx[] }[] | null };
}

export type Entry =
  | { kind: "fund"; amount: string; source: SourceLabel; sourceProgram: string | null; evidence: "proved" | "ambiguous"; feePerShare: string }
  | { kind: "claim"; amount: string; recipient: string; index: number; recipientMatch: boolean; evidence: "proved" | "ambiguous" }
  | { kind: "direct_transfer"; amount: string; tokenProgram: string };

export type TxStatus = "success" | "failed" | "unavailable" | "unsupported" | "undecodable";
export interface ObservedTx {
  signature: string; slot: number | null; blockTime: number | null; status: TxStatus; reason?: string;
  via: ("vault" | "tokenVault")[]; entries: Entry[]; otherVaultEvents: number;
}

const eq = (d: Uint8Array, o: number, t: readonly number[]) => d.length >= o + t.length && t.every((x, i) => d[o + i] === x);
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => (u64(d, o + 8) << 64n) | u64(d, o);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(b: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of b) { let c = byte; for (let i = 0; i < digits.length; i++) { c += digits[i] << 8; digits[i] = c % 58; c = (c / 58) | 0; } while (c) { digits.push(c % 58); c = (c / 58) | 0; } }
  let s = ""; for (const byte of b) { if (byte) break; s += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Full account list: static keys, then loaded writable, then loaded readonly (v0 ordering). */
export function accountKeys(tx: RawTx): string[] {
  const la = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])];
}

interface Ix { program: string; accounts: string[]; data: Uint8Array; stack: number | null; outer: number }
function flatten(tx: RawTx, keys: string[]): Ix[][] {
  const at = (i: number) => { const k = keys[i]; if (k === undefined) throw new Error("account index out of range"); return k; };
  const conv = (r: RawIx, outer: number, stack: number | null): Ix => ({ program: at(r.programIdIndex), accounts: r.accounts.map(at), data: b58decode(r.data), stack, outer });
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  return tx.transaction.message.instructions.map((r, i) => [conv(r, i, 1), ...(inner.get(i) ?? []).map((x) => conv(x, i, x.stackHeight ?? null))]);
}

function fundEvent(d: Uint8Array) {
  if (!eq(d, 0, EVENT_IX_TAG) || !eq(d, 8, EVT_FUND) || d.length < 16 + 32 + 32 + 8 + 16 + 4) return null;
  const len = new DataView(d.buffer, d.byteOffset, d.length).getUint32(104, true);
  if (d.length < 108 + len) return null;
  return { sourceProgram: b58encode(d.subarray(16, 48)), vault: b58encode(d.subarray(48, 80)), amount: u64(d, 80), feePerShare: u128(d, 88), payload: d.subarray(108, 108 + len) };
}
function claimEvent(d: Uint8Array) {
  if (!eq(d, 0, EVENT_IX_TAG) || !eq(d, 8, EVT_CLAIM) || d.length < 16 + 73) return null;
  return { vault: b58encode(d.subarray(16, 48)), user: b58encode(d.subarray(48, 80)), index: d[80], amount: u64(d, 81) };
}
const isDfsEvent = (x: Ix) => x.program === DFS_PROGRAM_ID && eq(x.data, 0, EVENT_IX_TAG) && x.accounts[0] === DFS_EVENT_AUTHORITY;

/**
 * Decodes one transaction for one vault. `recipients` are the vault's fixed recipient addresses by index.
 * Failed transactions yield no entries (they move nothing).
 */
export function decodeTx(signature: string, tx: RawTx | null, ctx: { vault: string; tokenVault: string; recipients: string[] }, via: ObservedTx["via"] = []): ObservedTx {
  const base = { signature, slot: tx?.slot ?? null, blockTime: tx?.blockTime ?? null, via, entries: [] as Entry[], otherVaultEvents: 0 };
  if (!tx) return { ...base, status: "unavailable", reason: "The RPC returned no transaction for this signature." };
  if (tx.version !== undefined && tx.version !== "legacy" && tx.version !== 0) return { ...base, status: "unsupported", reason: `Transaction version ${String(tx.version)} is not supported.` };
  if (!tx.meta) return { ...base, status: "unavailable", reason: "The RPC returned no status metadata, so success cannot be shown." };
  if (tx.meta.err != null) return { ...base, status: "failed", reason: "Failed on chain; nothing moved." };
  let groups: Ix[][];
  try { groups = flatten(tx, accountKeys(tx)); } catch (e) { return { ...base, status: "undecodable", reason: (e as Error).message }; }
  const entries: Entry[] = []; let other = 0;
  for (const g of groups) {
    const consumed = new Set<number>();
    let dfsTouched = false;
    // Invocations of DFS fund/claim, each matched to the events DFS emitted directly beneath it.
    g.forEach((x, i) => {
      if (x.program !== DFS_PROGRAM_ID) return;
      const isFund = eq(x.data, 0, IX.fundFee), isClaimFund = eq(x.data, 0, IX.fundByClaimingFee), isClaim = eq(x.data, 0, IX.claimFee);
      if (!isFund && !isClaimFund && !isClaim) return;
      dfsTouched = true;
      if (x.accounts[0] !== ctx.vault) return;
      // Children = following instructions until the stack returns to this level.
      const kids: number[] = []; let ambiguous = x.stack == null;
      for (let j = i + 1; j < g.length; j++) {
        const y = g[j];
        if (x.stack != null && y.stack != null && y.stack <= x.stack) break;
        if (y.stack == null) { ambiguous = true; }
        if (x.stack == null || y.stack === x.stack + 1) kids.push(j);
      }
      const evIdx = kids.filter((j) => isDfsEvent(g[j]) && !consumed.has(j));
      if (isClaim) {
        const ev = evIdx.map((j) => ({ j, e: claimEvent(g[j].data) })).filter((z) => z.e && z.e.vault === ctx.vault);
        if (ev.length !== 1) return;
        consumed.add(ev[0].j); const e = ev[0].e!;
        const user = x.accounts[5];
        entries.push({ kind: "claim", amount: e.amount.toString(), recipient: e.user, index: e.index, recipientMatch: e.user === user && ctx.recipients[e.index] === e.user, evidence: ambiguous ? "ambiguous" : "proved" });
        return;
      }
      const ev = evIdx.map((j) => ({ j, e: fundEvent(g[j].data) })).filter((z) => z.e && z.e.vault === ctx.vault);
      if (ev.length !== 1) return;
      consumed.add(ev[0].j); const e = ev[0].e!;
      let source: SourceLabel = "unknown";
      if (!ambiguous && isFund) source = "manual";
      if (!ambiguous && isClaimFund) {
        // Payload arg = u32 length + bytes; sourceProgram is account 3. The CPI into it must carry the exact payload.
        const dv = new DataView(x.data.buffer, x.data.byteOffset, x.data.length);
        const len = x.data.length >= 12 ? dv.getUint32(8, true) : -1;
        const payload = len >= 0 && x.data.length >= 12 + len ? x.data.subarray(12, 12 + len) : null;
        const sp = x.accounts[3];
        const cpi = kids.some((j) => g[j].program === sp && payload && sameBytes(g[j].data, payload));
        if (payload && cpi && e.sourceProgram === sp && sameBytes(e.payload, payload)) source = classifySource(sp, payload);
      }
      entries.push({ kind: "fund", amount: e.amount.toString(), source, sourceProgram: isClaimFund ? x.accounts[3] ?? null : null, evidence: ambiguous ? "ambiguous" : "proved", feePerShare: e.feePerShare.toString() });
    });
    // DFS events for other vaults are counted, never attributed.
    g.forEach((x, j) => { if (!consumed.has(j) && isDfsEvent(x)) { const f = fundEvent(x.data) ?? claimEvent(x.data); if (f && f.vault !== ctx.vault) other++; } });
    // Plain SPL transfers into the token vault outside any DFS invocation: shown, never counted as funding.
    if (!dfsTouched) for (const x of g) {
      if (x.program !== TOKEN_PROGRAM && x.program !== TOKEN_2022_PROGRAM) continue;
      const dest = x.data[0] === 3 && x.data.length >= 9 ? x.accounts[1] : x.data[0] === 12 && x.data.length >= 10 ? x.accounts[2] : null;
      if (dest === ctx.tokenVault) entries.push({ kind: "direct_transfer", amount: u64(x.data, 1).toString(), tokenProgram: x.program });
    }
  }
  return { ...base, status: "success", entries, otherVaultEvents: other };
}

// ---- bounded two-stream history ----
export type Stream = "vault" | "tokenVault";
export interface StreamCoverage { address: string; oldestSignature: string | null; oldestSlot: number | null; pages: number; exhausted: boolean; error: string | null }
export interface History { txs: ObservedTx[]; coverage: Record<Stream, StreamCoverage> }

/** Merges a page into history: dedupes by signature (keeping the most informative record) and sorts newest first. */
export function mergeHistory(h: History, page: { txs: ObservedTx[]; coverage: Partial<Record<Stream, StreamCoverage>> }): History {
  const rank: Record<TxStatus, number> = { success: 4, failed: 3, undecodable: 2, unsupported: 1, unavailable: 0 };
  const by = new Map(h.txs.map((t) => [t.signature, t]));
  for (const t of page.txs) {
    const old = by.get(t.signature);
    if (!old) { by.set(t.signature, t); continue; }
    const best = rank[t.status] > rank[old.status] ? t : old;
    by.set(t.signature, { ...best, via: [...new Set([...old.via, ...t.via])].sort() as ObservedTx["via"] });
  }
  const txs = [...by.values()].sort((a, b) => (b.slot ?? -1) - (a.slot ?? -1) || a.signature.localeCompare(b.signature));
  return { txs, coverage: { ...h.coverage, ...page.coverage } as Record<Stream, StreamCoverage> };
}

/** Sums successful, proved entries inside the observed window only. Never a lifetime figure. */
export function windowTotals(txs: ObservedTx[]) {
  const t = { funded: 0n, tradingFee: 0n, manual: 0n, other: 0n, unknown: 0n, claimed: 0n, directUncounted: 0n };
  for (const x of txs) if (x.status === "success") for (const e of x.entries) {
    const a = BigInt(e.amount);
    if (e.kind === "fund") { t.funded += a; if (TRADING_FEE_SOURCES.includes(e.source)) t.tradingFee += a; else if (e.source === "manual") t.manual += a; else if (e.source === "unknown") t.unknown += a; else t.other += a; }
    else if (e.kind === "claim") t.claimed += a;
    else t.directUncounted += a;
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toString()])) as Record<keyof typeof t, string>;
}

// ---- export ----
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const CSV_HEADER = ["signature", "slot", "block_time_utc", "status", "found_via", "kind", "amount_base_units", "decimals", "source", "source_program", "evidence", "recipient", "recipient_index", "recipient_match", "note"];
export function historyCsv(txs: ObservedTx[], decimals: number | null): string {
  const rows: unknown[][] = [CSV_HEADER];
  for (const t of txs) {
    const time = t.blockTime == null ? "unknown" : new Date(t.blockTime * 1000).toISOString();
    const head = [t.signature, t.slot ?? "unknown", time, t.status, t.via.join("+")];
    if (!t.entries.length) rows.push([...head, "", "", decimals ?? "", "", "", "", "", "", "", t.reason ?? (t.status === "success" ? "no activity for this vault" : "")]);
    for (const e of t.entries) {
      if (e.kind === "fund") rows.push([...head, "fund", e.amount, decimals ?? "", e.source, e.sourceProgram ?? "", e.evidence, "", "", "", ""]);
      else if (e.kind === "claim") rows.push([...head, "claim", e.amount, decimals ?? "", "", "", e.evidence, e.recipient, e.index, e.recipientMatch, ""]);
      else rows.push([...head, "direct_transfer", e.amount, decimals ?? "", "", "", "", "", "", "", "Direct token transfer: outside DFS funding, not counted"]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
