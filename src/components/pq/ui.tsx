import { Transaction } from "@solana/web3.js";
import { useEffect, useState, type ReactNode } from "react";
import { b64, fromB64 } from "@/pq/canonical";
import type { Check } from "@/pq/passport";
import { pqConfirm, pqSubmit } from "@/lib/pq.functions";
import { getProvider, walletSignTransaction, type WalletKind } from "@/services/wallet";
import { cn } from "@/lib/utils";

export function RealBadge({ cluster, className }: { cluster?: string; className?: string }) {
  return (
    <span className={cn("hair inline-flex items-center gap-1 bg-ink px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-widest text-paper-light", className)}>
      <span aria-hidden className="h-1.5 w-1.5 bg-poppy" /> real · {cluster ?? "solana"}
    </span>
  );
}

const TONE: Record<Check["status"], string> = { pass: "bg-sprout text-paper-light", fail: "bg-poppy-deep text-paper-light", pending: "bg-paper-deep", unavailable: "bg-paper-light text-ink-soft" };
export function CheckList({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <ul aria-label={label} className="hair divide-y divide-ink/20 bg-paper-light">
      {checks.map((c) => (
        <li key={c.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2 p-2 text-sm">
          <span className={cn("hair px-1.5 py-0.5 text-center font-mono text-[0.65rem] uppercase", TONE[c.status])}>{c.status}</span>
          <span className="min-w-0">
            <strong className="block">{c.label}</strong>
            <span className="block break-words text-xs text-ink-soft">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("hair space-y-3 bg-paper-light p-3 sm:p-4", className)} aria-label={title}>
      <h2 className="font-mono text-xs uppercase tracking-widest">{title}</h2>
      {children}
    </section>
  );
}

export function useWallets() {
  const [avail, setAvail] = useState<Record<WalletKind, boolean>>({ phantom: false, solflare: false });
  useEffect(() => {
    const t = setTimeout(() => setAvail({ phantom: !!getProvider("phantom"), solflare: !!getProvider("solflare") }), 300);
    return () => clearTimeout(t);
  }, []);
  return avail;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const explorerTx = (sig: string, cluster: string) => `https://explorer.solana.com/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
export const explorerAddr = (a: string, cluster: string) => `https://explorer.solana.com/address/${a}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

/**
 * Signs a server-prepared transaction (optionally co-signing with a local ephemeral keypair such as a
 * fresh mint), submits the exact bytes, then polls confirmation. Returns the real signature.
 */
export async function signSubmitConfirm(
  kind: WalletKind,
  prep: { preparationId: string; transaction: string },
  opts: { coSign?: { publicKey: unknown; secretKey: Uint8Array }[]; onStatus?: (s: string) => void } = {},
) {
  const tx = Transaction.from(fromB64(prep.transaction));
  if (opts.coSign?.length) tx.partialSign(...(opts.coSign as any));
  opts.onStatus?.("Waiting for your wallet to sign…");
  const signed = await walletSignTransaction(kind, tx);
  opts.onStatus?.("Submitting the exact prepared transaction…");
  const sub = await pqSubmit({ data: { preparationId: prep.preparationId, transaction: b64(signed.serialize()) } });
  if (!sub.ok) throw new Error(sub.error);
  for (let i = 0; i < 40; i++) {
    opts.onStatus?.("Waiting for on-chain confirmation…");
    const c = await pqConfirm({ data: { preparationId: prep.preparationId } });
    if (!c.ok) throw new Error(c.error);
    if (c.data.status === "confirmed") return { signature: sub.data.signature as string, id: c.data.id as string | undefined, detail: c.data.detail as string };
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Submitted ${sub.data.signature} but confirmation timed out. Re-check later — confirmation is idempotent.`);
}
