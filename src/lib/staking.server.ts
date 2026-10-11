// Pollen Staking server adapter. Reads live chain state, evaluates deposit readiness, and builds
// bounded, simulated, unsigned transactions for the owner's wallet. Never signs or holds keys.
import { PublicKey, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { GENESIS } from "@/pq/registration";
import {
  ATA_PROGRAM, EXPECTED_EVENT, PLACEHOLDER_PROGRAM_ID, STAKE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL, ata, buildHarvestIx, buildIx, claimableAt,
  decodePool, decodePosition, decodeProgramAccount, decodeProgramData, derive, parseEvents, programElf, readiness, type ReadinessFacts, type StakingAction,
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

function decodeMint(d: Uint8Array) {
  if (d.length < 82) throw new Error("Not an SPL mint.");
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  const opt = (o: number) => { const t = v.getUint32(o, true); if (t > 1) throw new Error("Malformed mint option."); return t === 1 ? new PublicKey(d.subarray(o + 4, o + 36)).toBase58() : null; };
  return { mintAuthority: opt(0), supply: v.getBigUint64(36, true), decimals: d[44], freezeAuthority: opt(46) };
}

async function tokenAmount(conn: Connection, a: PublicKey) { const i = await conn.getAccountInfo(a); if (!i || i.data.length < 72) return null; return new DataView(i.data.buffer, i.data.byteOffset).getBigUint64(64, true); }

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
    if (mi) { const m = decodeMint(mi.data); facts.mint = { address: STAKE_MINT, exists: true, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority, owner: mi.owner.toBase58() }; out.mint = { ...big(m), owner: mi.owner.toBase58() }; }
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
      const pi = await conn.getAccountInfo(d.pool);
      if (pi && pi.owner.toBase58() === s.programId) {
        const p = decodePool(pi.data);
        facts.pool = { stakeMint: p.stakeMint, rewardMint: p.rewardMint, principalVault: p.principalVault, rewardVault: p.rewardVault, feeVault: p.feeVault };
        const [pv, rv] = await Promise.all([conn.getAccountInfo(d.principal), conn.getAccountInfo(d.reward)]);
        const tokOk = (i: any, mint: string) => !!i && i.owner.toBase58() === TOKEN_PROGRAM && new PublicKey(i.data.subarray(0, 32)).toBase58() === mint && new PublicKey(i.data.subarray(32, 64)).equals(d.pool) && new DataView(i.data.buffer, i.data.byteOffset).getUint32(72, true) === 0;
        facts.vaultsOk = tokOk(pv, p.stakeMint) && tokOk(rv, WSOL);
        out.pool = { address: d.pool.toBase58(), ...p, ledger: big(p.ledger), principalBalance: (await tokenAmount(conn, d.principal))?.toString() ?? null, rewardBalance: (await tokenAmount(conn, d.reward))?.toString() ?? null };
        try {
          const { readVault } = await import("./pollen.server");
          const v = await readVault(conn, p.feeVault);
          const me = v.recipients.find((r) => r.address === d.pool.toBase58());
          const ok = (!s.feeVault || s.feeVault === p.feeVault) && v.mint === WSOL && v.tokenVault === p.feeTokenVault && !!me;
          facts.feeSourceOk = ok;
          facts.feeSourceDetail = ok ? `Pool PDA is a fixed recipient (${(me!.share / 100).toFixed(2)}%) of DFS vault ${p.feeVault}. Which trading pools route fees into that vault is not verified here.` : s.feeVault && s.feeVault !== p.feeVault ? "Pool fee source differs from the configured vault." : "Fee vault does not name this pool as a wSOL recipient.";
          out.feeSource = { address: p.feeVault, funded: v.funded, recipientShareBps: me?.share ?? null, unclaimedForPool: me?.unclaimed ?? null, pdaIssues: v.pdaIssues };
        } catch (x) { facts.feeSourceDetail = `Fee vault unreadable: ${(x as Error).message}`; }
        if (wallet) {
          const posAddr = d.position(wallet); const ps = await conn.getAccountInfo(posAddr);
          const pos = ps && ps.owner.toBase58() === s.programId ? decodePosition(ps.data) : null;
          const now = BigInt(out.chainTime ?? 0);
          out.position = pos ? { address: posAddr.toBase58(), ...big(pos.state), claimable: out.chainTime ? claimableAt(p.ledger, pos.state, now).toString() : null } : null;
          out.balances = { fleuri: (await tokenAmount(conn, ata(wallet, STAKE_MINT)))?.toString() ?? null, wsol: (await tokenAmount(conn, ata(wallet, WSOL)))?.toString() ?? null };
        }
      } else facts.feeSourceDetail = "No pool, so no fee source.";
    } catch (x) { out.errors.push((x as Error).message); }
  } else if (!s.programId) facts.feeSourceDetail = "Not deployed: no program configured.";
  const r = readiness(facts, s.programId);
  return { ...out, facts: { ...facts }, checks: r.checks, depositsEnabled: r.depositsEnabled };
}

