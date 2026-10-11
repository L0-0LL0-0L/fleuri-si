// Pollen Staking: pure layout, PDA, instruction and accounting helpers mirroring
// onchain/pollen-staking (Rust). Cross-checked against the generated IDL and a Rust-written fixture.
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import idl from "../../onchain/pollen-staking/idl/pollen_staking.json";
import { FLEURI_MINT } from "@/lib/token";

export const STAKING_IDL = idl as any;
export const DFS_PROGRAM = "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh";
export const DFS_FEE_VAULT_AUTHORITY = "EYqHRdtepv1KKUkPAYMBYpSfiGfNd8sa55ZtswodTfBS";
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbd2nk3LS3sb2zYYPEvx2XPmBrWw2TxFHF7Hvb";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const DEFAULT_TERM_SECONDS = 7 * 86_400;
export const STAKE_MINT = FLEURI_MINT;
/** Local placeholder from declare_id!; never treated as a deployment. */
export const PLACEHOLDER_PROGRAM_ID = "59vLvCAQFHcZg3eYC4ehKQQKeWysUPTS1iQANPzJHQmk";

const enc = (s: string) => new TextEncoder().encode(s);
const pk = (s: string | PublicKey) => (typeof s === "string" ? new PublicKey(s) : s);

export function derive(programId: string, stakeMint = STAKE_MINT) {
  const p = pk(programId);
  const pool = PublicKey.findProgramAddressSync([enc("pool"), pk(stakeMint).toBytes()], p)[0];
  return {
    pool,
    principal: PublicKey.findProgramAddressSync([enc("principal"), pool.toBytes()], p)[0],
    reward: PublicKey.findProgramAddressSync([enc("reward"), pool.toBytes()], p)[0],
    programData: PublicKey.findProgramAddressSync([p.toBytes()], pk(UPGRADEABLE_LOADER))[0],
    position: (owner: string) => PublicKey.findProgramAddressSync([enc("position"), pool.toBytes(), pk(owner).toBytes()], p)[0],
  };
}
export const dfsEventAuthority = () => PublicKey.findProgramAddressSync([enc("__event_authority")], pk(DFS_PROGRAM))[0];
export const ata = (owner: string, mint: string) => PublicKey.findProgramAddressSync([pk(owner).toBytes(), pk(TOKEN_PROGRAM).toBytes(), pk(mint).toBytes()], pk(ATA_PROGRAM))[0];

export const disc = (kind: "instructions" | "accounts" | "events", name: string): number[] => {
  const x = (STAKING_IDL[kind] as any[]).find((i) => i.name === name);
  if (!x) throw new Error(`IDL has no ${name}`);
  return x.discriminator;
};
const eqDisc = (b: Uint8Array, d: number[]) => d.every((v, i) => b[i] === v);

export type Ledger = { duration: bigint; cooldown: bigint; totalActive: bigint; accPerShare: bigint; carry: bigint; streamAmount: bigint; streamStart: bigint; streamEnd: bigint; streamReleased: bigint; unallocated: bigint; lastUpdate: bigint; dfsFundedTotal: bigint; treasuryTotal: bigint; distributedTotal: bigint; claimedTotal: bigint };
export type PositionState = { active: bigint; checkpoint: bigint; frac: bigint; owed: bigint; pendingAmount: bigint; unlockTs: bigint; claimedTotal: bigint };

