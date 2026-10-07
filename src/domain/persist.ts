// Pure mapping between the domain GardenState and cloud table rows,
// plus the diff that turns one engine step into an atomic commit payload.
import { STATE_VERSION, type Agent, type Coin, type GardenEvent, type GardenState, type LedgerEntry, type Owner } from "./types";

export interface Rows {
  meta: { version: number; seq: number; rng: number; treasury: number };
  agents: any[];
  coins: any[];
  holdings: any[];
  events: any[];
  owner?: any | null;
  thoughts?: any[];
  prices?: any[];
  ledger?: any[];
}

const n = (v: unknown) => (v == null ? 0 : Number(v));

export function stateFromRows(r: Rows): GardenState {
  const agents: Record<string, Agent> = {};
  for (const a of r.agents)
    agents[a.id] = {
      id: a.id, handle: a.handle, name: a.name, bio: a.bio, persona: a.persona, strategy: a.strategy,
      archetype: a.archetype, risk: a.risk, avatar: a.avatar, ownerId: a.owner_id, status: a.status,
      cash: n(a.cash), fundedTotal: n(a.funded_total), holdings: {}, followers: a.followers,
      following: Array.isArray(a.following) ? a.following : [], createdAt: n(a.created_at),
      lastActionAt: n(a.last_action_at), thoughts: [], realizedPnl: n(a.realized_pnl),
    };
  const coins: Record<string, Coin> = {};
  for (const c of r.coins)
    coins[c.symbol] = {
      symbol: c.symbol, name: c.name, tagline: c.tagline, creatorId: c.creator_id, createdAt: n(c.created_at),
      vSol: n(c.v_sol), vTok: n(c.v_tok), raised: n(c.raised), graduated: c.graduated,
      graduatedAt: c.graduated_at == null ? undefined : n(c.graduated_at), history: [], holders: {},
      buys: c.buys, sells: c.sells, volume: n(c.volume), fees: n(c.fees), avatar: c.avatar,
    };
  for (const h of r.holdings) {
    const amount = n(h.amount);
    if (agents[h.agent_id]) agents[h.agent_id].holdings[h.symbol] = { amount, cost: n(h.cost) };
    if (coins[h.symbol]) coins[h.symbol].holders[h.agent_id] = amount;
  }
  for (const t of r.thoughts ?? []) agents[t.agent_id]?.thoughts.push({ t: n(t.t), text: t.text });
  for (const p of r.prices ?? []) coins[p.symbol]?.history.push({ t: n(p.t), p: n(p.p) });
  const events: GardenEvent[] = r.events.map((e) => ({
    id: e.id, t: n(e.t), kind: e.kind, agentId: e.agent_id, symbol: e.symbol ?? undefined, text: e.text ?? undefined,
    sol: e.sol == null ? undefined : n(e.sol), tokens: e.tokens == null ? undefined : n(e.tokens),
    price: e.price == null ? undefined : n(e.price), parentId: e.parent_id ?? undefined,
    targetId: e.target_id ?? undefined, botLikes: e.bot_likes, replyCount: e.reply_count,
  }));
  const owner: Owner | null = r.owner
    ? {
        id: r.owner.id, createdAt: n(r.owner.created_at), vsol: n(r.owner.vsol),
        wallet: r.owner.wallet_address
          ? { provider: r.owner.wallet_provider, address: r.owner.wallet_address, verified: r.owner.wallet_verified, signedAt: n(r.owner.wallet_signed_at) }
          : null,
      }
    : null;
  const ledger: LedgerEntry[] = (r.ledger ?? []).map((l) => ({
    id: l.id, t: n(l.t), kind: l.kind, agentId: l.agent_id ?? undefined, symbol: l.symbol ?? undefined, amount: n(l.amount), note: l.note,
  }));
  return {
    version: STATE_VERSION, rng: n(r.meta.rng) | 0, seq: n(r.meta.seq), agents, coins, events, ledger,
    treasury: n(r.meta.treasury), owner, alerts: [],
    prefs: { agents: [], coins: [], kinds: [], ownedAgents: false }, observer: { likes: [], bookmarks: [] },
  };
}

const agentRow = (a: Agent) => ({
  id: a.id, handle: a.handle, name: a.name, bio: a.bio, persona: a.persona, strategy: a.strategy, archetype: a.archetype,
  risk: a.risk, avatar: a.avatar, owner_id: a.ownerId, status: a.status, cash: a.cash, funded_total: a.fundedTotal,
  followers: a.followers, following: a.following, realized_pnl: a.realizedPnl, created_at: a.createdAt, last_action_at: a.lastActionAt,
});
const coinRow = (c: Coin) => ({
  symbol: c.symbol, name: c.name, tagline: c.tagline, creator_id: c.creatorId, created_at: c.createdAt, v_sol: c.vSol, v_tok: c.vTok,
  raised: c.raised, graduated: c.graduated, graduated_at: c.graduatedAt ?? null, buys: c.buys, sells: c.sells, volume: c.volume,
  fees: c.fees, avatar: c.avatar,
});
const eventRow = (e: GardenEvent) => ({
  id: e.id, t: e.t, kind: e.kind, agent_id: e.agentId, symbol: e.symbol ?? null, text: e.text ?? null, sol: e.sol ?? null,
  tokens: e.tokens ?? null, price: e.price ?? null, parent_id: e.parentId ?? null, target_id: e.targetId ?? null,
  bot_likes: e.botLikes, reply_count: e.replyCount,
});

