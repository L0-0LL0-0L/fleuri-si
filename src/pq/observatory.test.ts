// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmmIdl } from "@meteora-ag/cp-amm-sdk";
import {
  DAMM_V2_PROGRAM, DBC_PROGRAM, DFS_EVENT_AUTHORITY, IX, TOKEN_PROGRAM, b58encode, classifySource, csvCell, decodeTx, historyCsv, mergeHistory, windowTotals,
  type History, type RawTx,
} from "./observatory";
import { DFS_PROGRAM_ID } from "./pollen";

const k = () => Keypair.generate().publicKey.toBase58();
const VAULT = k(), TOKEN_VAULT = k(), OTHER_VAULT = k(), SIGNER = k(), R0 = k(), R1 = k(), OTHER = k();
const ctx = { vault: VAULT, tokenVault: TOKEN_VAULT, recipients: [R0, R1] };
const disc = (n: string) => [...createHash("sha256").update(`global:${n}`).digest().subarray(0, 8)];
const le = (v: bigint, n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); return b; };
const cat = (...p: (readonly number[] | Uint8Array)[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const pkb = (s: string) => new PublicKey(s).toBytes();
const TAG = [228, 69, 165, 46, 81, 203, 154, 29];
const fundEv = (source: string, vault: string, amount: bigint, payload: Uint8Array) => cat(TAG, [15, 14, 233, 140, 19, 195, 163, 7], pkb(source), pkb(vault), le(amount, 8), le(123n, 16), le(BigInt(payload.length), 4), payload);
const claimEv = (vault: string, user: string, index: number, amount: bigint) => cat(TAG, [6, 36, 88, 232, 53, 193, 253, 98], pkb(vault), pkb(user), [index], le(amount, 8));
const SYS = "11111111111111111111111111111111";
const payloadOf = (d: number[]) => cat(d, le(2n ** 64n - 1n, 8), le(2n ** 64n - 1n, 8));

/** Builds a tx; `ixs` are outer instructions with optional nested (program, accounts, data, stack). */
type I = { p: string; a: string[]; d: Uint8Array; s?: number | null };
function tx(outer: { ix: I; inner?: I[] }[], opts: { err?: unknown; v0?: boolean; slot?: number } = {}): RawTx {
  const keys: string[] = [];
  const all = outer.flatMap((o) => [o.ix, ...(o.inner ?? [])]);
  for (const x of all) for (const a of [x.p, ...x.a]) if (!keys.includes(a)) keys.push(a);
  const split = opts.v0 ? Math.max(1, Math.floor(keys.length / 2)) : keys.length;
  const idx = (a: string) => keys.indexOf(a);
  const conv = (x: I) => ({ programIdIndex: idx(x.p), accounts: x.a.map(idx), data: b58encode(x.d), stackHeight: x.s === undefined ? 2 : x.s });
  return {
    slot: opts.slot ?? 100, blockTime: 1_760_000_000, version: opts.v0 ? 0 : "legacy",
    transaction: { message: { accountKeys: keys.slice(0, split), instructions: outer.map((o) => ({ ...conv(o.ix), stackHeight: null })) } },
    meta: { err: opts.err ?? null, loadedAddresses: opts.v0 ? { writable: keys.slice(split, split + 1), readonly: keys.slice(split + 1) } : null, innerInstructions: outer.map((o, i) => ({ index: i, instructions: (o.inner ?? []).map(conv) })) },
  };
}
const fundByClaim = (vault: string, source: string, payload: Uint8Array, s = 1): I => ({ p: DFS_PROGRAM_ID, a: [vault, TOKEN_VAULT, SIGNER, source, DFS_EVENT_AUTHORITY, DFS_PROGRAM_ID], d: cat(IX.fundByClaimingFee, le(BigInt(payload.length), 4), payload), s });
const event = (data: Uint8Array, s = 2): I => ({ p: DFS_PROGRAM_ID, a: [DFS_EVENT_AUTHORITY], d: data, s });
const sourceCpi = (source: string, payload: Uint8Array, s = 2): I => ({ p: source, a: [OTHER], d: payload, s });
const tokenXfer = (to: string, amount: bigint, s = 2): I => ({ p: TOKEN_PROGRAM, a: [OTHER, to, SIGNER], d: cat([3], le(amount, 8)), s });
function claimFrom(source: string, d: number[], amount = 500n, vault = VAULT) {
  const p = payloadOf(d);
  return { ix: fundByClaim(vault, source, p), inner: [sourceCpi(source, p), tokenXfer(TOKEN_VAULT, amount, 3), event(fundEv(source, vault, amount, p))] };
}

describe("discriminators", () => {
  it("match the installed Meteora SDK IDLs", () => {
    const dbc = (n: string) => (DynamicBondingCurveIdl as any).instructions.find((i: any) => i.name === n).discriminator;
    const damm = (n: string) => (CpAmmIdl as any).instructions.find((i: any) => i.name === n).discriminator;
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("claim_trading_fee")))).toBe("dbc_partner_trading_fee");
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("claim_trading_fee2")))).toBe("dbc_partner_trading_fee");
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("claim_creator_trading_fee")))).toBe("dbc_creator_trading_fee");
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("claim_creator_trading_fee2")))).toBe("dbc_creator_trading_fee");
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("partner_withdraw_surplus")))).toBe("dbc_partner_surplus");
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("creator_withdraw_surplus")))).toBe("dbc_creator_surplus");
    expect(classifySource(DBC_PROGRAM, Uint8Array.from(dbc("withdraw_migration_fee")))).toBe("dbc_migration_fee");
    expect(classifySource(DAMM_V2_PROGRAM, Uint8Array.from(damm("claim_position_fee")))).toBe("damm_v2_position_fee");
    expect(classifySource(DAMM_V2_PROGRAM, Uint8Array.from(damm("claim_reward")))).toBe("damm_v2_reward");
    // Right discriminator, wrong program: not a trading fee.
    expect(classifySource(DAMM_V2_PROGRAM, Uint8Array.from(dbc("claim_trading_fee")))).toBe("unknown");
    expect(IX.fundByClaimingFee).toEqual([48, 226, 100, 60, 217, 101, 248, 182]);
    expect(PublicKey.findProgramAddressSync([new TextEncoder().encode("__event_authority")], new PublicKey(DFS_PROGRAM_ID))[0].toBase58()).toBe(DFS_EVENT_AUTHORITY);
  });
});