class R {
  o = 0; v: DataView;
  constructor(public b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.length); }
  u8() { return this.b[this.o++]; }
  u64() { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  i64() { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  key() { const k = new PublicKey(this.b.subarray(this.o, this.o + 32)).toBase58(); this.o += 32; return k; }
}
export function readLedger(r: R): Ledger {
  return { duration: r.i64(), cooldown: r.i64(), totalActive: r.u64(), accPerShare: r.u128(), carry: r.u128(), streamAmount: r.u64(), streamStart: r.i64(), streamEnd: r.i64(), streamReleased: r.u64(), unallocated: r.u64(), lastUpdate: r.i64(), dfsFundedTotal: r.u64(), treasuryTotal: r.u64(), distributedTotal: r.u64(), claimedTotal: r.u64() };
}
export function readPositionState(r: R): PositionState {
  return { active: r.u64(), checkpoint: r.u128(), frac: r.u128(), owed: r.u64(), pendingAmount: r.u64(), unlockTs: r.i64(), claimedTotal: r.u64() };
}
export const POOL_LEN = 8 + 7 * 32 + 2 + 136;
export const POSITION_LEN = 8 + 64 + 1 + 72;
export function decodePool(data: Uint8Array) {
  if (data.length < POOL_LEN || !eqDisc(data, disc("accounts", "Pool"))) throw new Error("Not a Pollen Staking pool account.");
  const r = new R(data); r.o = 8;
  return { initializer: r.key(), stakeMint: r.key(), rewardMint: r.key(), principalVault: r.key(), rewardVault: r.key(), feeVault: r.key(), feeTokenVault: r.key(), recipientIndex: r.u8(), bump: r.u8(), ledger: readLedger(r) };
}
export function decodePosition(data: Uint8Array) {
  if (data.length < POSITION_LEN || !eqDisc(data, disc("accounts", "Position"))) throw new Error("Not a Pollen Staking position account.");
  const r = new R(data); r.o = 8;
  return { pool: r.key(), owner: r.key(), bump: r.u8(), state: readPositionState(r) };
}
export const fixtureReader = (b: Uint8Array) => new R(b);

// ---- accounting mirror (math.rs) ----
const Q = 64n, MASK = (1n << 64n) - 1n;
export function vested(l: Ledger, now: bigint) {
  if (now >= l.streamEnd) return l.streamAmount;
  if (now <= l.streamStart) return 0n;
  return (l.streamAmount * (now - l.streamStart)) / (l.streamEnd - l.streamStart);
}
/** Mirror of `Ledger::fund`: refills keep an open window's deadline; only an ended window restarts. */
export function fundLedger(l0: Ledger, amount: bigint, fromDfs: boolean, now: bigint): Ledger {
  if (amount <= 0n) throw new Error("zero");
  const l = updateLedger(l0, now);
  if (fromDfs) l.dfsFundedTotal += amount; else l.treasuryTotal += amount;
  l.streamAmount = l.streamAmount - l.streamReleased + amount; l.streamStart = now; l.streamReleased = 0n;
  if (now >= l.streamEnd) l.streamEnd = now + l.duration;
  return l;
}
export function updateLedger(l0: Ledger, now: bigint): Ledger {
  const l = { ...l0 }; const v = vested(l, now); const delta = v - l.streamReleased; l.streamReleased = v;
  if (delta > 0n) {
    if (l.totalActive === 0n) l.unallocated += delta;
    else { const num = (delta << Q) + l.carry; l.accPerShare += num / l.totalActive; l.carry = num % l.totalActive; l.distributedTotal += delta; }
  }
  if (now > l.lastUpdate) l.lastUpdate = now;
  return l;
}
/** Exact claimable wSOL (lamports) at chain time `now`, exactly as the program would pay. */
export function claimableAt(l: Ledger, p: PositionState, now: bigint) {
  const u = updateLedger(l, now);
  const num = p.active * (u.accPerShare - p.checkpoint) + p.frac;
  return p.owed + (num >> Q);
}
export const fracPart = (l: Ledger, p: PositionState, now: bigint) => (p.active * (updateLedger(l, now).accPerShare - p.checkpoint) + p.frac) & MASK;

// ---- instructions ----
const u64le = (x: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, x, true); return b; };
const data = (name: string, args: Uint8Array = new Uint8Array()) => { const d = disc("instructions", name); const out = new Uint8Array(8 + args.length); out.set(d); out.set(args, 8); return out; };
const meta = (k: string | PublicKey, w = false, s = false) => ({ pubkey: pk(k), isWritable: w, isSigner: s });
export type StakingAction = "stake" | "request_unstake" | "cancel_unstake" | "withdraw" | "claim";
export const ACTIONS: StakingAction[] = ["stake", "request_unstake", "cancel_unstake", "withdraw", "claim"];

