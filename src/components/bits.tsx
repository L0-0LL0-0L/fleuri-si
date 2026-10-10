import { Link } from "@tanstack/react-router";
import { Check, Link2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
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
      <span className="h-1.5 w-1.5 bg-poppy" aria-hidden /> On-chain · real assets
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

export function PageHeader({ title, kicker, children }: { title: string; kicker?: string; children?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {kicker && <p className="font-mono text-xs uppercase tracking-widest text-poppy">{kicker}</p>}
        <h1 className="display truncate text-4xl sm:text-5xl">{title}</h1>
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
