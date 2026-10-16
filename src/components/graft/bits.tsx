import { useState } from "react";
import { verifyBundle } from "@/domain/graft";

/** Decorative graft: a stem joined to a scion by a ribbon. Pure SVG, respects reduced motion via CSS. */
export function GraftRibbon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Grafted flower">
      <rect x="30" y="34" width="4" height="26" fill="var(--ink)" />
      <rect x="22" y="40" width="8" height="4" fill="var(--ink)" />
      <rect x="26" y="30" width="12" height="6" fill="var(--poppy)" opacity="0.9" />
      <rect x="24" y="31" width="4" height="4" fill="var(--poppy)" />
      <rect x="36" y="31" width="4" height="4" fill="var(--poppy)" />
      {[[28, 10], [20, 18], [36, 18], [28, 22]].map(([x, y], i) => <rect key={i} x={x} y={y} width="8" height="8" fill="var(--poppy)" />)}
      <rect x="28" y="18" width="8" height="4" fill="var(--ink)" />
    </svg>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", review: "In review", active: "Active", expired: "Expired", suspended: "Suspended", revoked: "Revoked", completed: "Completed",
  proposed: "Proposed — not paid", approved_awaiting_wallet_payment: "Payment proposed, awaiting wallet payment", rejected: "Rejected",
};

export function StatusChip({ s }: { s: string }) {
  const tone = s === "active" ? "bg-poppy text-paper-light" : s === "review" || s === "draft" ? "bg-paper-light" : "bg-paper";
  return <span className={`chip ${tone}`}>{STATUS_LABEL[s] ?? s}</span>;
}

export function GraftTrustNote() {
  return (
    <div className="hair bg-paper-light p-3 text-sm">
      <p><strong>What Graft is:</strong> an owner-approved, read-only research mandate for one exact agent version. The steward reads a Meteora pool on mainnet with fixed tools, then saves a private report with slots and hashes.</p>
      <p className="mt-1"><strong>What it is not:</strong> no wallet, no trades, no payments. Purchase requests are proposals only; paying still happens through the separate Botanist wallet checkout. Budgets are server limits, not on-chain caps. Runs happen when you press Run — there is no always-on scheduler.</p>
    </div>
  );
}

export function GraftVerifier() {
  const [res, setRes] = useState<ReturnType<typeof verifyBundle> | null>(null);
  const [name, setName] = useState("");
  return (
    <div className="space-y-2 text-sm">
      <p>Check a Graft evidence file in this browser. It recomputes every hash; it cannot prove when things happened.</p>
      <label className="btn btn-paper inline-block cursor-pointer">Choose a .json file
        <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setName(f.name); setRes(f.size > 2_000_000 ? { valid: false, bundle: null, checks: [{ id: "size", label: "Size", status: "fail", detail: "File is larger than 2 MB." }] } : verifyBundle(await f.text())); }} />
      </label>
      {res && (
        <div className="hair bg-paper-light p-2" aria-live="polite">
          <p className="font-bold">{name}: {res.valid ? "Consistent" : res.checks.some((c) => c.status === "unsupported") ? "Unsupported version" : "Not consistent"}</p>
          <ul className="mt-1 space-y-1">{res.checks.map((c) => <li key={c.id}><span className="num">{c.status === "pass" ? "PASS" : c.status === "unsupported" ? "UNSUPPORTED" : "FAIL"}</span> {c.label} — {c.detail}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
