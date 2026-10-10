// Pollen: owner-chosen, fixed-forever Meteora Dynamic Fee Sharing allocations. Pure rules.
import { z } from "zod";
import { isSolanaAddress } from "./registration";

export const DFS_PROGRAM_ID = "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Circle, mainnet, 6 decimals, SPL Token
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const POLLEN_MINTS: Record<string, { symbol: string; decimals: number }> = { [USDC_MINT]: { symbol: "USDC", decimals: 6 }, [WSOL_MINT]: { symbol: "SOL (wrapped)", decimals: 9 } };
export const TOTAL_BPS = 10_000;
const BANNED = new Set(["11111111111111111111111111111111", WSOL_MINT, USDC_MINT, DFS_PROGRAM_ID]);

export const PollenTerms = z.object({
  mint: z.string().refine((m) => m in POLLEN_MINTS, "Supported vault tokens are USDC and wrapped SOL."),
  recipients: z.array(z.object({ address: z.string(), bps: z.number().int() }).strict()).min(2, "At least 2 recipients.").max(5, "At most 5 recipients."),
}).strict().superRefine((t, ctx) => {
  const seen = new Set<string>(); let sum = 0;
  t.recipients.forEach((r, i) => {
    if (!isSolanaAddress(r.address) || BANNED.has(r.address)) ctx.addIssue({ code: "custom", path: ["recipients", i, "address"], message: "Each recipient must be a real, non-default Solana wallet." });
    if (seen.has(r.address)) ctx.addIssue({ code: "custom", path: ["recipients", i, "address"], message: "Recipients must be unique." });
    if (r.bps <= 0) ctx.addIssue({ code: "custom", path: ["recipients", i, "bps"], message: "Each share must be positive." });
    seen.add(r.address); sum += r.bps;
  });
  if (sum !== TOTAL_BPS) ctx.addIssue({ code: "custom", path: ["recipients"], message: `Shares must total exactly 100.00% (got ${(sum / 100).toFixed(2)}%).` });
});
export type PollenTermsT = z.infer<typeof PollenTerms>;
export function parseTerms(raw: unknown): PollenTermsT {
  const r = PollenTerms.safeParse(raw);
  if (!r.success) throw new Error(r.error.issues[0]?.message ?? "Invalid vault terms.");
  return r.data;
}

/** Exact decimal string → base units. Rejects negatives, excess precision, exponents and zero. */
export function parseAmount(text: string, decimals: number): bigint {
  const t = text.trim();
  if (!/^\d{1,15}(\.\d+)?$/.test(t)) throw new Error("Enter a plain positive number.");
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`At most ${decimals} decimal places.`);
  const v = BigInt(w + f.padEnd(decimals, "0"));
  if (v <= 0n) throw new Error("Amount must be greater than zero.");
  if (v > 0xffff_ffff_ffff_ffffn) throw new Error("Amount exceeds the u64 limit.");
  return v;
}
export const formatUnits = (v: bigint | string, decimals: number) => { const s = BigInt(v).toString().padStart(decimals + 1, "0"); const f = s.slice(-decimals).replace(/0+$/, ""); return s.slice(0, -decimals) + (f ? "." + f : ""); };

/** On-chain vault must match the reviewed terms exactly (order, addresses, shares, mint). */
export function compareVault(onchain: { mint: string; owner: string; users: { address: string; share: number }[] }, terms: PollenTermsT, owner: string) {
  const issues: string[] = [];
  if (onchain.mint !== terms.mint) issues.push("mint differs");
  if (onchain.owner !== owner) issues.push("owner differs");
  const live = onchain.users.filter((u) => u.address !== "11111111111111111111111111111111");
  if (live.length !== terms.recipients.length || live.some((u, i) => u.address !== terms.recipients[i].address || u.share !== terms.recipients[i].bps)) issues.push("recipient shares differ");
  return issues;
}

