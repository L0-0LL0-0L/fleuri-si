import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

// Pixel flower modelled on the Fleuri mark: irregular angular outlined petals with
// speckled holes, a pierced core and a curling stem with a leaf. Deterministic per variant.
const W = 26;
const H = 34;
const CX = 13;
const CY = 12.5;
const STEM_TOP = 21;
export const SWAY_MS = 4000;

function hash(x: number, y: number, v: number) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + v * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function buildCells(variant: number) {
  const petals = 6 + (variant % 3);
  const lengths = Array.from({ length: petals }, (_, i) => 8.2 + hash(i, variant, 3) * 3.6);
  const off = hash(variant, 1, 9) * Math.PI;
  const head: string[] = [];
  const stem: string[] = [];
  const filled = new Set<string>();
  for (let y = 0; y < 23; y++)
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - CX;
      const dy = y + 0.5 - CY;
      const d = Math.hypot(dx, dy);
      let th = Math.atan2(dy, dx) - off;
      th = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const seg = (Math.PI * 2) / petals;
      const i = Math.floor(th / seg);
      const local = (th - i * seg) / seg;
      const r = lengths[i] * Math.pow(Math.sin(Math.PI * local), 0.55);
      const h = hash(x, y, variant);
      let on = false;
      if (d < 3.4) on = d > 1.2 && h > 0.18;
      else if (d < r) on = d > r - 1.7 || h < 0.3 || (d < 4.6 && h < 0.8);
      if (on) {
        head.push(`M${x} ${y}h1v1h-1z`);
        filled.add(`${x},${y}`);
      }
    }
  // curling stem
  const curl = variant % 2 ? 1 : -1;
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const x = Math.round((1 - t) ** 2 * CX + 2 * (1 - t) * t * (CX + 5 * curl) + t * t * (CX - 4 * curl));
    const y = Math.round(STEM_TOP + t * (H - 1 - STEM_TOP));
    for (const xx of [x, x + 1]) {
      const key = `${xx},${y}`;
      if (!filled.has(key)) {
        filled.add(key);
        stem.push(`M${xx} ${y}h1v1h-1z`);
      }
    }
  }
  // leaf
  const lx = CX + 4 * curl;
  for (let k = 0; k < 6; k++)
    for (let j = 0; j < 3; j++) {
      const x = lx + curl * k;
      const y = 28 - Math.round(k * 0.7) + j - 1;
      if (j === 1 && k > 0 && k < 5) continue; // hollow vein
      const key = `${x},${y}`;
      if (!filled.has(key) && x >= 0 && x < W) {
        filled.add(key);
        stem.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  return { head: head.join(""), stem: stem.join("") };
}

const cache = new Map<number, { head: string; stem: string }>();
function cells(v: number) {
  let c = cache.get(v);
  if (!c) {
    c = buildCells(v);
    cache.set(v, c);
  }
  return c;
}

/** Wall-clock phase so every flower on screen sways in unison. */
function useSyncedPhase() {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    ref.current?.style.setProperty("--fl-delay", `-${Date.now() % SWAY_MS}ms`);
  }, []);
  return ref;
}

export function PixelFlower({
  variant = 0,
  className,
  title,
  tone = "poppy",
  animated = true,
}: {
  variant?: number;
  className?: string;
  title?: string;
  tone?: "poppy" | "ink" | "paper";
  animated?: boolean;
}) {
  const c = useMemo(() => cells(variant), [variant]);
  const ref = useSyncedPhase();
  const fill = tone === "poppy" ? "fill-poppy" : tone === "ink" ? "fill-ink" : "fill-paper-light";
  return (
    <svg
      ref={ref}
      viewBox={`-2 -2 ${W + 4} ${H + 4}`}
      shapeRendering="crispEdges"
      className={cn("block", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <g className={animated ? "fl-root" : undefined}>
        <path d={c.stem} className={cn(fill, animated && "fl-stem")} style={{ transformOrigin: `${CX}px ${H}px` }} />
        <path d={c.head} className={cn(fill, animated && "fl-head")} style={{ transformOrigin: `${CX}px ${STEM_TOP + 2}px` }} />
      </g>
    </svg>
  );
}

const TONES: { bg: string; tone: "poppy" | "ink" | "paper" }[] = [
  { bg: "bg-paper-light", tone: "poppy" },
  { bg: "bg-poppy", tone: "paper" },
  { bg: "bg-paper-deep", tone: "ink" },
  { bg: "bg-ink", tone: "poppy" },
];

export function FlowerTile({ variant, className, label, animated = true }: { variant: number; className?: string; label?: string; animated?: boolean }) {
  const t = TONES[variant % TONES.length];
  return (
    <div className={cn("hair grid aspect-square place-items-center overflow-hidden", t.bg, className)}>
      <PixelFlower variant={variant} tone={t.tone} className="h-[86%] w-[86%]" title={label} animated={animated} />
    </div>
  );
}

export function AgentAvatar({ variant, size = 40, label, animated = false }: { variant: number; size?: number; label?: string; animated?: boolean }) {
  return (
    <div style={{ width: size, height: size }} className="shrink-0">
      <FlowerTile variant={variant} label={label} animated={animated} className="h-full w-full" />
    </div>
  );
}

export function FlowerTiles({ count = 8, cols = 4, className, start = 0 }: { count?: number; cols?: number; className?: string; start?: number }) {
  return (
    <div className={cn("grid gap-0", className)} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <FlowerTile key={i} variant={(start + i) % 12} className="-mr-px -mb-px" />
      ))}
    </div>
  );
}