describe("source attribution", () => {
  it("labels DBC partner and DAMM v2 position fees as trading fees, with the event's own amount", () => {
    const r = decodeTx("s1", tx([claimFrom(DBC_PROGRAM, disc("claim_trading_fee"), 777n), claimFrom(DAMM_V2_PROGRAM, disc("claim_position_fee"), 5n)]), ctx);
    expect(r.status).toBe("success");
    expect(r.entries).toMatchObject([{ kind: "fund", source: "dbc_partner_trading_fee", amount: "777", evidence: "proved" }, { kind: "fund", source: "damm_v2_position_fee", amount: "5" }]);
  });
  it("never calls rewards, surplus or migration fees trading fees", () => {
    const r = decodeTx("s2", tx([claimFrom(DAMM_V2_PROGRAM, disc("claim_reward"), 1n), claimFrom(DBC_PROGRAM, disc("partner_withdraw_surplus"), 2n), claimFrom(DBC_PROGRAM, disc("withdraw_migration_fee"), 3n)]), ctx);
    expect(r.entries.map((e: any) => e.source)).toEqual(["damm_v2_reward", "dbc_partner_surplus", "dbc_migration_fee"]);
    const w = windowTotals([r]);
    expect(w.tradingFee).toBe("0"); expect(w.other).toBe("6");
  });
  it("labels program fundFee deposits as manual", () => {
    const ix: I = { p: DFS_PROGRAM_ID, a: [VAULT, TOKEN_VAULT, OTHER, OTHER, SIGNER, TOKEN_PROGRAM, DFS_EVENT_AUTHORITY, DFS_PROGRAM_ID], d: cat(IX.fundFee, le(1000n, 8)), s: 1 };
    const r = decodeTx("s3", tx([{ ix, inner: [tokenXfer(TOKEN_VAULT, 1000n), event(fundEv(SYS, VAULT, 1000n, new Uint8Array()))] }]), ctx);
    expect(r.entries).toEqual([expect.objectContaining({ kind: "fund", source: "manual", amount: "1000" })]);
    expect(windowTotals([r]).directUncounted).toBe("0");
  });
  it("keeps the source unknown when the source CPI is missing or its payload differs", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const noCpi = decodeTx("s4", tx([{ ix: fundByClaim(VAULT, DBC_PROGRAM, p), inner: [event(fundEv(DBC_PROGRAM, VAULT, 9n, p))] }]), ctx);
    expect(noCpi.entries).toMatchObject([{ kind: "fund", source: "unknown", amount: "9" }]);
    const other = payloadOf(disc("claim_creator_trading_fee"));
    const mism = decodeTx("s5", tx([{ ix: fundByClaim(VAULT, DBC_PROGRAM, p), inner: [sourceCpi(DBC_PROGRAM, p), event(fundEv(DBC_PROGRAM, VAULT, 9n, other))] }]), ctx);
    expect(mism.entries).toMatchObject([{ source: "unknown" }]);
  });
  it("ignores events not emitted by DFS's event authority (spoofed events)", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const fake: I = { p: DFS_PROGRAM_ID, a: [OTHER], d: fundEv(DBC_PROGRAM, VAULT, 9n, p), s: 2 };
    const r = decodeTx("s6", tx([{ ix: fundByClaim(VAULT, DBC_PROGRAM, p), inner: [sourceCpi(DBC_PROGRAM, p), fake] }]), ctx);
    expect(r.entries).toEqual([]);
    const outsider: I = { p: OTHER, a: [DFS_EVENT_AUTHORITY], d: fundEv(DBC_PROGRAM, VAULT, 9n, p), s: 1 };
    expect(decodeTx("s6b", tx([{ ix: outsider }]), ctx).entries).toEqual([]);
  });
  it("matches multiple and mixed invocations to their own vault events; other vaults are counted, not attributed", () => {
    const a = claimFrom(DBC_PROGRAM, disc("claim_creator_trading_fee"), 10n);
    const b = claimFrom(DBC_PROGRAM, disc("claim_trading_fee"), 20n, OTHER_VAULT);
    const unrelated = { ix: { p: DBC_PROGRAM, a: [OTHER], d: Uint8Array.from(disc("claim_trading_fee")), s: 1 } as I };
    const r = decodeTx("s7", tx([unrelated, a, b]), ctx);
    expect(r.entries).toMatchObject([{ source: "dbc_creator_trading_fee", amount: "10" }]);
    expect(r.otherVaultEvents).toBe(1);
  });
  it("leaves attribution unknown when stack heights are missing and the nesting can't be proved", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const r = decodeTx("s8", tx([{ ix: fundByClaim(VAULT, DBC_PROGRAM, p), inner: [{ ...sourceCpi(DBC_PROGRAM, p), s: null }, { ...event(fundEv(DBC_PROGRAM, VAULT, 4n, p)), s: null }] }]), ctx);
    expect(r.entries).toMatchObject([{ source: "unknown", evidence: "ambiguous", amount: "4" }]);
  });
  it("attributes a DFS call made by CPI from another program by its own nesting", () => {
    const p = payloadOf(disc("claim_position_fee"));
    const wrapper: I = { p: OTHER, a: [OTHER], d: Uint8Array.from([1]), s: 1 };
    const r = decodeTx("s9", tx([{ ix: wrapper, inner: [fundByClaim(VAULT, DAMM_V2_PROGRAM, p, 2), sourceCpi(DAMM_V2_PROGRAM, p, 3), event(fundEv(DAMM_V2_PROGRAM, VAULT, 8n, p), 3)] }]), ctx);
    expect(r.entries).toMatchObject([{ source: "damm_v2_position_fee", amount: "8" }]);
  });
});

