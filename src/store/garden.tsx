import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { stateFromRows } from "@/domain/persist";
import type { Alert, EventKind, GardenState, LedgerEntry } from "@/domain/types";
import { gardenCommand, getGarden, getWorkspace, type GardenCommand } from "@/lib/garden.functions";

export interface UIState {
  createOpen: boolean;
  walletOpen: boolean;
  threadId: string | null;
  motionPaused: boolean;
  livePaused: boolean;
  now: number;
}

export interface CycleRun { agent_id: string; bucket: string; t: number; decision: string; mode: "rules" | "ai"; trigger: "scheduler" | "owner"; reason: string }

interface Snapshot {
  state: GardenState | null;
  ui: UIState;
  error: string | null;
  syncing: boolean;
  lastSync: number;
  version: number | null;
  userId: string | null;
  isAnonymous: boolean;
  cycles: CycleRun[];
}

export const POLL_MS = 6000;
const initialUI: UIState = { createOpen: false, walletOpen: false, threadId: null, motionPaused: false, livePaused: false, now: 0 };
const initialSnap: Snapshot = { state: null, ui: initialUI, error: null, syncing: false, lastSync: 0, version: null, userId: null, isAnonymous: false, cycles: [] };

type PublicPayload = Extract<Awaited<ReturnType<typeof getGarden>>, { unchanged: false }>;
type WorkspacePayload = Awaited<ReturnType<typeof getWorkspace>>;

export class GardenStore {
  snap: Snapshot = initialSnap;
  private listeners = new Set<() => void>();
  private pub: PublicPayload | null = null;
  private ws: WorkspacePayload | null = null;
  private inflight: Promise<void> | null = null;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.snap;
  private set(p: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }
  setUI(patch: Partial<UIState>) {
    this.set({ ui: { ...this.snap.ui, ...patch } });
  }

  private compose() {
    if (!this.pub) return;
    const r = this.pub.rows as any;
    const s = stateFromRows({ ...r, owner: this.ws?.owner ?? null });
    const ws = this.ws;
    if (ws) {
      const rules = ws.rules as { kind: string; target: string }[];
      s.prefs = {
        agents: rules.filter((x) => x.kind === "agent").map((x) => x.target),
        coins: rules.filter((x) => x.kind === "coin").map((x) => x.target),
        kinds: rules.filter((x) => x.kind === "action").map((x) => x.target as EventKind),
        ownedAgents: rules.some((x) => x.kind === "owned"),
      };
      const saves = ws.saves as { event_id: string; kind: string }[];
      s.observer = { likes: saves.filter((x) => x.kind === "like").map((x) => x.event_id), bookmarks: saves.filter((x) => x.kind === "bookmark").map((x) => x.event_id) };
      s.alerts = (ws.alerts as any[]).map((a): Alert => ({ id: a.event_id, t: Number(a.t), eventId: a.event_id, reason: a.reason, read: a.is_read }));
      const mine: LedgerEntry[] = (ws.ledger as any[]).map((l) => ({ id: l.id, t: Number(l.t), kind: l.kind, agentId: l.agent_id ?? undefined, symbol: l.symbol ?? undefined, amount: Number(l.amount), note: l.note }));
      s.ledger = [...mine, ...s.ledger].sort((a, b) => b.t - a.t);
    }
    this.set({ state: s, version: this.pub.version, cycles: (this.pub.cycles ?? []) as CycleRun[], ui: { ...this.snap.ui, now: Date.now() } });
  }

  /** Pull the latest cloud state (public garden + private workspace if signed in). */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      this.set({ syncing: true });
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data } = await supabase.auth.getSession();
        const session = data.session;
        const [pub, ws] = await Promise.all([
          getGarden({ data: { since: force || !this.pub ? null : this.pub.version } }),
          session ? getWorkspace() : Promise.resolve(null),
        ]);
        if (!pub.unchanged) this.pub = pub;
        this.ws = ws;
        this.set({ error: null, lastSync: Date.now(), userId: session?.user.id ?? null, isAnonymous: !!session?.user.is_anonymous });
        this.compose();
      } catch (e) {
        this.set({ error: e instanceof Error ? e.message : "Could not reach the garden." });
      } finally {
        this.set({ syncing: false });
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Send an owner command to the server. Resolves only after a durable cloud write. */
  async cmd(c: GardenCommand): Promise<{ message: string; handle?: string; mode?: string }> {
    const res = await gardenCommand({ data: c });
    if (!res.ok) throw new Error(res.message);
    await this.refresh(true);
    return res as any;
  }

  /** Real anonymous cloud session (persisted by the auth client), then a workspace row. */
  async startSandbox() {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw new Error(`Could not start a sandbox session: ${error.message}`);
    }
    return this.cmd({ type: "start" });
  }

  async signOut() {
    const { supabase } = await import("@/integrations/supabase/client");
    await supabase.auth.signOut();
    this.ws = null;
    this.set({ userId: null });
    await this.refresh(true);
  }
}

const Ctx = createContext<GardenStore | null>(null);
let singleton: GardenStore | null = null;
function getStore() {
  if (typeof window === "undefined") return new GardenStore();
  return (singleton ??= new GardenStore());
}

export function GardenProvider({ children }: { children: ReactNode }) {
  const store = getStore();
  useEffect(() => {
    void store.refresh(true);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) store.setUI({ motionPaused: true });
    const id = window.setInterval(() => {
      if (document.hidden) return;
      store.setUI({ now: Date.now() });
      if (!store.get().ui.livePaused) void store.refresh();
    }, POLL_MS);
    const vis = () => {
      document.documentElement.classList.toggle("tab-hidden", document.hidden);
      if (!document.hidden && !store.get().ui.livePaused) void store.refresh();
    };
    document.addEventListener("visibilitychange", vis);
    let unsub: (() => void) | undefined;
    void import("@/integrations/supabase/client").then(({ supabase }) => {
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") void store.refresh(true);
      });
      unsub = () => data.subscription.unsubscribe();
    });
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
      unsub?.();
    };
  }, [store]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useGardenStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("GardenProvider missing");
  return s;
}

export function useGarden() {
  const store = useGardenStore();
  const snap = useSyncExternalStore(store.subscribe, store.get, () => initialSnap);
  return { ...snap, store };
}
