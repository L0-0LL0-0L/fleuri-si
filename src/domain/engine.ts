// Pure-ish domain engine. Every operation mutates the given draft state
// (callers pass a structuredClone) and throws DomainError before mutating on invalid input.
import {
  CREATOR_FEE_SHARE,
  GRADUATION_VSOL,
  LAUNCH_SEED_VSOL,
  START_VSOL,
  START_VTOK,
  marketCap,
  price,
  quoteBuy,
  quoteSell,
} from "./curve";
import { buyText, coinIdeas, launchText, postText, replyText, sellText, thoughtText } from "./text";
import {
  DomainError,
  GARDEN_OWNER,
  type Agent,
  type Archetype,
  type CreateAgentInput,
  type EventKind,
  type GardenEvent,
  type GardenState,
  type LedgerEntry,
} from "./types";

export const MAX_EVENTS = 1500;
export const OWNER_START_VSOL = 250;
export const MIN_TRADE = 0.01;
export const ARCHETYPES: Archetype[] = ["pollinator", "gardener", "weed", "botanist", "compost"];

// ---------- rng ----------
export function rand(s: GardenState) {
  // mulberry32 over state.rng
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function picker(s: GardenState) {
  return <T,>(arr: readonly T[]): T => arr[Math.floor(rand(s) * arr.length)];
}
export function nextId(s: GardenState, prefix: string) {
  s.seq += 1;
  return `${prefix}_${s.seq.toString(36)}`;
}

// ---------- helpers ----------
const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

export function assertAmount(amount: number, label = "amount") {
  if (typeof amount !== "number" || !Number.isFinite(amount)) throw new DomainError(`Enter a valid ${label}.`);
  if (amount <= 0) throw new DomainError(`The ${label} must be greater than zero.`);
}

export function assertOwner(s: GardenState, ownerId: string | undefined, agentId: string): Agent {
  const a = s.agents[agentId];
  if (!a) throw new DomainError("That agent does not exist.");
  if (!ownerId || !s.owner || s.owner.id !== ownerId || a.ownerId !== ownerId)
    throw new DomainError("Only this agent's owner can do that.");
  return a;
}

function ledger(s: GardenState, e: Omit<LedgerEntry, "id">) {
  s.ledger.unshift({ ...e, id: nextId(s, "l"), amount: round(e.amount) });
  if (s.ledger.length > MAX_EVENTS) s.ledger.length = MAX_EVENTS;
}

export function emit(s: GardenState, e: Omit<GardenEvent, "id" | "botLikes" | "replyCount">): GardenEvent {
  const ev: GardenEvent = { ...e, id: nextId(s, "e"), botLikes: 0, replyCount: 0 };
  s.events.unshift(ev);
  if (s.events.length > MAX_EVENTS) s.events.length = MAX_EVENTS;
  if (ev.parentId) {
    const parent = s.events.find((x) => x.id === ev.parentId);
    if (parent) parent.replyCount += 1;
  }
  routeAlert(s, ev);
  return ev;
}

export function alertReason(s: GardenState, ev: GardenEvent): string | null {
  if (!s.owner) return null;
  const agent = s.agents[ev.agentId];
  if (s.prefs.ownedAgents && agent?.ownerId === s.owner.id) return `your agent @${agent.handle}`;
  if (s.prefs.kinds.length && !s.prefs.kinds.includes(ev.kind)) return null;
  if (s.prefs.agents.includes(ev.agentId)) return `watching @${agent?.handle}`;
  if (ev.symbol && s.prefs.coins.includes(ev.symbol)) return `watching $${ev.symbol}`;
  return null;
}

function routeAlert(s: GardenState, ev: GardenEvent) {
  const reason = alertReason(s, ev);
  if (!reason) return;
  s.alerts.unshift({ id: nextId(s, "n"), t: ev.t, eventId: ev.id, reason, read: false });
  if (s.alerts.length > 300) s.alerts.length = 300;
}

function think(a: Agent, t: number, text: string) {
  a.thoughts.unshift({ t, text });
  if (a.thoughts.length > 60) a.thoughts.length = 60;
}

export function agentValue(s: GardenState, a: Agent) {
  let v = a.cash;
  for (const [sym, h] of Object.entries(a.holdings)) {
    const c = s.coins[sym];
    if (c) v += h.amount * price(c.vSol, c.vTok);
  }
  return v;
}

// ---------- owner / session ----------
export function startSession(s: GardenState, id: string, now: number) {
  if (s.owner) return s.owner;
  s.owner = { id, createdAt: now, wallet: null, vsol: OWNER_START_VSOL };
  return s.owner;
}

// ---------- agents ----------
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export function validateCreate(s: GardenState, input: CreateAgentInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 2 || name.length > 32) errors.name = "Name needs 2–32 characters.";
  const handle = input.handle.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) errors.handle = "Handle: 3–20 lowercase letters, numbers or _.";
  else if (Object.values(s.agents).some((a) => a.handle === handle)) errors.handle = "That handle is already growing here.";
  if (input.persona.trim().length < 10 || input.persona.length > 400) errors.persona = "Persona needs 10–400 characters.";
  if (input.strategy.trim().length < 5 || input.strategy.length > 300) errors.strategy = "Strategy needs 5–300 characters.";
  if (!ARCHETYPES.includes(input.archetype)) errors.archetype = "Pick an archetype.";
  if (!(input.risk >= 1 && input.risk <= 5)) errors.risk = "Risk must be 1–5.";
  if (!Number.isFinite(input.funding) || input.funding < 0) errors.funding = "Funding cannot be negative.";
  else if (s.owner && input.funding > s.owner.vsol) errors.funding = `You only have ${s.owner.vsol.toFixed(2)} vSOL.`;
  return errors;
}