const EXIT_CHECKS = ["cluster", "rpc", "configured", "program", "code", "pool", "vaults"];
function ataIx(payer: string, owner: string, mint: string) {
  return new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]), keys: [
    { pubkey: new PublicKey(payer), isSigner: true, isWritable: true }, { pubkey: ata(owner, mint), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false }, { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false }, { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false }] });
}

export async function prepare(savePrep: SavePrep, ownerId: string, input: { wallet: string; action: StakingAction | "harvest"; amount?: string }) {
  const st = await readState(input.wallet);
  const need = input.action === "stake" ? st.checks.map((c: any) => c.id) : input.action === "harvest" ? [...EXIT_CHECKS, "source"] : EXIT_CHECKS;
  const failing = st.checks.filter((c: any) => need.includes(c.id) && !c.ok);
  if (failing.length) throw new Error(`Blocked: ${failing.map((c: any) => `${c.label} — ${c.detail}`).join(" ")}`);
  const programId = st.programId as string; const conn = sol.connection(); const d = derive(programId);
  const amount = input.amount != null ? BigInt(input.amount) : undefined;
  const pos = st.position;
  const tx = new Transaction();
  if (input.action === "harvest") {
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
  return { preparationId: prep.id, transaction: sol.unsignedB64(built.tx), cluster: st.cluster, cost, review: { action: input.action, amount: amount?.toString() ?? null, pool: d.pool.toBase58(), programId } };
}

/** Confirmation accepts only this program's own events matching the prepared action. */
export async function confirmStaking(prep: any, tx: { slot: number; ixs: { program: string }[] }, conn: Connection, ownerId: string) {
  const programId = prep.payload.programId as string;
  if (!tx.ixs.some((x) => x.program === programId)) throw new Error("Confirmed transaction did not call Pollen Staking.");
  const t = await conn.getParsedTransaction(prep.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t?.meta?.logMessages) return { status: "pending" as const, detail: "Waiting for transaction logs…" };
  const action = prep.payload.action as StakingAction | "harvest";
  const evs = parseEvents(t.meta.logMessages, programId).filter((e) => e.name === EXPECTED_EVENT[action] && e.pool === prep.subject);
  const ev = action === "harvest" ? evs[0] : evs.find((e) => e.who === prep.wallet);
  if (!ev) throw new Error(`No ${EXPECTED_EVENT[action]} event from Pollen Staking for this wallet in the confirmed transaction.`);
  if ((action === "stake" || action === "request_unstake") && ev.amount.toString() !== prep.payload.amount) throw new Error("On-chain amount differs from the prepared amount.");
  const d = await db();
  must(await d.from("chain_preparations").update({ confirmed_at: new Date().toISOString(), payload: { ...prep.payload, verifiedSlot: tx.slot, event: { name: ev.name, amount: ev.amount.toString(), extra: ev.extra?.toString() ?? null } } }).eq("id", prep.id).eq("owner_id", ownerId));
  const words: Record<string, string> = { stake: "Staked", request_unstake: "Unstake requested for", cancel_unstake: "Cancelled unstake of", withdraw: "Withdrew", claim: "Claimed", harvest: "Harvested" };
  const unit = action === "claim" || action === "harvest" ? "lamports of wSOL" : "base units of FLEURI";
  return { status: "confirmed" as const, detail: `${words[action]} ${ev.amount} ${unit} in slot ${tx.slot}${action === "request_unstake" ? `; unlocks at chain time ${ev.extra}` : ""}.`, id: prep.subject };
}
