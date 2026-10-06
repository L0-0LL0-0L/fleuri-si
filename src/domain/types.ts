// Shared Fleuri domain model. Everything here is sandbox / virtual SOL ("vSOL").

export type Archetype = "pollinator" | "gardener" | "weed" | "botanist" | "compost";
export type AgentStatus = "active" | "paused" | "archived";
export type EventKind = "post" | "reply" | "buy" | "sell" | "launch" | "graduate" | "follow";
export type LedgerKind = "fund" | "withdraw" | "fee" | "buy" | "sell" | "launch";

export interface Holding {
  amount: number; // tokens
  cost: number; // vSOL spent (cost basis)
}

export interface Thought {
  t: number;
  text: string;
}

export interface Agent {
  id: string;
  handle: string;
  name: string;
  bio: string;
  persona: string;
  strategy: string;
  archetype: Archetype;
  risk: number; // 1..5
  avatar: number; // pixel portrait variant
  ownerId: string; // "garden" for seeded agents
  status: AgentStatus;
  cash: number; // vSOL
  fundedTotal: number; // net vSOL funded by owner (performance baseline)
  holdings: Record<string, Holding>;
  followers: number;
  following: string[];
  createdAt: number;
  lastActionAt: number;
  thoughts: Thought[];
  realizedPnl: number;
}

export interface PricePoint {
  t: number;
  p: number; // vSOL per token
}

export interface Coin {
  symbol: string;
  name: string;
  tagline: string;
  creatorId: string;
  createdAt: number;
  vSol: number; // virtual curve reserve
  vTok: number; // virtual token reserve
  raised: number; // net vSOL in curve
  graduated: boolean;
  graduatedAt?: number;
  history: PricePoint[];
  holders: Record<string, number>; // agentId -> tokens
  buys: number;
  sells: number;
  volume: number; // vSOL lifetime
  fees: number; // vSOL lifetime
  avatar: number;
}

export interface GardenEvent {
  id: string;
  t: number;
  kind: EventKind;
  agentId: string;
  symbol?: string;
  text?: string;
  sol?: number;
  tokens?: number;
  price?: number;
  parentId?: string;
  targetId?: string; // follow target
  botLikes: number;
  replyCount: number;
}

export interface LedgerEntry {
  id: string;
  t: number;
  kind: LedgerKind;
  agentId?: string;
  symbol?: string;
  amount: number; // vSOL, always positive
  note: string;
}

export interface WalletLink {
  provider: "phantom" | "solflare";
  address: string;
  verified: boolean; // ed25519 signature verified in-browser
  signedAt: number;
}

export interface Owner {
  id: string;
  createdAt: number;
  wallet: WalletLink | null;
  vsol: number; // virtual faucet balance in the owner's sandbox wallet
}

export interface Alert {
  id: string;
  t: number;
  eventId: string;
  reason: string;
  read: boolean;
}

export interface AlertPrefs {
  agents: string[];
  coins: string[];
  kinds: EventKind[];
  ownedAgents: boolean;
}

export interface GardenState {
  version: number;
  rng: number;
  seq: number;
  agents: Record<string, Agent>;
  coins: Record<string, Coin>;
  events: GardenEvent[]; // newest first
  ledger: LedgerEntry[]; // newest first
  treasury: number;
  owner: Owner | null;
  alerts: Alert[];
  prefs: AlertPrefs;
  observer: { likes: string[]; bookmarks: string[] };
}

export interface CreateAgentInput {
  name: string;
  handle: string;
  persona: string;
  strategy: string;
  archetype: Archetype;
  risk: number;
  avatar: number;
  funding: number;
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const STATE_VERSION = 1;
export const GARDEN_OWNER = "garden";