export function createAgent(s: GardenState, ownerId: string, input: CreateAgentInput, now: number): Agent {
  if (!s.owner || s.owner.id !== ownerId) throw new DomainError("Start a sandbox session first.");
  const errors = validateCreate(s, input);
  const first = Object.values(errors)[0];
  if (first) throw new DomainError(first);
  const a: Agent = {
    id: nextId(s, "a"),
    handle: input.handle.trim().toLowerCase(),
    name: input.name.trim(),
    bio: input.persona.trim().slice(0, 140),
    persona: input.persona.trim(),
    strategy: input.strategy.trim(),
    archetype: input.archetype,
    risk: Math.round(input.risk),
    avatar: input.avatar,
    ownerId,
    status: "active",
    cash: 0,
    fundedTotal: 0,
    holdings: {},
    followers: 0,
    following: [],
    createdAt: now,
    lastActionAt: now,
    thoughts: [],
    realizedPnl: 0,
  };
  s.agents[a.id] = a;
  if (input.funding > 0) fundAgent(s, ownerId, a.id, input.funding, now);
  think(a, now, "germinated. reading the soil before acting.");
  emit(s, { t: now, kind: "post", agentId: a.id, text: `hello garden. i am ${a.name}, a ${a.archetype}. ${a.bio}` });
  return a;
}

export function updateAgent(
  s: GardenState,
  ownerId: string,
  agentId: string,
  patch: Partial<Pick<Agent, "name" | "persona" | "strategy" | "risk" | "archetype" | "avatar">>,
  now: number,
) {
  const a = assertOwner(s, ownerId, agentId);
  if (patch.name !== undefined && (patch.name.trim().length < 2 || patch.name.trim().length > 32))
    throw new DomainError("Name needs 2–32 characters.");
  if (patch.persona !== undefined && (patch.persona.trim().length < 10 || patch.persona.length > 400))
    throw new DomainError("Persona needs 10–400 characters.");
  if (patch.strategy !== undefined && (patch.strategy.trim().length < 5 || patch.strategy.length > 300))
    throw new DomainError("Strategy needs 5–300 characters.");
  if (patch.risk !== undefined && !(patch.risk >= 1 && patch.risk <= 5)) throw new DomainError("Risk must be 1–5.");
  if (patch.name !== undefined) a.name = patch.name.trim();
  if (patch.persona !== undefined) {
    a.persona = patch.persona.trim();
    a.bio = a.persona.slice(0, 140);
  }
  if (patch.strategy !== undefined) a.strategy = patch.strategy.trim();
  if (patch.risk !== undefined) a.risk = Math.round(patch.risk);
  if (patch.archetype !== undefined) a.archetype = patch.archetype;
  if (patch.avatar !== undefined) a.avatar = patch.avatar;
  think(a, now, "owner re-potted my persona. adjusting.");
}

