import { useMemo, useState } from "react";
import type { PricePoint } from "@/domain/types";
import { clock, priceFmt } from "@/lib/format";

export function Sparkline({ points, className, w = 80, h = 26 }: { points: PricePoint[]; className?: string; w?: number; h?: number }) {
  const d = useMemo(() => path(points.slice(-40), w, h), [points, w, h]);
  const up = points.length > 1 && points[points.length - 1].p >= points[0].p;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} width={w} height={h} aria-hidden>
      <path d={d} fill="none" className={up ? "stroke-poppy" : "stroke-ink"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function path(pts: { t: number; p: number }[], w: number, h: number) {
  if (pts.length < 2) return `M0 ${h / 2}H${w}`;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t || t0 + 1;
  const ps = pts.map((x) => x.p);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const span = hi - lo || hi * 0.01 || 1;
  return pts
    .map((x, i) => {
      const X = ((x.t - t0) / (t1 - t0 || 1)) * w;
      const Y = h - 2 - ((x.p - lo) / span) * (h - 4);
      return `${i ? "L" : "M"}${X.toFixed(1)} ${Y.toFixed(1)}`;
    })
    .join("");
}

/** Step chart over time with hover readout. Values are vSOL per token. */
export interface ChartMarker { t: number; kind: "launch" | "graduate" | "buy" | "sell"; label: string }
export function PriceChart({ points, label, markers = [] }: { points: PricePoint[]; label: string; markers?: ChartMarker[] }) {
  const W = 640;
  const H = 220;
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2)
    return <div className="grid h-[220px] place-items-center font-mono text-xs text-ink-soft">not enough trades in this window yet</div>;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const ps = points.map((p) => p.p);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const span = hi - lo || hi * 0.02;
  const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const Y = (p: number) => H - 10 - ((p - lo) / span) * (H - 30);
  let d = "";
  points.forEach((p, i) => {
    d += i ? `H${X(p.t).toFixed(1)}V${Y(p.p).toFixed(1)}` : `M${X(p.t).toFixed(1)} ${Y(p.p).toFixed(1)}`;
  });
  const hp = hover != null ? points[hover] : points[points.length - 1];
  return (
    <figure className="relative">
      <figcaption className="sr-only">{label}</figcaption>
      <div className="num pointer-events-none absolute left-2 top-1 text-xs">
        {priceFmt(hp.p)} vSOL · {clock(hp.t)}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[220px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(p.t - t) < Math.abs(points[best].t - t)) best = i;
          });
          setHover(best);
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="stroke-ink/15" strokeDasharray="2 4" />
        ))}
        <path d={`${d}V${H}H0Z`} className="fill-poppy/10" />
        <path d={d} fill="none" className="stroke-poppy" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {markers.filter((m) => m.t >= t0 && m.t <= t1).map((m, i) => (
          <g key={i}>
            <title>{m.label}</title>
            <line x1={X(m.t)} x2={X(m.t)} y1="0" y2={H} className={m.kind === "graduate" || m.kind === "launch" ? "stroke-ink" : "stroke-ink/25"} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <rect x={X(m.t) - 4} y={H - 9} width="8" height="8" className={m.kind === "sell" ? "fill-ink" : "fill-poppy"} />
          </g>
        ))}
        {hover != null && <line x1={X(hp.t)} x2={X(hp.t)} y1="0" y2={H} className="stroke-ink" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {markers.length > 0 && <p className="mt-1 font-mono text-[0.65rem] text-ink-soft">▪ red: launch/large buys · ▪ black: large sells · dashed: events</p>}
    </figure>
  );
}

export function BarRow({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1e-9);
  return (
    <ul className="space-y-1.5">
      {data.map((d) => (
        <li key={d.label} className="grid grid-cols-[5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
          <span className="truncate font-mono">{d.label}</span>
          <span className="hair h-3 bg-paper-light">
            <span className={`block h-full ${d.value >= 0 ? "bg-poppy" : "bg-ink"}`} style={{ width: `${(Math.abs(d.value) / max) * 100}%` }} />
          </span>
          <span className="num text-right">{d.value.toFixed(3)}</span>
        </li>
      ))}
    </ul>
  );
}