export type RoutingEligibility = { eligible: boolean; reasons: string[] };
/** DBC partner-fee routing into a vault is only possible when the immutable config already names the vault. */
/** Exact two-decimal percent -> bps ("33.33" -> 3333). Rejects more precision instead of rounding. */
export function percentToBps(text: string): number {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) throw new Error("Use a percentage with at most two decimals.");
  const [w, f = ""] = t.split("."); const bps = Number(w) * 100 + Number(f.padEnd(2, "0"));
  if (bps <= 0 || bps > 10_000) throw new Error("Each share must be between 0.01% and 100%.");
  return bps;
}

/** Vault eligibility as a DBC source-fee target: only PDA vaults derived from (base, mint). */
export function pdaProblems(v: { feeVaultType: number; derived: string; address: string }): string[] {
  if (v.feeVaultType !== 1) return ["This is a non-PDA (keypair) vault: it can be funded manually and claimed, but cannot receive DBC partner fees."];
  if (v.derived !== v.address) return ["Vault address does not equal the PDA derived from its base and mint."];
  return [];
}

const EVENT_IX_TAG = [228, 69, 165, 46, 81, 203, 154, 29];
const EVT_FUND = [15, 14, 233, 140, 19, 195, 163, 7], EVT_CLAIM = [6, 36, 88, 232, 53, 193, 253, 98];
/** Parses Anchor emit_cpi DFS events from a transaction's inner instructions (self-CPI data). */
export function dfsEvents(inner: Uint8Array[], b58: (b: Uint8Array) => string) {
  const out: ({ kind: "fund"; vault: string; amount: bigint } | { kind: "claim"; vault: string; user: string; amount: bigint })[] = [];
  const eq = (d: Uint8Array, o: number, t: number[]) => t.every((x, i) => d[o + i] === x);
  for (const d of inner) {
    if (d.length < 16 || !eq(d, 0, EVENT_IX_TAG)) continue;
    const dv = new DataView(d.buffer, d.byteOffset, d.length);
    if (eq(d, 8, EVT_FUND) && d.length >= 16 + 72) out.push({ kind: "fund", vault: b58(d.subarray(48, 80)), amount: dv.getBigUint64(80, true) });
    else if (eq(d, 8, EVT_CLAIM) && d.length >= 16 + 73) out.push({ kind: "claim", vault: b58(d.subarray(16, 48)), user: b58(d.subarray(48, 80)), amount: dv.getBigUint64(81, true) });
  }
  return out;
}

export function dbcPartnerRouting(p: { feeClaimer: string; quoteMint: string; collectFeeMode: number; vault: string; vaultMint: string; signer: string; recipients: string[]; migrated: boolean; pdaIssues?: string[] }): RoutingEligibility {
  const reasons: string[] = [...(p.pdaIssues ?? [])];
  if (p.feeClaimer !== p.vault) reasons.push("The DBC config's fee claimer is not this vault. Configs are immutable, so an existing pool cannot be retrofitted; a new config must name the vault.");
  if (p.quoteMint !== p.vaultMint) reasons.push("The vault token differs from the pool's quote token.");
  if (p.collectFeeMode !== 0) reasons.push("The pool does not collect fees in the quote token only.");
  if (!p.recipients.includes(p.signer)) reasons.push("Only a vault recipient may trigger the claim.");
  if (p.migrated) reasons.push("Pool has graduated; post-graduation DAMM v2 fees need position ownership that is not verified here.");
  return { eligible: reasons.length === 0, reasons };
}

/** Program math: claimable = (share × (feePerShare − checkpoint)) >> 64, rounded down (mul_shr). */
export const PRECISION_SCALE = 64n;
export function claimable(share: bigint, feePerShare: bigint, checkpoint: bigint) {
  if (feePerShare < checkpoint) throw new Error("Checkpoint ahead of vault fee-per-share.");
  return (share * (feePerShare - checkpoint)) >> PRECISION_SCALE;
}
/** Program funding math: feePerShare += (amount << 64) / totalShare, rounded down (shl_div). */
export const fundDelta = (amount: bigint, totalShare: bigint) => (amount << PRECISION_SCALE) / totalShare;
