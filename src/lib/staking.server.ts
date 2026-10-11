// Pollen Staking server adapter. Reads live chain state, evaluates deposit readiness, and builds
// bounded, simulated, unsigned transactions for the owner's wallet. Never signs or holds keys.
import { PublicKey, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { GENESIS } from "@/pq/registration";
import {
  ATA_PROGRAM, PLACEHOLDER_PROGRAM_ID, STAKE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL, ata, buildHarvestIx, buildIx, claimableAt,
  CLOCK_SYSVAR, IncoherentSnapshot, positionView, blockers, checkFeeVault, checkTokenAccount, decodeMintStrict, decodePool, decodePosition, decodeProgramAccount, decodeProgramData, derive, matchConfirmation, programElf, readiness, type ReadinessFacts, type StakingAction,
} from "@/pq/staking";
import * as sol from "./solana.server";

type SavePrep = (ownerId: string, kind: string, wallet: string, subject: string, built: any, payload: Record<string, unknown>) => Promise<{ id: string; expires_at: string }>;
async function db() { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); return supabaseAdmin as any; }
const must = (r: { data: any; error: any }) => { if (r.error) throw new Error(r.error.message); return r.data; };

/** Public, read-only deployment identifiers. Privileged keys are never configured here. */
export function stakingEnv() {
  const id = process.env["POLLEN_STAKING_PROGRAM_ID"] || null;
  return { programId: id, expectedHash: (process.env["POLLEN_STAKING_PROGRAM_SHA256"] || "").toLowerCase() || null, feeVault: process.env["POLLEN_STAKING_FEE_VAULT"] || null };
}
const big = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");


type Acc = { owner: string; data: Uint8Array } | null;
const toAcc = (i: any): Acc => (i ? { owner: i.owner.toBase58(), data: new Uint8Array(i.data) } : null);
function amountOf(a: Acc) { if (!a || a.owner !== TOKEN_PROGRAM || a.data.length !== 165) return null; return new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true).toString(); }

/**
 * Reads pool, position, vaults, wallet token accounts, fee vault and the Clock sysvar in ONE
 * getMultipleAccountsInfoAndContext call (one confirmed bank). The fee vault address comes from the
 * pool, so if the pool's fee vault differs from the first guess it re-reads. Incoherent results retry.
 */
export async function readSnapshot(conn: Pick<Connection, "getMultipleAccountsInfoAndContext">, programId: string, d: ReturnType<typeof derive>, wallet: string | null, tries = 3) {
  let feeGuess: string | null = stakingEnv().feeVault; let lastErr: Error | null = null;
  for (let i = 0; i < tries; i++) {
    const keys = [d.pool, wallet ? d.position(wallet) : d.pool, d.principal, d.reward, wallet ? ata(wallet, STAKE_MINT) : d.pool, wallet ? ata(wallet, WSOL) : d.pool, new PublicKey(CLOCK_SYSVAR), new PublicKey(feeGuess ?? d.pool)];
    const r = await conn.getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed" });
    const v = r.value.map(toAcc);
    const accounts = { pool: v[0], position: wallet ? v[1] : null, principal: v[2], reward: v[3], ataF: wallet ? v[4] : null, ataW: wallet ? v[5] : null, clock: v[6], feeVault: feeGuess ? v[7] : null };
    if (!accounts.pool || accounts.pool.owner !== programId) return { slot: r.context.slot, view: null, accounts, feeVaultKey: feeGuess };
    try {
      const view = positionView(programId, accounts.pool, accounts.position, accounts.clock);
      if (view.pool.feeVault !== feeGuess) { feeGuess = view.pool.feeVault; continue; }
      return { slot: r.context.slot, view, accounts, feeVaultKey: feeGuess };
    } catch (x) { if (!(x instanceof IncoherentSnapshot)) throw x; lastErr = x; }
  }
  throw new Error(`Could not read a coherent chain snapshot: ${lastErr?.message ?? "fee vault kept changing"}`);
}