describe("claims, transfers and transaction status", () => {
  const claimIx = (user: string): I => ({ p: DFS_PROGRAM_ID, a: [VAULT, OTHER, TOKEN_VAULT, OTHER, OTHER, user, TOKEN_PROGRAM, DFS_EVENT_AUTHORITY, DFS_PROGRAM_ID], d: cat(IX.claimFee, [1]), s: 1 });
  it("records claims with exact integer amounts and recipient matching by slot", () => {
    const big = 18_446_744_073_709_551_615n;
    const ok = decodeTx("c1", tx([{ ix: claimIx(R1), inner: [event(claimEv(VAULT, R1, 1, big))] }]), ctx);
    expect(ok.entries).toEqual([expect.objectContaining({ kind: "claim", amount: big.toString(), recipient: R1, index: 1, recipientMatch: true })]);
    const wrongSlot = decodeTx("c2", tx([{ ix: claimIx(R1), inner: [event(claimEv(VAULT, R1, 0, 5n))] }]), ctx);
    expect(wrongSlot.entries[0]).toMatchObject({ recipientMatch: false });
  });
  it("shows direct token-vault transfers but never counts them as funding", () => {
    const r = decodeTx("d1", tx([{ ix: tokenXfer(TOKEN_VAULT, 42n, 1) }]), ctx);
    expect(r.entries).toEqual([{ kind: "direct_transfer", amount: "42", tokenProgram: TOKEN_PROGRAM }]);
    const w = windowTotals([r]); expect(w.funded).toBe("0"); expect(w.directUncounted).toBe("42");
  });
  it("resolves v0 loaded addresses", () => {
    const r = decodeTx("v0", tx([claimFrom(DBC_PROGRAM, disc("claim_trading_fee"), 11n)], { v0: true }), ctx);
    expect(r.entries).toMatchObject([{ source: "dbc_partner_trading_fee", amount: "11" }]);
  });
  it("drops failed transactions from accounting and marks missing / unsupported ones", () => {
    const failed = decodeTx("f1", tx([claimFrom(DBC_PROGRAM, disc("claim_trading_fee"), 11n)], { err: { InstructionError: [0, "Custom"] } }), ctx);
    expect(failed).toMatchObject({ status: "failed", entries: [] });
    expect(decodeTx("m1", null, ctx).status).toBe("unavailable");
    expect(decodeTx("u1", { ...tx([]), version: 1 }, ctx).status).toBe("unsupported");
    expect(decodeTx("n1", { ...tx([]), meta: null }, ctx).status).toBe("unavailable");
    const bad = tx([claimFrom(DBC_PROGRAM, disc("claim_trading_fee"))]); bad.transaction.message.instructions[0].programIdIndex = 99;
    expect(decodeTx("b1", bad, ctx).status).toBe("undecodable");
    expect(windowTotals([failed]).funded).toBe("0");
  });
});

