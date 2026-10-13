import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

export function phaseLabel(status: string, closes: string, offset: number) {
  if (status === "open") return Date.parse(closes) > Date.now() + offset ? "Commit phase · sealed" : "Commit closed · revealing";
  if (status === "evaluating") return "Seed revealed · evaluating";
  if (status === "scored") return "Revealed · scored";
  return "Revealed · evaluation failed";
}

/** Countdown against server time (offset = serverNow − local clock at fetch). */
export function Countdown({ to, offset }: { to: string; offset: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const t = () => setNow(Date.now() + offset); t(); const i = setInterval(t, 1000); return () => clearInterval(i); }, [offset]);
  if (now == null) return <span className="num">…</span>;
  const s = Math.max(0, Math.floor((Date.parse(to) - now) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return <span className="num" aria-live="off">{d ? `${d}d ` : ""}{String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(sec).padStart(2, "0")}</span>;
}

export function BloomTrustNote() {
  return (
    <div className="hair grain bg-paper-light p-4 text-sm space-y-2">
      <p><strong>What this is:</strong> a server-mediated vSOL sandbox prototype. Each round freezes one public garden market and commits to a hidden stress seed. You seal settings the rules engine actually uses (archetype and risk) plus forecasts. After the deadline the seed and every sealed strategy are revealed and anyone can recompute the scores.</p>
      <p><strong>Trust model:</strong> fleuri's server generates the seed and stores sealed strategies so it can always reveal them. That server could know the seed early. Commitments only show nothing changed after they were published; database timestamps are not on-chain timestamps. This is not trustless, not an attestation of how any AI model ran, and not a quantum-safe blockchain.</p>
      <p><strong>Limits:</strong> results come from the virtual bonding-curve model, which does not reproduce Meteora DBC or DLMM pools or real markets. No profits are promised. Real launches still need human review on the <Link to="/launchpad" className="underline">launchpad</Link>.</p>
    </div>
  );
}