/** Reads everything needed for the page and for gating; unknowns stay unknown. */
export async function readState(wallet: string | null) {
  const e = sol.solEnv(); const s = stakingEnv();
  const facts: ReadinessFacts = { cluster: e.cluster, genesisOk: false, rpcFresh: false, programId: s.programId, programExecutable: false, programUpgradeable: null, upgradeAuthority: null, expectedHash: s.expectedHash, actualHash: null, mint: null, pool: null, vaultsOk: false, feeSourceOk: false, feeSourceDetail: "Fee source not checked." };
  const out: any = { cluster: e.cluster, programId: s.programId, placeholder: PLACEHOLDER_PROGRAM_ID, configuredFeeVault: s.feeVault, stakeMint: STAKE_MINT, rewardMint: WSOL, errors: [] as string[] };
  let conn: Connection | null = null;
  try {
    conn = sol.connection();
    const g = await conn.getGenesisHash(); facts.genesisOk = !!e.cluster && g === GENESIS[e.cluster];
    const slot = await conn.getSlot("confirmed"); const bt = await conn.getBlockTime(slot);
    out.slot = slot; out.chainTime = bt; facts.rpcFresh = bt != null && Math.abs(Date.now() / 1000 - bt) < 180;
    const mi = await conn.getAccountInfo(new PublicKey(STAKE_MINT));
    if (mi) { const m = decodeMintStrict(mi.owner.toBase58(), mi.data); facts.mint = { address: STAKE_MINT, exists: true, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority, owner: mi.owner.toBase58(), decimals: m.decimals, initialized: m.initialized }; out.mint = { ...big(m), owner: mi.owner.toBase58() }; }
  } catch (x) { out.errors.push(`RPC: ${(x as Error).message}`); }
  if (conn && s.programId && s.programId !== PLACEHOLDER_PROGRAM_ID) {
    try {
      const d = derive(s.programId);
      const pa = await conn.getAccountInfo(new PublicKey(s.programId));
      facts.programExecutable = !!pa?.executable && pa.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111";
      if (pa && facts.programExecutable) {
        const pdAddr = decodeProgramAccount(pa.data);
        if (pdAddr !== d.programData.toBase58()) throw new Error("ProgramData address is not canonical.");
        const pd = await conn.getAccountInfo(d.programData);
        if (pd) { const h = decodeProgramData(pd.data); facts.programUpgradeable = h.upgradeable; facts.upgradeAuthority = h.authority; facts.actualHash = hex(await crypto.subtle.digest("SHA-256", programElf(pd.data) as any)); }
      }
      // ONE confirmed bank: pool, position, vaults, wallet token accounts, fee vault and Clock.
      const snap = await readSnapshot(conn, s.programId, d, wallet);
      out.slot = snap.slot; out.chainTime = Number(snap.view?.clock.unixTimestamp ?? out.chainTime); out.asOf = { slot: snap.slot, unixTimestamp: out.chainTime, source: "clock sysvar in the same multi-account read" };
      if (snap.view) {
        facts.rpcFresh = Math.abs(Date.now() / 1000 - out.chainTime) < 180;
        const p = snap.view.pool; const A = snap.accounts;
        facts.pool = { stakeMint: p.stakeMint, rewardMint: p.rewardMint, principalVault: p.principalVault, rewardVault: p.rewardVault, feeVault: p.feeVault };
        const pIssues = checkTokenAccount(A.principal, { mint: p.stakeMint, authority: d.pool.toBase58() });
        const rIssues = checkTokenAccount(A.reward, { mint: WSOL, authority: d.pool.toBase58() });
        facts.vaultsOk = !pIssues.length && !rIssues.length;
        out.vaultIssues = { principal: pIssues, reward: rIssues };
        out.pool = { address: d.pool.toBase58(), ...p, ledger: big(p.ledger), principalBalance: amountOf(A.principal), rewardBalance: amountOf(A.reward) };
        const chk = p.feeVault === snap.feeVaultKey ? checkFeeVault(p.feeVault, A.feeVault, { feeTokenVault: p.feeTokenVault, pool: d.pool.toBase58(), index: p.recipientIndex }) : { issues: ["fee vault not in snapshot"], share: null, totalShare: null, claimable: null };
        const issues = [...chk.issues];
        if (s.feeVault && s.feeVault !== p.feeVault) issues.push("pool fee source differs from the configured vault");
        let v: any = null;
        try { const { readVault } = await import("./pollen.server"); v = await readVault(conn, p.feeVault); if (v.pdaIssues?.length) issues.push(...v.pdaIssues); } catch (x) { issues.push(`vault unreadable: ${(x as Error).message}`); }
        const ok = issues.length === 0;
        facts.feeSourceOk = ok;
        facts.feeSourceDetail = ok ? `Pool PDA is recipient #${p.recipientIndex} (${((chk.share! / chk.totalShare!) * 100).toFixed(2)}% of shares) of DFS PDA vault ${p.feeVault}. Anyone can fund a DFS vault manually, so claims prove Pollen funding, not trading-fee origin. No verified fee routing into it is configured.` : `Fee source rejected: ${issues.join("; ")}.`;
        out.feeSource = { address: p.feeVault, funded: v?.funded ?? null, recipientIndex: p.recipientIndex, share: chk.share, totalShare: chk.totalShare, unclaimedForPool: chk.claimable?.toString() ?? null, issues };
        if (wallet) {
          const pos = snap.view.position;
          out.position = pos ? { address: d.position(wallet).toBase58(), ...big(pos.state), claimable: pos.claimable.toString() } : null;
          out.balances = { fleuri: amountOf(A.ataF), wsol: amountOf(A.ataW) };
        }
      } else facts.feeSourceDetail = "No pool, so no fee source.";
    } catch (x) { out.errors.push((x as Error).message); }
  } else if (!s.programId) facts.feeSourceDetail = "Not deployed: no program configured.";
  const r = readiness(facts, s.programId);
  return { ...out, facts: { ...facts }, checks: r.checks, depositsEnabled: r.depositsEnabled };
}

