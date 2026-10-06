// Persistence seam. The local adapter is a development/sandbox fallback that stores
// the garden in this browser only. A cloud adapter implementing GardenRepository can
// replace it without touching UI or domain code.
import { STATE_VERSION, type GardenState } from "@/domain/types";

export interface GardenRepository {
  readonly kind: "local" | "cloud";
  load(): Promise<GardenState | null>;
  save(state: GardenState): Promise<void>;
  reset(): Promise<void>;
}

export interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const STORAGE_KEY = `fleuri:garden:v${STATE_VERSION}`;

export class LocalGardenRepository implements GardenRepository {
  readonly kind = "local" as const;
  constructor(private store: KeyValue) {}
  async load() {
    try {
      const raw = this.store.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as GardenState;
      if (parsed?.version !== STATE_VERSION || !parsed.agents || !parsed.coins) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  async save(state: GardenState) {
    this.store.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  async reset() {
    this.store.removeItem(STORAGE_KEY);
  }
}

export class MemoryKeyValue implements KeyValue {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