describe("history merging and export", () => {
  const cov = (address: string, oldest: string, exhausted = false) => ({ address, oldestSignature: oldest, oldestSlot: 1, pages: 1, exhausted, error: null });
  it("dedupes the same signature seen via both streams and across pages, keeping the best record", () => {
    const a = { signature: "A", slot: 3, blockTime: null, status: "unavailable" as const, via: ["tokenVault" as const], entries: [], otherVaultEvents: 0 };
    const a2 = { ...a, status: "success" as const, via: ["vault" as const] };
    const b = { ...a2, signature: "B", slot: 5 };
    let h: History = { txs: [], coverage: {} as History["coverage"] };
    h = mergeHistory(h, { txs: [a, b], coverage: { vault: cov("V", "A") } });
    h = mergeHistory(h, { txs: [a2], coverage: { tokenVault: cov("T", "A", true) } });
    h = mergeHistory(h, { txs: [a2, b], coverage: {} });
    expect(h.txs.map((t) => t.signature)).toEqual(["B", "A"]);
    expect(h.txs[1]).toMatchObject({ status: "success", via: ["tokenVault", "vault"] });
    expect(h.coverage.tokenVault.exhausted).toBe(true);
  });
  it("escapes CSV cells and neutralises formulas", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-1")).toBe("'-1");
    const r = decodeTx("s1", tx([claimFrom(DBC_PROGRAM, disc("claim_trading_fee"), 777n)]), ctx);
    const csv = historyCsv([r, decodeTx("m1", null, ctx)], 9);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("amount_base_units");
    expect(lines[1]).toContain(",fund,777,9,dbc_partner_trading_fee,");
    expect(lines[2]).toContain("unavailable");
  });
});