function ataIx(payer: string, owner: string, mint: string) {
  return new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]), keys: [
    { pubkey: new PublicKey(payer), isSigner: true, isWritable: true }, { pubkey: ata(owner, mint), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false }, { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false }, { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false }] });
}

export async function prepare(savePrep: SavePrep, ownerId: string, input: { wallet: string; action: StakingAction | "harvest"; amount?: string }) {
  const st = await readState(input.wallet);
  const failing = blockers(input.action, st.checks);
  if (failing.length) throw new Error(`Blocked: ${failing.map((c: any) => `${c.label} — ${c.detail}`).join(" ")}`);
  const programId = st.programId as string; const conn = sol.connection(); const d = derive(programId);
  const amount = input.amount != null ? BigInt(input.amount) : undefined;
  const pos = st.position;
  const tx = new Transaction();
  if (input.action === "harvest") {
    if (!st.feeSource || BigInt(st.feeSource.unclaimedForPool ?? 0) <= 0n) throw new Error("The Pollen vault has nothing claimable for this pool yet.");
    tx.add(buildHarvestIx(programId, input.wallet, st.pool.feeVault, st.pool.feeTokenVault));
  } else {
    if (input.action === "stake") { if (!amount || amount <= 0n) throw new Error("Enter an amount."); if (BigInt(st.balances?.fleuri ?? 0) < amount) throw new Error("Wallet FLEURI balance is too low."); }
    if (input.action === "request_unstake") { if (!pos) throw new Error("No position."); if (BigInt(pos.pendingAmount) > 0n) throw new Error("A withdrawal is already pending; withdraw or cancel it first."); if (!amount || amount <= 0n || amount > BigInt(pos.active)) throw new Error("Amount exceeds active stake."); }
    if (input.action === "cancel_unstake" && (!pos || BigInt(pos.pendingAmount) === 0n)) throw new Error("No pending withdrawal.");
    if (input.action === "withdraw") { if (!pos || BigInt(pos.pendingAmount) === 0n) throw new Error("No pending withdrawal."); if (BigInt(st.chainTime) < BigInt(pos.unlockTs)) throw new Error("Cooldown has not ended (chain time)."); }
    if (input.action === "claim" && (!pos || BigInt(pos.claimable ?? 0) === 0n)) throw new Error("Nothing claimable yet.");
    if (input.action === "withdraw" && st.balances?.fleuri == null) tx.add(ataIx(input.wallet, input.wallet, STAKE_MINT));
    if (input.action === "claim" && st.balances?.wsol == null) tx.add(ataIx(input.wallet, input.wallet, WSOL));
    tx.add(buildIx(programId, input.action, input.wallet, { ownerToken: ata(input.wallet, STAKE_MINT).toBase58(), ownerReward: ata(input.wallet, WSOL).toBase58(), amount }));
  }
  const built = sol.finalizeUnsigned(tx, new PublicKey(input.wallet), await conn.getLatestBlockhash("confirmed"), [input.wallet], [programId]);
  const cost = await sol.estimateWalletCost(conn, built.message, input.wallet);
  if (!cost.ok) throw new Error(cost.error);
  const prep = await savePrep(ownerId, `staking_${input.action}`, input.wallet, d.pool.toBase58(), built, { action: input.action, programId, amount: amount?.toString() ?? null, position: input.action === "harvest" ? null : d.position(input.wallet).toBase58(), before: pos ?? null, expectedClaim: input.action === "claim" ? pos?.claimable : null });
  const L = st.pool.ledger;
  const review = {
    action: input.action, amount: amount?.toString() ?? null, pool: d.pool.toBase58(), programId, chainTime: st.chainTime ?? null,
    cooldownSeconds: input.action === "request_unstake" ? String(L.cooldown) : null,
    unlockAtChainTime: input.action === "request_unstake" && st.chainTime ? String(BigInt(st.chainTime) + BigInt(L.cooldown)) : input.action === "withdraw" ? pos?.unlockTs ?? null : null,
    pendingAmount: input.action === "withdraw" || input.action === "cancel_unstake" ? pos?.pendingAmount ?? null : null,
    expectedClaim: input.action === "claim" ? pos?.claimable ?? null : null,
    harvestable: input.action === "harvest" ? String(st.feeSource.unclaimedForPool) : null,
    createsTokenAccount: tx.instructions.length > 1,
  };
  return { preparationId: prep.id, transaction: sol.unsignedB64(built.tx), cluster: st.cluster, cost, review };
}