/** Builds one bounded instruction. Account order matches the IDL (asserted in tests). */
export function buildIx(programId: string, action: StakingAction, owner: string, a: { ownerToken?: string; ownerReward?: string; amount?: bigint }) {
  const d = derive(programId); const pos = d.position(owner); const prog = pk(programId);
  const amt = () => { if (a.amount == null || a.amount <= 0n || a.amount > MASK) throw new Error("Amount must be a positive u64."); return u64le(a.amount); };
  switch (action) {
    case "stake": return new TransactionInstruction({ programId: prog, data: Buffer.from(data("stake", amt())), keys: [meta(owner, true, true), meta(d.pool, true), meta(pos, true), meta(a.ownerToken!, true), meta(d.principal, true), meta(TOKEN_PROGRAM), meta(SYSTEM_PROGRAM)] });
    case "request_unstake": return new TransactionInstruction({ programId: prog, data: Buffer.from(data("request_unstake", amt())), keys: [meta(owner, false, true), meta(d.pool, true), meta(pos, true)] });
    case "cancel_unstake": return new TransactionInstruction({ programId: prog, data: Buffer.from(data("cancel_unstake")), keys: [meta(owner, false, true), meta(d.pool, true), meta(pos, true)] });
    case "withdraw": return new TransactionInstruction({ programId: prog, data: Buffer.from(data("withdraw")), keys: [meta(owner, false, true), meta(d.pool), meta(pos, true), meta(a.ownerToken!, true), meta(d.principal, true), meta(TOKEN_PROGRAM)] });
    case "claim": return new TransactionInstruction({ programId: prog, data: Buffer.from(data("claim")), keys: [meta(owner, false, true), meta(d.pool, true), meta(pos, true), meta(a.ownerReward!, true), meta(d.reward, true), meta(TOKEN_PROGRAM)] });
  }
}
export function buildHarvestIx(programId: string, caller: string, feeVault: string, feeTokenVault: string) {
  const d = derive(programId);
  return new TransactionInstruction({ programId: pk(programId), data: Buffer.from(data("harvest_fees")), keys: [meta(caller, false, true), meta(d.pool, true), meta(d.reward, true), meta(WSOL), meta(feeVault, true), meta(feeTokenVault, true), meta(DFS_FEE_VAULT_AUTHORITY), meta(dfsEventAuthority()), meta(DFS_PROGRAM), meta(TOKEN_PROGRAM)] });
}

// ---- events ----
const EVENT_FIELDS: Record<string, ("key" | "u64" | "i64")[]> = {
  Staked: ["key", "key", "u64", "u64"], UnstakeRequested: ["key", "key", "u64", "i64"], UnstakeCancelled: ["key", "key", "u64"],
  Withdrawn: ["key", "key", "u64"], Claimed: ["key", "key", "u64"], FeesHarvested: ["key", "key", "u64"], TreasuryFunded: ["key", "key", "u64"],
};
export type StakingEvent = { name: string; pool: string; who: string; amount: bigint; extra?: bigint };
/** Parses `Program data:` logs emitted by this program only (invocation depth tracked). */
export function parseEvents(logs: string[], programId: string): StakingEvent[] {
  const out: StakingEvent[] = []; const stack: string[] = [];
  for (const l of logs) {
    const inv = l.match(/^Program (\w+) invoke/); if (inv) { stack.push(inv[1]); continue; }
    if (/^Program \w+ (success|failed)/.test(l)) { stack.pop(); continue; }
    const m = l.match(/^Program data: (.+)$/); if (!m || stack[stack.length - 1] !== programId) continue;
    const b = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    for (const [name, f] of Object.entries(EVENT_FIELDS)) {
      if (!eqDisc(b, disc("events", name))) continue;
      const r = new R(b); r.o = 8; const vals = f.map((t) => (t === "key" ? r.key() : t === "u64" ? r.u64() : r.i64()));
      out.push({ name, pool: vals[0] as string, who: vals[1] as string, amount: vals[2] as bigint, extra: vals[3] as bigint | undefined });
    }
  }
  return out;
}
export const EXPECTED_EVENT: Record<StakingAction | "harvest", string> = { stake: "Staked", request_unstake: "UnstakeRequested", cancel_unstake: "UnstakeCancelled", withdraw: "Withdrawn", claim: "Claimed", harvest: "FeesHarvested" };