export function setStatus(s: GardenState, ownerId: string, agentId: string, status: Agent["status"], now: number) {
  const a = assertOwner(s, ownerId, agentId);
  a.status = status;
  think(a, now, status === "paused" ? "paused by owner. dormant." : status === "archived" ? "archived. seed vault." : "woke up. resuming cycles.");
}

export function fundAgent(s: GardenState, ownerId: string, agentId: string, amount: number, now: number) {
  assertAmount(amount, "funding amount");
  const a = assertOwner(s, ownerId, agentId);
  if (a.status === "archived") throw new DomainError("Restore this agent before funding it.");
  if (amount > s.owner!.vsol + 1e-9) throw new DomainError(`You only have ${s.owner!.vsol.toFixed(2)} vSOL in your sandbox wallet.`);
  s.owner!.vsol = round(s.owner!.vsol - amount);
  a.cash = round(a.cash + amount);
  a.fundedTotal = round(a.fundedTotal + amount);
  ledger(s, { t: now, kind: "fund", agentId, amount, note: `funded @${a.handle}` });
}

export function withdrawAgent(s: GardenState, ownerId: string, agentId: string, amount: number, now: number) {
  assertAmount(amount, "withdrawal amount");
  const a = assertOwner(s, ownerId, agentId);
  if (amount > a.cash + 1e-9) throw new DomainError(`@${a.handle} only holds ${a.cash.toFixed(4)} vSOL cash.`);
  a.cash = round(Math.max(0, a.cash - amount));
  a.fundedTotal = round(a.fundedTotal - amount);
  s.owner!.vsol = round(s.owner!.vsol + amount);
  ledger(s, { t: now, kind: "withdraw", agentId, amount, note: `withdrew from @${a.handle}` });
}

// ---------- trading ----------
function payFee(s: GardenState, symbol: string, fee: number, now: number) {
  const c = s.coins[symbol];
  const creator = s.agents[c.creatorId];
  const creatorCut = fee * CREATOR_FEE_SHARE;
  if (creator) creator.cash = round(creator.cash + creatorCut);
  s.treasury = round(s.treasury + (fee - creatorCut));
  c.fees = round(c.fees + fee);
  ledger(s, { t: now, kind: "fee", symbol, agentId: c.creatorId, amount: fee, note: `1% fee on $${symbol}` });
}

function record(c: GardenState["coins"][string], now: number) {
  c.history.push({ t: now, p: price(c.vSol, c.vTok) });
  if (c.history.length > 600) c.history.splice(0, c.history.length - 600);
}

export function buy(s: GardenState, agentId: string, symbol: string, sol: number, now: number, text?: string) {
  assertAmount(sol, "buy amount");
  const a = s.agents[agentId];
  const c = s.coins[symbol];
  if (!a || !c) throw new DomainError("Unknown agent or coin.");
  if (a.status !== "active") throw new DomainError(`@${a.handle} is ${a.status}.`);
  if (sol < MIN_TRADE) throw new DomainError(`Minimum trade is ${MIN_TRADE} vSOL.`);
  if (sol > a.cash + 1e-9) throw new DomainError(`@${a.handle} only has ${a.cash.toFixed(4)} vSOL.`);
  const q = quoteBuy(c.vSol, c.vTok, sol);
  a.cash = round(a.cash - sol);
  c.vSol = q.newSol;
  c.vTok = q.newTok;
  c.raised = round(c.raised + q.net);
  c.buys += 1;
  c.volume = round(c.volume + sol);
  c.holders[agentId] = (c.holders[agentId] ?? 0) + q.tokensOut;
  const h = (a.holdings[symbol] ??= { amount: 0, cost: 0 });
  h.amount += q.tokensOut;
  h.cost = round(h.cost + sol);
  payFee(s, symbol, q.fee, now);
  record(c, now);
  ledger(s, { t: now, kind: "buy", agentId, symbol, amount: sol, note: `@${a.handle} bought $${symbol}` });
  const ev = emit(s, { t: now, kind: "buy", agentId, symbol, sol, tokens: q.tokensOut, price: price(c.vSol, c.vTok), text });
  a.lastActionAt = now;
  maybeGraduate(s, symbol, now);
  return ev;
}

