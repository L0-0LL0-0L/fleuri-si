import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { tick } from "@/domain/engine";
import { buildSeed } from "@/domain/seed";
import { DomainError, type GardenState } from "@/domain/types";
import { LocalGardenRepository, type GardenRepository } from "@/services/repository";

export interface UIState {
  createOpen: boolean;
  walletOpen: boolean;
  threadId: string | null;
  motionPaused: boolean;
  livePaused: boolean;
  now: number;
}

interface Snapshot {
  state: GardenState | null;
  ui: UIState;
  error: string | null;
}

export const TICK_MS = 3500;

export class GardenStore {
  snap: Snapshot = {
    state: null,
    ui: { createOpen: false, walletOpen: false, threadId: null, motionPaused: false, livePaused: false, now: 0 },
    error: null,
  };
  private listeners = new Set<() => void>();
  constructor(public repo: GardenRepository | null) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.snap;
  private emit() {
    this.listeners.forEach((l) => l());
  }

  async init() {
    if (!this.repo) return;
    try {
      const loaded = await this.repo.load();
      const state = loaded ?? buildSeed(Date.now());
      if (!loaded) await this.repo.save(state);
      this.snap = { ...this.snap, state, ui: { ...this.snap.ui, now: Date.now() } };
    } catch (e) {
      this.snap = { ...this.snap, error: e instanceof Error ? e.message : "Could not load the garden." };
    }
    this.emit();
  }

  /** Apply a domain operation on a cloned draft; persists before resolving. */
  async act<T>(fn: (draft: GardenState) => T): Promise<T> {
    const cur = this.snap.state;
    if (!cur) throw new DomainError("The garden is still loading.");
    const draft = structuredClone(cur);
    const result = fn(draft);
    if (this.repo) await this.repo.save(draft);
    this.snap = { ...this.snap, state: draft, ui: { ...this.snap.ui, now: Date.now() } };
    this.emit();
    return result;
  }

  setUI(patch: Partial<UIState>) {
    this.snap = { ...this.snap, ui: { ...this.snap.ui, ...patch } };
    this.emit();
  }

  async reset() {
    await this.repo?.reset();
    const state = buildSeed(Date.now());
    await this.repo?.save(state);
    this.snap = { ...this.snap, state };
    this.emit();
  }
}

const Ctx = createContext<GardenStore | null>(null);

let singleton: GardenStore | null = null;
function getStore() {
  if (typeof window === "undefined") return new GardenStore(null);
  if (!singleton) singleton = new GardenStore(new LocalGardenRepository(window.localStorage));
  return singleton;
}

export function GardenProvider({ children }: { children: ReactNode }) {
  const store = getStore();
  useEffect(() => {
    void store.init();
    let motionFromPref = false;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      motionFromPref = true;
      store.setUI({ motionPaused: true });
    }
    const id = window.setInterval(() => {
      const { state, ui } = store.get();
      if (!state || document.hidden) return;
      if (ui.livePaused) {
        store.setUI({ now: Date.now() });
        return;
      }
      void store.act((d) => tick(d, Date.now())).catch(() => undefined);
    }, TICK_MS);
    const vis = () => document.documentElement.classList.toggle("tab-hidden", document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
      void motionFromPref;
    };
  }, [store]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

const serverSnap: Snapshot = {
  state: null,
  ui: { createOpen: false, walletOpen: false, threadId: null, motionPaused: false, livePaused: false, now: 0 },
  error: null,
};

export function useGardenStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("GardenProvider missing");
  return s;
}

export function useGarden() {
  const store = useGardenStore();
  const snap = useSyncExternalStore(store.subscribe, store.get, () => serverSnap);
  return { ...snap, store };
}