// ---- readiness ----
export type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };
export type ReadinessFacts = {
  cluster: string | null; genesisOk: boolean; rpcFresh: boolean;
  programId: string | null; programExecutable: boolean; programUpgradeable: boolean | null; upgradeAuthority: string | null;
  expectedHash: string | null; actualHash: string | null;
  mint: { address: string; exists: boolean; mintAuthority: string | null; freezeAuthority: string | null; owner: string | null; decimals?: number; initialized?: boolean } | null;
  pool: null | { stakeMint: string; rewardMint: string; principalVault: string; rewardVault: string; feeVault: string };
  vaultsOk: boolean; feeSourceOk: boolean; feeSourceDetail: string;
};
/** Every check must pass before deposits are enabled. Never infers success from missing data. */
export function readiness(f: ReadinessFacts, programId: string | null = f.programId): { checks: ReadyCheck[]; depositsEnabled: boolean } {
  const c = (id: string, label: string, ok: boolean, detail: string): ReadyCheck => ({ id, label, ok, detail });
  const d = programId ? derive(programId) : null;
  const checks = [
    c("cluster", "Solana mainnet", f.cluster === "mainnet-beta" && f.genesisOk, f.cluster !== "mainnet-beta" ? `Server cluster is ${f.cluster ?? "invalid"}.` : f.genesisOk ? "Genesis hash matches mainnet." : "RPC genesis does not match mainnet."),
    c("rpc", "Fresh RPC", f.rpcFresh, f.rpcFresh ? "Recent block time read from RPC." : "RPC data is stale or unavailable."),
    c("configured", "Program configured", !!programId && programId !== PLACEHOLDER_PROGRAM_ID, !programId ? "POLLEN_STAKING_PROGRAM_ID is not set: the program is not deployed by fleuri." : programId === PLACEHOLDER_PROGRAM_ID ? "Configured ID is the local placeholder, not a deployment." : programId),
    c("program", "Executable program", f.programExecutable, f.programExecutable ? "Program account is executable." : "No executable program at this address."),
    c("code", "Expected program code", !!f.expectedHash && f.expectedHash === f.actualHash, !f.expectedHash ? "POLLEN_STAKING_PROGRAM_SHA256 (expected ELF hash) is not set." : f.actualHash ? (f.expectedHash === f.actualHash ? "On-chain ELF hash matches the configured hash. This proves identity with the configured value only, not a reproducible build." : `On-chain ELF hash ${f.actualHash.slice(0, 12)}… differs from the configured hash.`) : "On-chain bytecode could not be read."),
    c("upgrade", "Upgrade authority shown", f.programUpgradeable !== null, f.programUpgradeable === null ? "Upgrade status unavailable." : f.programUpgradeable ? `Upgradeable by ${f.upgradeAuthority}. Terms are immutable per pool, but the code can still be upgraded by this key.` : "Immutable: no upgrade authority."),
    c("mint", "Correct FLEURI mint", !!f.mint?.exists && f.mint.address === STAKE_MINT && f.mint.owner === TOKEN_PROGRAM && f.mint.initialized === true && f.mint.decimals === STAKE_DECIMALS, !f.mint?.exists ? "Mint not readable." : f.mint.owner !== TOKEN_PROGRAM ? "Not a standard SPL Token mint." : f.mint.initialized !== true ? "Mint is not initialized." : f.mint.decimals !== STAKE_DECIMALS ? `Mint has ${f.mint.decimals} decimals, expected ${STAKE_DECIMALS}.` : STAKE_MINT),
    c("mintAuth", "Mint authority revoked", !!f.mint?.exists && f.mint.mintAuthority === null, f.mint?.mintAuthority ? `Mint authority is still ${f.mint.mintAuthority}.` : f.mint?.exists ? "Revoked." : "Unknown."),
    c("freezeAuth", "Freeze authority revoked", !!f.mint?.exists && f.mint.freezeAuthority === null, f.mint?.freezeAuthority ? `Freeze authority is still set (${f.mint.freezeAuthority}). The program refuses to initialize a pool for a freezable mint.` : f.mint?.exists ? "Revoked." : "Unknown."),
    c("pool", "Pool initialized", !!f.pool && !!d && f.pool.stakeMint === STAKE_MINT && f.pool.rewardMint === WSOL, !f.pool ? "No pool account at the derived address." : f.pool.stakeMint !== STAKE_MINT ? "Pool stake mint differs." : "Pool found."),
    c("vaults", "Canonical vaults", f.vaultsOk && !!f.pool && !!d && f.pool.principalVault === d.principal.toBase58() && f.pool.rewardVault === d.reward.toBase58() && f.pool.principalVault !== f.pool.rewardVault, f.vaultsOk ? "Principal and reward vaults are distinct program PDAs." : "Vaults not verified."),
    c("source", "Pollen fee source configured", f.feeSourceOk, f.feeSourceDetail),
  ];
  return { checks, depositsEnabled: checks.every((x) => x.ok) };
}

/** Exits (request/cancel/withdraw/claim) depend only on these: never on mint authorities or the fee source. */
export const EXIT_CHECK_IDS = ["cluster", "rpc", "configured", "program", "code", "pool", "vaults"] as const;
export function requiredChecks(action: StakingAction | "harvest", all: ReadyCheck[]): string[] {
  return action === "stake" ? all.map((c) => c.id) : action === "harvest" ? [...EXIT_CHECK_IDS, "source"] : [...EXIT_CHECK_IDS];
}
export const blockers = (action: StakingAction | "harvest", checks: ReadyCheck[]) => { const need = requiredChecks(action, checks); return checks.filter((c) => need.includes(c.id) && !c.ok); };