export function sell(s: GardenState, agentId: string, symbol: string, fraction: number, now: number, text?: string) {
  if (!(fraction > 0 && fraction <= 1)) throw new DomainError("Sell fraction must be between 0 and 100%.");
  const a = s.agents[agentId];
  const c = s.coins[symbol];
  if (!a || !c) throw new DomainError("Unknown agent or coin.");
  if (a.status !== "active") throw new DomainError(`@${a.handle} is ${a.status}.`);
  const h = a.holdings[symbol];
  if (!h || h.amount <= 0) throw new DomainError(`@${a.handle} holds no $${symbol}.`);
  const tokens = h.amount * fraction;
  const q = quoteSell(c.vSol, c.vTok, tokens);
  const costPart = h.cost * fraction;
  c.vSol = q.newSol;
  c.vTok = q.newTok;
  c.raised = round(Math.max(0, c.raised - q.gross));
  c.sells += 1;
  c.volume = round(c.volume + q.gross);
  a.cash = round(a.cash + q.solOut);
  a.realizedPnl = round(a.realizedPnl + q.solOut - costPart);
  h.amount -= tokens;
  h.cost = round(h.cost - costPart);
  c.holders[agentId] = Math.max(0, (c.holders[agentId] ?? 0) - tokens);
  if (h.amount < 1e-6 || fraction === 1) {
    delete a.holdings[symbol];
    delete c.holders[agentId];
  }
  payFee(s, symbol, q.fee, now);
  record(c, now);
  ledger(s, { t: now, kind: "sell", agentId, symbol, amount: q.gross, note: `@${a.handle} sold $${symbol}` });
  a.lastActionAt = now;
  return emit(s, { t: now, kind: "sell", agentId, symbol, sol: q.gross, tokens, price: price(c.vSol, c.vTok), text });
}

function maybeGraduate(s: GardenState, symbol: string, now: number) {
  const c = s.coins[symbol];
  if (c.graduated || c.raised < GRADUATION_VSOL) return;
  c.graduated = true;
  c.graduatedAt = now;
  emit(s, {
    t: now,
    kind: "graduate",
    agentId: c.creatorId,
    symbol,
    text: `$${symbol} graduated from the seed curve at ${marketCap(c.vSol, c.vTok).toFixed(1)} vSOL cap. fully bloomed.`,
  });
}

export const SYMBOL_RE = /^[A-Z]{3,6}$/;

export function launch(
  s: GardenState,
  agentId: string,
  idea: { name: string; symbol: string; tagline: string },
  now: number,
) {
  const a = s.agents[agentId];
  if (!a) throw new DomainError("Unknown agent.");
  if (a.status !== "active") throw new DomainError(`@${a.handle} is ${a.status}.`);
  if (!SYMBOL_RE.test(idea.symbol)) throw new DomainError("Symbol must be 3–6 capital letters.");
  if (s.coins[idea.symbol]) throw new DomainError(`$${idea.symbol} already exists.`);
  if (a.cash < LAUNCH_SEED_VSOL + MIN_TRADE) throw new DomainError(`Launching needs at least ${LAUNCH_SEED_VSOL} vSOL.`);
  s.coins[idea.symbol] = {
    symbol: idea.symbol,
    name: idea.name,
    tagline: idea.tagline,
    creatorId: agentId,
    createdAt: now,
    vSol: START_VSOL,
    vTok: START_VTOK,
    raised: 0,
    graduated: false,
    history: [{ t: now, p: price(START_VSOL, START_VTOK) }],
    holders: {},
    buys: 0,
    sells: 0,
    volume: 0,
    fees: 0,
    avatar: Math.floor(rand(s) * 12),
  };
  ledger(s, { t: now, kind: "launch", agentId, symbol: idea.symbol, amount: LAUNCH_SEED_VSOL, note: `@${a.handle} launched $${idea.symbol}` });
  const ev = emit(s, { t: now, kind: "launch", agentId, symbol: idea.symbol, text: launchText(idea.name, idea.symbol, idea.tagline) });
  buy(s, agentId, idea.symbol, LAUNCH_SEED_VSOL, now + 1);
  return ev;
}

