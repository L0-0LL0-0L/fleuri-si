import { Link } from "@tanstack/react-router";
import { Check, Copy, Link2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { FLEURI_MINT, FLEURI_MINT_NOTE } from "@/lib/token";
import { cn } from "@/lib/utils";
import { PixelFlower } from "./PixelFlower";

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn("group inline-flex items-end gap-1.5", className)} aria-label="fleuri home">
      <span className="wordmark text-[2.4rem] text-ink">fleuri</span>
      <span className="mb-1 flex gap-0.5" aria-hidden>
        <span className="h-2 w-2 bg-poppy" />
        <span className="h-2 w-2 bg-lagoon" />
      </span>
    </Link>
  );
}

export function SandboxBadge({ className }: { className?: string }) {
  return (
    <span className={cn("chip bg-paper-light text-ink", className)} title="All balances and trades are simulated with virtual SOL.">
      <span className="h-1.5 w-1.5 bg-poppy" aria-hidden /> Sandbox · virtual SOL
    </span>
  );
}

export function OnchainBadge({ className }: { className?: string }) {
  return (
    <span className={cn("chip bg-ink text-paper-light", className)} title="Transactions on this page use real Solana assets and require your wallet's approval.">
      <span className="h-1.5 w-1.5 bg-poppy" aria-hidden /> On-chain<span className="hidden sm:inline">&nbsp;· real assets</span><span className="sr-only sm:hidden"> · real assets</span>
    </span>
  );
}

export function SegTabs<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("hair inline-flex max-w-full overflow-x-auto bg-paper-light", className)}>
      {options.map((o) => (
        <button key={o.value} role="tab" type="button" aria-selected={value === o.value} className="seg shrink-0" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="hair flex flex-col items-center gap-3 bg-paper-light px-6 py-10 text-center">
      <PixelFlower variant={4} className="h-16 w-12" tone="ink" />
      <p className="display text-xl">{title}</p>
      {body && <p className="max-w-sm text-sm text-ink-soft">{body}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse bg-paper-deep", className)} aria-hidden />;
}
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="hair flex gap-3 bg-paper-light p-3">
          <Skeleton className="h-10 w-10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="hair h-2.5 w-full bg-paper-light" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label ?? "Graduation progress"}>
      <div className="h-full bg-poppy" style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 p-2.5", className)}>
      <div className="truncate font-mono text-[0.65rem] uppercase tracking-wider text-ink-soft">{label}</div>
      <div className="num truncate text-base font-semibold">{value}</div>
    </div>
  );
}

export function PageHeader({ title, kicker, children, wrapTitle = false }: { title: string; kicker?: string; children?: ReactNode; wrapTitle?: boolean }) {
  return (
    <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {kicker && <p className="font-mono text-xs uppercase tracking-widest text-poppy">{kicker}</p>}
        <h1 className={cn("display text-4xl sm:text-5xl", wrapTitle ? "break-words" : "truncate")}>{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function CopyLink({ path, label = "Copy link" }: { path: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs font-semibold hover:text-poppy"
      onClick={async () => {
        const url = `${window.location.origin}${path}`;
        try {
          if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ url, title: "fleuri" });
          else await navigator.clipboard.writeText(url);
          setDone(true);
          toast.success("Link copied");
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Couldn't copy — your browser blocked clipboard access.");
        }
      }}
      aria-label={label}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{done ? "Copied" : "Share"}</span>
    </button>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    post: "bg-paper-light",
    reply: "bg-paper-light",
    buy: "bg-sprout text-paper-light",
    sell: "bg-ink text-paper-light",
    launch: "bg-poppy text-paper-light",
    graduate: "bg-poppy text-paper-light",
    follow: "bg-lagoon text-ink",
  };
  return <span className={cn("chip", map[kind])}>{kind}</span>;
}

/**
 * Top-bar "CA" button: press it and the $FLEURI contract address appears in a
 * panel where it can be copied or selected as a whole. The address is shown with
 * its real status — no account exists on chain yet, so nothing here may read as a
 * live market.
 */
export function CaChip({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(FLEURI_MINT);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Clipboard API needs a secure context; fall back to a hidden field.
      const ta = document.createElement("textarea");
      ta.value = FLEURI_MINT;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (!ok) {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
      return;
    }
    setDone(true);
    toast.success("Contract address copied");
    setTimeout(() => setDone(false), 1800);
  };

  return (
    <div ref={wrap} className={cn("shrink-0", className)}>
      <button
        type="button"
        className="btn btn-red h-9 min-h-9 px-2 text-xs"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="fleuri-ca"
        title="Show the $FLEURI contract address"
      >
        CA
      </button>
      {open && (
        <div id="fleuri-ca" className="hair grain absolute left-2 top-[calc(100%+0.35rem)] z-40 w-[min(86vw,26rem)] bg-paper-light p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[0.65rem] uppercase tracking-widest text-poppy">$FLEURI contract address</p>
            <span className="chip bg-sprout text-paper-light" title="Verified by reading the mint and its pool on Solana mainnet.">live</span>
          </div>
          <code className="mt-1.5 block select-all break-all font-mono text-sm font-semibold leading-snug">{FLEURI_MINT}</code>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-ink h-9 min-h-9 px-3 text-xs" onClick={copy}>
              {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {done ? "Copied" : "Copy address"}
            </button>
            <p className="min-w-0 flex-1 text-xs font-semibold leading-snug">Only send funds if the address and launch are independently verified on Meteora.</p>
            <Link to="/t/$mint" params={{ mint: FLEURI_MINT }} className="chip bg-paper-deep text-ink">
              token page ↗
            </Link>
          </div>
          <p className="mt-2.5 text-xs leading-snug text-ink-soft">{FLEURI_MINT_NOTE}</p>
        </div>
      )}
    </div>
  );
}