// ---- strict account checks (malformed/truncated input yields issues, never success) ----
export const STAKE_DECIMALS = 6;
const keyAt = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const u128At = (d: Uint8Array, o: number) => { const v = new DataView(d.buffer, d.byteOffset, d.length); return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true); };
const u32At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.length).getUint32(o, true);
/** SPL Token mint (82 bytes, owned by Token program, initialized). Throws on malformed data. */
export function decodeMintStrict(owner: string, d: Uint8Array) {
  if (owner !== TOKEN_PROGRAM) throw new Error("Mint is not owned by the SPL Token program.");
  if (d.length !== 82) throw new Error("Mint account has the wrong length.");
  const opt = (o: number) => { const t = u32At(d, o); if (t > 1) throw new Error("Malformed mint option."); return t === 1 ? keyAt(d, o + 4) : null; };
  if (d[45] > 1) throw new Error("Malformed mint initialized flag.");
  return { mintAuthority: opt(0), supply: new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(36, true), decimals: d[44], initialized: d[45] === 1, freezeAuthority: opt(46) };
}
/** Pool vault custody: 165 bytes, SPL owner, initialized (not frozen), mint, authority, no delegate, no close authority. */
export function checkTokenAccount(acc: { owner: string; data: Uint8Array } | null, want: { mint: string; authority: string }): string[] {
  if (!acc) return ["account missing"];
  const d = acc.data; const issues: string[] = [];
  if (acc.owner !== TOKEN_PROGRAM) issues.push("not owned by SPL Token");
  if (d.length !== 165) return [...issues, "wrong token account length"];
  if (keyAt(d, 0) !== want.mint) issues.push("wrong mint");
  if (keyAt(d, 32) !== want.authority) issues.push("wrong authority");
  if (u32At(d, 72) !== 0) issues.push("has a delegate");
  if (d[108] === 0) issues.push("uninitialized"); else if (d[108] === 2) issues.push("frozen"); else if (d[108] !== 1) issues.push("bad state");
  if (u32At(d, 129) !== 0) issues.push("has a close authority");
  return issues;
}
export const DFS_FEE_VAULT_DISC = [192, 178, 69, 232, 58, 149, 157, 132];
export const FEE_VAULT_LEN = 8 + 240 + 5 * 80;
/** Mirror of Rust `check_fee_vault`: exact DFS PDA wSOL vault naming `pool` at `index` with a share. */
export function checkFeeVault(address: string, acc: { owner: string; data: Uint8Array } | null, want: { feeTokenVault: string; pool: string; index: number }): { issues: string[]; share: number | null; totalShare: number | null; claimable: bigint | null } {
  const bad = (m: string) => ({ issues: [m], share: null, totalShare: null, claimable: null });
  if (!acc) return bad("fee vault missing");
  const d = acc.data;
  if (acc.owner !== DFS_PROGRAM) return bad("not owned by Dynamic Fee Sharing");
  if (d.length < FEE_VAULT_LEN || !DFS_FEE_VAULT_DISC.every((v, i) => d[i] === v)) return bad("not a DFS fee vault");
  const issues: string[] = [];
  if (keyAt(d, 40) !== WSOL) issues.push("token mint is not wSOL");
  if (d[104] !== 0) issues.push("token flag is not SPL Token");
  if (d[105] !== 1) issues.push("not a PDA fee vault (keypair vaults are rejected)");
  try { const pda = PublicKey.createProgramAddressSync([enc("fee_vault"), d.subarray(152, 184), pk(WSOL).toBytes(), Uint8Array.of(d[106])], pk(DFS_PROGRAM)); if (pda.toBase58() !== address) issues.push("address is not the canonical fee-vault PDA"); } catch { issues.push("address is not the canonical fee-vault PDA"); }
  const tv = PublicKey.findProgramAddressSync([enc("token_vault"), pk(address).toBytes()], pk(DFS_PROGRAM))[0].toBase58();
  if (tv !== want.feeTokenVault || keyAt(d, 72) !== tv) issues.push("token vault is not canonical");
  const totalShare = u32At(d, 120); if (totalShare === 0) issues.push("total share is zero");
  let share: number | null = null; let claimable: bigint | null = null;
  if (!Number.isInteger(want.index) || want.index < 0 || want.index > 4) issues.push("recipient index out of range");
  else {
    const u = 248 + want.index * 80; share = u32At(d, u + 32);
    if (keyAt(d, u) !== want.pool) issues.push(`recipient ${want.index} is not the pool PDA`); if (share === 0) issues.push("pool share is zero");
    // DFS Q64: claimable = share * (fee_per_share - user.fee_per_share_checkpoint) >> 64, for THIS index only
    // (DFS allows duplicate addresses, so never look the recipient up by address).
    const fps = u128At(d, 136), cp = u128At(d, u + 64);
    if (cp > fps) issues.push("recipient checkpoint is ahead of the vault"); else claimable = (BigInt(share) * (fps - cp)) >> 64n;
  }
  return { issues, share, totalShare, claimable };
}