describe("independent Observatory review regressions", () => {
  it("does not call a transaction successful when the RPC omits the success field", () => {
    const raw = tx([claimFrom(DBC_PROGRAM, disc("claim_trading_fee"), 11n)]);
    delete (raw.meta as any).err;
    expect(decodeTx("missing-success", raw, ctx).status).toBe("unavailable");
  });

  it("keeps both correct-vault funding events visible when mixed nesting is ambiguous", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const wrapper: I = { p: OTHER, a: [OTHER], d: Uint8Array.from([1]), s: 1 };
    const inner = [
      { ...fundByClaim(VAULT, DBC_PROGRAM, p), s: null },
      { ...sourceCpi(DBC_PROGRAM, p), s: null },
      { ...event(fundEv(DBC_PROGRAM, VAULT, 10n, p)), s: null },
      { ...fundByClaim(VAULT, DBC_PROGRAM, p), s: null },
      { ...sourceCpi(DBC_PROGRAM, p), s: null },
      { ...event(fundEv(DBC_PROGRAM, VAULT, 20n, p)), s: null },
    ];
    const result = decodeTx("mixed-no-heights", tx([{ ix: wrapper, inner }]), ctx);
    expect(result.entries.filter(e => e.kind === "fund")).toHaveLength(2);
    expect(windowTotals([result]).funded).toBe("30");
    expect(windowTotals([result]).tradingFee).toBe("0");
  });

  it("shows a direct transfer beside a DFS invocation for another vault", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const wrapper: I = { p: OTHER, a: [OTHER], d: Uint8Array.from([1]), s: 1 };
    const result = decodeTx("unrelated-dfs", tx([{ ix: wrapper, inner: [
      fundByClaim(OTHER_VAULT, DBC_PROGRAM, p, 2),
      sourceCpi(DBC_PROGRAM, p, 3),
      event(fundEv(DBC_PROGRAM, OTHER_VAULT, 7n, p), 3),
      tokenXfer(TOKEN_VAULT, 42n, 2),
    ] }]), ctx);
    expect(windowTotals([result]).directUncounted).toBe("42");
    expect(windowTotals([result]).funded).toBe("0");
  });

  it("does not include a mismatched recipient claim in verified claimed totals", () => {
    const ix: I = { p: DFS_PROGRAM_ID, a: [VAULT, OTHER, TOKEN_VAULT, OTHER, OTHER, R1, TOKEN_PROGRAM, DFS_EVENT_AUTHORITY, DFS_PROGRAM_ID], d: cat(IX.claimFee, [1]), s: 1 };
    const result = decodeTx("wrong-recipient-slot", tx([{ ix, inner: [event(claimEv(VAULT, R1, 0, 5n))] }]), ctx);
    expect(result.entries[0]).toMatchObject({ kind: "claim", recipientMatch: false });
    expect(windowTotals([result]).claimed).toBe("0");
  });

  it("does not verify a fee source against a different token vault", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const wrong = fundByClaim(VAULT, DBC_PROGRAM, p);
    wrong.a[1] = OTHER;
    const result = decodeTx("wrong-token-vault", tx([{ ix: wrong, inner: [sourceCpi(DBC_PROGRAM, p), event(fundEv(DBC_PROGRAM, VAULT, 9n, p))] }]), ctx);
    expect(windowTotals([result]).tradingFee).toBe("0");
  });

  it("does not label a contradictory fund event as a verified manual deposit", () => {
    const ix: I = { p: DFS_PROGRAM_ID, a: [VAULT, TOKEN_VAULT, OTHER, OTHER, SIGNER, TOKEN_PROGRAM, DFS_EVENT_AUTHORITY, DFS_PROGRAM_ID], d: cat(IX.fundFee, le(1000n, 8)), s: 1 };
    const p = payloadOf(disc("claim_trading_fee"));
    const result = decodeTx("manual-source-mismatch", tx([{ ix, inner: [event(fundEv(DBC_PROGRAM, VAULT, 10n, p))] }]), ctx);
    expect(windowTotals([result]).manual).toBe("0");
  });
});

describe("decoder follow-ups", () => {
  it("keeps an orphan correct-vault claim visible but outside verified totals", () => {
    const r = decodeTx("orphan", tx([{ ix: event(claimEv(VAULT, R0, 0, 3n), 1) }]), ctx);
    expect(r.entries).toMatchObject([{ kind: "claim", evidence: "ambiguous", recipientMatch: false }]);
    const w = windowTotals([r]); expect(w.claimed).toBe("0"); expect(w.claimedUnverified).toBe("3");
  });
  it("labels a token-vault transfer as unclassified when the vault's own DFS nesting can't be proved", () => {
    const p = payloadOf(disc("claim_trading_fee"));
    const r = decodeTx("uncl", tx([{ ix: fundByClaim(VAULT, DBC_PROGRAM, p), inner: [{ ...tokenXfer(TOKEN_VAULT, 5n), s: null }, { ...event(fundEv(DBC_PROGRAM, VAULT, 5n, p)), s: null }] }]), ctx);
    expect(r.entries.find((e) => e.kind === "direct_transfer")).toMatchObject({ scope: "unclassified" });
    const w = windowTotals([r]); expect(w.directUncounted).toBe("0"); expect(w.directUnclassified).toBe("5");
  });
  it("writes public metadata above the CSV table", () => {
    const csv = historyCsv([], 9, { cluster: "mainnet-beta", vault: VAULT, coverage_note: "window only" });
    expect(csv.split("\r\n").slice(0, 4)).toEqual(["metadata_key,metadata_value", "cluster,mainnet-beta", `vault,${VAULT}`, "coverage_note,window only"]);
    expect(csv).toContain("amount_base_units");
  });
});
