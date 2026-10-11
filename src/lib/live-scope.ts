// Scope fence for async UI work: a token captured before an await is only "live" if the component is
// still mounted and the scope key (owner / receipt / RPC / operation) is unchanged.
import { useEffect, useMemo, useRef } from "react";

export function createScope(initial: string) {
  let key = initial, gen = 0, alive = true;
  return {
    set(k: string) { if (k !== key) { key = k; gen++; } },
    token: () => ({ key, gen }),
    live: (t: { key: string; gen: number }) => alive && t.key === key && t.gen === gen,
    bump() { gen++; },
    end() { alive = false; gen++; },
    start() { alive = true; },
  };
}
export type Scope = ReturnType<typeof createScope>;

export function useLiveScope(key: string): Scope {
  const ref = useRef<Scope | null>(null);
  if (!ref.current) ref.current = createScope(key);
  ref.current.set(key);
  useEffect(() => { const s = ref.current!; s.start(); return () => s.end(); }, []);
  return useMemo(() => ref.current!, []);
}