/** Pure confirmation matcher: only this program's own event for the prepared action, pool and wallet. */
export function matchConfirmation(prep: { subject: string; wallet: string; payload: { programId: string; action: StakingAction | "harvest"; amount: string | null } }, logs: string[]) {
  const action = prep.payload.action;
  const evs = parseEvents(logs, prep.payload.programId).filter((e) => e.name === EXPECTED_EVENT[action] && e.pool === prep.subject);
  const ev = action === "harvest" ? evs[0] : evs.find((e) => e.who === prep.wallet);
  if (!ev) throw new Error(`No ${EXPECTED_EVENT[action]} event from Pollen Staking for this wallet in the confirmed transaction.`);
  if ((action === "stake" || action === "request_unstake") && ev.amount.toString() !== prep.payload.amount) throw new Error("On-chain amount differs from the prepared amount.");
  return ev;
}

/** Expected-hash normalization (also used by scripts/staking-elf-hash.ts for a local .so):
 * SHA-256 over the ELF = ProgramData bytes after the 45-byte header, with ALL trailing 0x00 bytes
 * removed (the loader zero-pads to the allocated length). Apply the same trim to the local .so. */
export function programElf(programData: Uint8Array) {
  let end = programData.length; while (end > 45 && programData[end - 1] === 0) end--;
  return programData.subarray(45, end);
}
export function decodeProgramData(d: Uint8Array) {
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  if (d.length < 45 || v.getUint32(0, true) !== 3) throw new Error("Not an upgradeable ProgramData account.");
  const has = d[12] === 1;
  if (d[12] > 1) throw new Error("Malformed upgrade authority option.");
  return { upgradeable: has, authority: has ? new PublicKey(d.subarray(13, 45)).toBase58() : null };
}
export function decodeProgramAccount(d: Uint8Array) {
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  if (d.length < 36 || v.getUint32(0, true) !== 2) throw new Error("Not an upgradeable program account.");
  return new PublicKey(d.subarray(4, 36)).toBase58();
}

export function formatLamports(v: bigint) { const s = v.toString().padStart(10, "0"); const f = s.slice(-9).replace(/0+$/, ""); return s.slice(0, -9) + (f ? "." + f : ""); }

// ---- coherent snapshot ----
export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
/** Clock sysvar (40 bytes): slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64 @32. */
export function decodeClock(acc: { owner: string; data: Uint8Array } | null) {
  if (!acc || acc.data.length !== 40) throw new Error("Clock sysvar unreadable.");
  const v = new DataView(acc.data.buffer, acc.data.byteOffset, 40);
  return { slot: v.getBigUint64(0, true), unixTimestamp: v.getBigInt64(32, true) };
}
type Acc = { owner: string; data: Uint8Array } | null;
/**
 * Derives the owner's position view from ONE multi-account read (same bank): pool ledger,
 * position and Clock must come from the same snapshot. A position checkpoint ahead of the
 * pool accumulator means the snapshot is incoherent: throw so the caller retries, never display it.
 */
export function positionView(programId: string, pool: Acc, position: Acc, clock: Acc) {
  if (!pool || pool.owner !== programId) throw new Error("Pool missing from snapshot.");
  const p = decodePool(pool.data); const c = decodeClock(clock);
  if (!position || position.owner !== programId) return { pool: p, clock: c, position: null };
  const pos = decodePosition(position.data);
  if (pos.state.checkpoint > p.ledger.accPerShare) throw new IncoherentSnapshot("Position checkpoint is ahead of the pool accumulator.");
  const claim = claimableAt(p.ledger, pos.state, c.unixTimestamp);
  if (claim < 0n) throw new IncoherentSnapshot("Negative claimable.");
  return { pool: p, clock: c, position: { ...pos, claimable: claim } };
}
export class IncoherentSnapshot extends Error {}