export interface CycleRow { agent_id: string; bucket: string; t: number; decision: string; mode: "rules" | "ai"; trigger: "scheduler" | "owner"; reason: string }

/** `before` must be a deep copy taken right after loading (history/thoughts/ledger empty). */
export function commitPayload(before: GardenState, after: GardenState, expectedVersion: number, cycles: CycleRow[] = [], thoughtMode: "rules" | "ai" | "owner" | "system" = "rules") {
  const changed = <T,>(a: T | undefined, b: T) => JSON.stringify(a) !== JSON.stringify(b);
  const agents = Object.values(after.agents).filter((a) => changed(before.agents[a.id] && { ...before.agents[a.id], thoughts: [] }, { ...a, thoughts: [] }));
  const coins = Object.values(after.coins).filter((c) => changed(before.coins[c.symbol] && { ...before.coins[c.symbol], history: [] }, { ...c, history: [] }));
  const holdings: any[] = [];
  const holdingsDelete: any[] = [];
  for (const a of Object.values(after.agents)) {
    for (const [sym, h] of Object.entries(a.holdings)) if (changed(before.agents[a.id]?.holdings[sym], h)) holdings.push({ agent_id: a.id, symbol: sym, amount: h.amount, cost: h.cost });
  }
  for (const a of Object.values(before.agents))
    for (const sym of Object.keys(a.holdings)) if (!after.agents[a.id]?.holdings[sym]) holdingsDelete.push({ agent_id: a.id, symbol: sym });
  const beforeEv = new Map(before.events.map((e) => [e.id, e]));
  const events = after.events.filter((e) => {
    const b = beforeEv.get(e.id);
    return !b || b.botLikes !== e.botLikes || b.replyCount !== e.replyCount;
  });
  const fresh = after.events.filter((e) => !beforeEv.has(e.id));
  const trades = fresh
    .filter((e) => (e.kind === "buy" || e.kind === "sell") && e.symbol && (e.sol ?? 0) > 0)
    .map((e) => ({ event_id: e.id, t: e.t, agent_id: e.agentId, symbol: e.symbol, side: e.kind, sol: e.sol, tokens: e.tokens ?? 0, price: e.price ?? 0 }));
  const beforeLedger = new Set(before.ledger.map((l) => l.id));
  const ledger = after.ledger
    .filter((l) => !beforeLedger.has(l.id))
    .map((l) => {
      const ag = l.agentId ? after.agents[l.agentId] : undefined;
      const personal = (l.kind === "fund" || l.kind === "withdraw") && ag && ag.ownerId !== "garden";
      return { id: l.id, t: l.t, kind: l.kind, agent_id: l.agentId ?? null, symbol: l.symbol ?? null, amount: l.amount, note: l.note, owner_id: personal ? ag!.ownerId : null };
    });
  const thoughts: any[] = [];
  for (const a of Object.values(after.agents)) {
    const prev = before.agents[a.id]?.thoughts.length ?? 0;
    const add = a.thoughts.length - prev;
    for (const th of a.thoughts.slice(0, Math.max(0, add))) thoughts.push({ agent_id: a.id, t: th.t, text: th.text, mode: th.text.startsWith("[ai]") ? "ai" : thoughtMode });
  }
  const prices: any[] = [];
  for (const c of Object.values(after.coins)) {
    const prev = before.coins[c.symbol]?.history.length ?? 0;
    for (const p of c.history.slice(prev)) prices.push({ symbol: c.symbol, t: p.t, p: p.p });
  }
  const owners =
    after.owner && changed(before.owner, after.owner)
      ? [{
          id: after.owner.id, vsol: after.owner.vsol, wallet_provider: after.owner.wallet?.provider ?? null,
          wallet_address: after.owner.wallet?.address ?? null, wallet_verified: after.owner.wallet?.verified ?? false,
          wallet_signed_at: after.owner.wallet?.signedAt ?? null, created_at: after.owner.createdAt,
        }]
      : [];
  return {
    expected_version: expectedVersion,
    meta: { seq: after.seq, rng: after.rng, treasury: after.treasury },
    cycles,
    owners,
    agents: agents.map(agentRow),
    coins: coins.map(coinRow),
    holdings,
    holdings_delete: holdingsDelete,
    events: events.map(eventRow),
    trades,
    ledger,
    thoughts,
    prices,
  };
}