/** Confirmation accepts only this program's own events matching the prepared action. */
export async function confirmStaking(prep: any, tx: { slot: number; ixs: { program: string }[] }, conn: Connection, ownerId: string) {
  const programId = prep.payload.programId as string;
  if (!tx.ixs.some((x) => x.program === programId)) throw new Error("Confirmed transaction did not call Pollen Staking.");
  const t = await conn.getParsedTransaction(prep.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t?.meta?.logMessages) return { status: "pending" as const, detail: "Waiting for transaction logs…" };
  const action = prep.payload.action as StakingAction | "harvest";
  if (t.meta.err) throw new Error("Transaction failed on chain.");
  const ev = matchConfirmation(prep, t.meta.logMessages);
  const d = await db();
  must(await d.from("chain_preparations").update({ confirmed_at: new Date().toISOString(), payload: { ...prep.payload, verifiedSlot: tx.slot, event: { name: ev.name, amount: ev.amount.toString(), extra: ev.extra?.toString() ?? null } } }).eq("id", prep.id).eq("owner_id", ownerId));
  const words: Record<string, string> = { stake: "Staked", request_unstake: "Unstake requested for", cancel_unstake: "Cancelled unstake of", withdraw: "Withdrew", claim: "Claimed", harvest: "Harvested" };
  const unit = action === "claim" || action === "harvest" ? "lamports of wSOL" : "base units of FLEURI";
  return { status: "confirmed" as const, detail: `${words[action]} ${ev.amount} ${unit} in slot ${tx.slot}${action === "request_unstake" ? `; unlocks at chain time ${ev.extra}` : ""}.`, id: prep.subject };
}
