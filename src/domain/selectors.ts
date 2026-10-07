import { GRADUATION_VSOL, SUPPLY, graduationProgress, marketCap, price } from "./curve";
import { agentValue } from "./engine";
import type { Agent, Coin, GardenState } from "./types";

const H = 3600_000;

export function coinStats(s: GardenState, c: Coin, now: number) {
  const p = price(c.vSol, c.vTok);
  const cap = marketCap(c.vSol, c.vTok);
  const dayAgo = now - 24 * H;
  const past = [...c.history].reverse().find((x) => x.t <= dayAgo) ?? c.history[0];
  const change24 = past ? (p - past.p) / past.p : 0;
  const holders = Object.entries(c.holders).filter(([, v]) => v > 0);
  const sorted = holders.map(([, v]) => v).sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10).reduce((x, y) => x + y, 0) / SUPPLY;
  const creatorPct = (c.holders[c.creatorId] ?? 0) / SUPPLY;
  const trades = s.events.filter((e) => e.symbol === c.symbol && (e.kind === "buy" || e.kind === "sell"));
  const recent = trades.filter((e) => e.t >= dayAgo);
  const vol24 = recent.reduce((x, e) => x + (e.sol ?? 0), 0);
  const lastTrade = trades[0]?.t ?? c.createdAt;
  return {
    price: p,
    cap,
    change24,
    holders: holders.length,
    top10,
    creatorPct,
    vol24,
    trades24: recent.length,
    lastTrade,
    progress: graduationProgress(c.raised),
    toGraduate: Math.max(0, GRADUATION_VSOL - c.raised),
  };
}

export type CoinSort = "active" | "new" | "top" | "volume";
export function sortCoins(s: GardenState, sort: CoinSort, now: number) {
  const list = Object.values(s.coins).map((c) => ({ c, st: coinStats(s, c, now) }));
  const by: Record<CoinSort, (x: (typeof list)[number]) => number> = {
    active: (x) => x.st.lastTrade,
    new: (x) => x.c.createdAt,
    top: (x) => x.st.cap,
    volume: (x) => x.st.vol24,
  };
  return list.sort((a, b) => by[sort](b) - by[sort](a));
}

export function agentStats(s: GardenState, a: Agent) {
  const value = agentValue(s, a);
  const pnl = value - a.fundedTotal;
  const posts = s.events.filter((e) => e.agentId === a.id);
  return {
    value,
    pnl,
    pnlPct: a.fundedTotal > 0 ? pnl / a.fundedTotal : 0,
    actions: posts.length,
    coinsLaunched: Object.values(s.coins).filter((c) => c.creatorId === a.id).length,
  };
}

export type AgentSort = "active" | "influence" | "profit" | "new";
export function sortAgents(s: GardenState, sort: AgentSort) {
  const list = Object.values(s.agents).filter((a) => a.status !== "archived");
  const by: Record<AgentSort, (a: Agent) => number> = {
    active: (a) => a.lastActionAt,
    influence: (a) => a.followers,
    profit: (a) => agentValue(s, a) - a.fundedTotal,
    new: (a) => a.createdAt,
  };
  return list.sort((a, b) => by[sort](b) - by[sort](a));
}

export function ecosystemStats(s: GardenState, now: number) {
  const dayAgo = now - 24 * H;
  const vol = s.events.filter((e) => (e.kind === "buy" || e.kind === "sell") && e.t >= dayAgo).reduce((x, e) => x + (e.sol ?? 0), 0);
  return {
    agents: Object.values(s.agents).filter((a) => a.status !== "archived").length,
    coins: Object.keys(s.coins).length,
    vol24: vol,
    fees: Object.values(s.coins).reduce((x, c) => x + c.fees, 0),
  };
}

export function agentByHandle(s: GardenState, handle: string) {
  return Object.values(s.agents).find((a) => a.handle === handle.toLowerCase());
}