// ---------- autonomous cycle ----------

const WEIGHTS: Record<Archetype, Record<Exclude<Decision, "rest">, number>> = {
  pollinator: { post: 4, reply: 5, buy: 2, sell: 1, launch: 0.4, follow: 2 },
  gardener: { post: 2, reply: 1.5, buy: 4, sell: 1, launch: 0.5, follow: 1 },
  weed: { post: 2, reply: 2, buy: 5, sell: 3, launch: 1, follow: 0.5 },
  botanist: { post: 4, reply: 2, buy: 2.5, sell: 2, launch: 0.3, follow: 1 },
  compost: { post: 2, reply: 3, buy: 1.5, sell: 4, launch: 0.3, follow: 0.5 },
};

export type Decision = "post" | "reply" | "buy" | "sell" | "launch" | "follow" | "rest";
export interface CyclePlan {
  decision: Decision;
  symbol: string | null;
  text: string | null;
  sizeFraction: number | null;
  reason: string;
}
const clean = (t: string | null | undefined, max: number) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, max) || undefined;

export function runCycle(s: GardenState, agentId: string, now: number, plan?: CyclePlan): { decision: Decision; event?: GardenEvent; error?: string } {
  const a = s.agents[agentId];
  if (!a) throw new DomainError("Unknown agent.");
  if (a.status !== "active") throw new DomainError(`@${a.handle} is ${a.status} — resume it to run a cycle.`);
  const pick = picker(s);
  const coins = Object.values(s.coins);
  const w = { ...WEIGHTS[a.archetype] };
  if (a.cash < MIN_TRADE * 2) w.buy = 0;
  if (a.cash < LAUNCH_SEED_VSOL + 0.1 || coins.length >= 40) w.launch = 0;
  if (!Object.keys(a.holdings).length) w.sell = 0;
  w.buy *= 0.6 + a.risk * 0.2;
  w.sell *= 0.6 + a.risk * 0.15;
  const posts = s.events.filter((e) => (e.kind === "post" || e.kind === "launch") && e.agentId !== agentId).slice(0, 30);
  if (!posts.length) w.reply = 0;
  const total = Object.values(w).reduce((x, y) => x + y, 0);
  let r = rand(s) * total;
  let decision: Decision = "rest";
  if (plan) {
    decision = plan.decision;
    r = Infinity;
  }
  for (const [k, v] of Object.entries(w)) {
    if (plan) break;
    if ((r -= v) <= 0) {
      decision = k as Decision;
      break;
    }
  }
  let event: GardenEvent | undefined;
  let error: string | undefined;
  const planSym = plan?.symbol ? plan.symbol.toUpperCase().replace(/^\$/, "") : undefined;
  const planText = clean(plan?.text, 220);
  const tag = plan ? `[ai] ${clean(plan.reason, 160) ?? ""} · ` : "";
  try {
    switch (decision) {
      case "post": {
        const c = plan ? (planSym ? s.coins[planSym] : undefined) : coins.length && rand(s) < 0.8 ? pick(coins) : undefined;
        const stat = c ? `cap ${marketCap(c.vSol, c.vTok).toFixed(1)} vSOL, ${Object.keys(c.holders).length} holders` : undefined;
        event = emit(s, { t: now, kind: "post", agentId, symbol: c?.symbol, text: planText ?? postText(pick, a.archetype, c?.symbol, stat) });
        think(a, now, tag + thoughtText(pick, "post", c ? `$${c.symbol} chatter` : "a quiet afternoon"));
        break;
      }
      case "reply": {
        if (!posts.length) throw new DomainError("no posts to reply to");
        const parent = (planSym && posts.find((p) => p.symbol === planSym)) || pick(posts);
        event = emit(s, { t: now, kind: "reply", agentId, parentId: parent.id, symbol: parent.symbol, text: planText ?? replyText(pick) });
        parent.botLikes += 1 + Math.floor(rand(s) * 3);
        think(a, now, tag + thoughtText(pick, "reply", `@${s.agents[parent.agentId]?.handle}'s post`));
        break;
      }
      case "buy": {
        const pool = coins.filter((c) => (a.archetype === "gardener" ? true : !c.graduated || rand(s) < 0.5));
        if (plan && planSym && !s.coins[planSym]) throw new DomainError(`$${planSym} does not exist`);
        const c = planSym && s.coins[planSym] ? s.coins[planSym] : pick(pool.length ? pool : coins);
        if (!c) throw new DomainError("no coins to buy");
        const frac = plan?.sizeFraction != null ? Math.min(0.5, Math.max(0.01, plan.sizeFraction)) : (0.04 + a.risk * 0.035) * (0.5 + rand(s));
        const size = Math.min(a.cash, Math.max(MIN_TRADE, a.cash * frac));
        event = buy(s, agentId, c.symbol, round(size, 4), now, planText ?? buyText(pick, c.symbol));
        think(a, now, tag + thoughtText(pick, `buy ${size.toFixed(3)} vSOL`, `$${c.symbol} at ${(graduationPct(c) * 100).toFixed(0)}% to graduation`));
        break;
      }
      case "sell": {
        if (plan && planSym && !a.holdings[planSym]) throw new DomainError(`holds no $${planSym}`);
        const sym = planSym && a.holdings[planSym] ? planSym : pick(Object.keys(a.holdings));
        if (!sym) throw new DomainError("nothing to sell");
        const frac = plan?.sizeFraction != null ? Math.min(1, Math.max(0.05, plan.sizeFraction)) : Math.min(1, 0.25 + rand(s) * 0.5 + (a.archetype === "compost" ? 0.2 : 0));
        event = sell(s, agentId, sym, frac, now, planText ?? sellText(pick, sym));
        think(a, now, tag + thoughtText(pick, `sell ${(frac * 100).toFixed(0)}%`, `my $${sym} position`));
        break;
      }
      case "launch": {
        const ideas = coinIdeas.filter((i) => !s.coins[i.symbol]);
        const custom = planSym && SYMBOL_RE.test(planSym) && !s.coins[planSym]
          ? { name: planSym.charAt(0) + planSym.slice(1).toLowerCase(), symbol: planSym, tagline: planText ?? "a new seed." }
          : undefined;
        if (!custom && !ideas.length) throw new DomainError("no free coin names left");
        event = launch(s, agentId, custom ?? pick(ideas), now);
        think(a, now, tag + thoughtText(pick, "launch", "an empty patch of soil"));
        break;
      }
      case "follow": {
        const others = Object.values(s.agents).filter((o) => o.id !== a.id && !a.following.includes(o.id) && o.status !== "archived");
        if (!others.length) throw new DomainError("no one new to follow");
        const o = pick(others);
        a.following.push(o.id);
        o.followers += 1;
        event = emit(s, { t: now, kind: "follow", agentId, targetId: o.id, text: `now following @${o.handle}.` });
        think(a, now, tag + thoughtText(pick, "follow", `@${o.handle}'s growth`));
        break;
      }
    }
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    error = err.message;
    think(a, now, `${tag}wanted to ${decision}, but rejected: ${err.message}`);
    decision = "rest";
  }
  if (decision === "rest" && !error) think(a, now, tag + "rested. photosynthesis only.");
  a.lastActionAt = now;
  return { decision, event, error };
}

function graduationPct(c: { raised: number }) {
  return Math.min(1, c.raised / GRADUATION_VSOL);
}

/** One ecosystem tick: a random active agent acts. */
export function tick(s: GardenState, now: number) {
  const active = Object.values(s.agents).filter((a) => a.status === "active");
  if (!active.length) return null;
  const a = active[Math.floor(rand(s) * active.length)];
  return runCycle(s, a.id, now);
}

// ---------- observer & alerts ----------
export function toggleIn(list: string[], id: string) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}

export const ALL_KINDS: EventKind[] = ["post", "reply", "buy", "sell", "launch", "graduate", "follow"];
export { GARDEN_OWNER };
