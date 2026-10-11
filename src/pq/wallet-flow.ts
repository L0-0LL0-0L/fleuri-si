// Scope-guarded wallet sign → submit → confirm. The caller's review scope is re-checked before and
// after wallet connection, after the wallet returns a signature, before submission and around every
// confirmation poll. A wallet account change/disconnect or an abort cancels the wait immediately, and
// a signature that arrives after cancellation is never submitted.

export class ScopeChangedError extends Error { constructor(m: string) { super(m); this.name = "ScopeChangedError"; } }

export interface WalletFlowDeps<T> {
  decode(b64: string): T;
  feePayer(tx: T): string | undefined;
  connect(): Promise<string>;
  coSign?(tx: T): void;
  sign(tx: T): Promise<T>;
  serialize(tx: T): string;
  submit(serialized: string): Promise<{ ok: true; data: { signature: string } } | { ok: false; error: string }>;
  confirm(): Promise<{ ok: true; data: { status: string; id?: string; detail: string } } | { ok: false; error: string }>;
  /** Subscribes to wallet account changes/disconnects; returns an unsubscribe. Pass the new account
   *  (base58), null for a disconnect, or undefined when unknown. */
  watchAccount?(onChange: (account?: string | null) => void): () => void;
  sleep?(ms: number): Promise<void>;
}
export interface WalletFlowOpts { onStatus?: (s: string) => void; guard?: () => boolean; signal?: AbortSignal; polls?: number; pollMs?: number }

export async function guardedSignSubmit<T>(prep: { preparationId: string; transaction: string }, d: WalletFlowDeps<T>, o: WalletFlowOpts = {}) {
  const local = new AbortController();
  const onOuter = () => local.abort(); o.signal?.addEventListener("abort", onOuter);
  if (o.signal?.aborted) local.abort();
  // The connecting wallet's own initial accountChanged event is not a switch; any other account,
  // a disconnect, or an unknown change after connection cancels.
  let connected: string | null = null;
  const unwatch = d.watchAccount?.((acct) => {
    if (acct === null) return local.abort();
    if (connected === null) { if (acct === undefined) local.abort(); return; }
    if (acct !== connected) local.abort();
  }) ?? (() => {});
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const check = (stage: string) => { if (local.signal.aborted || (o.guard && !o.guard())) throw new ScopeChangedError(`Cancelled ${stage}: the account, wallet or review changed. Nothing new was sent.`); };
  // Rejects as soon as cancellation happens, even if the wallet prompt is still open.
  const race = <R,>(p: Promise<R>, stage: string) => new Promise<R>((res, rej) => {
    p.catch(() => {}); // a late wallet rejection after cancellation must never be unhandled
    const ab = () => rej(new ScopeChangedError(`Cancelled ${stage}: the account, wallet or review changed. Nothing new was sent.`));
    if (local.signal.aborted) return ab();
    local.signal.addEventListener("abort", ab, { once: true });
    p.then((v) => { local.signal.removeEventListener("abort", ab); res(v); }, (e) => { local.signal.removeEventListener("abort", ab); rej(e); });
  });
  try {
    const tx = d.decode(prep.transaction);
    check("before connecting");
    const wallet = await race(d.connect(), "while connecting");
    connected = wallet;
    check("after connecting");
    if (wallet !== d.feePayer(tx)) throw new Error("Switch to the wallet named in this prepared transaction.");
    d.coSign?.(tx);
    o.onStatus?.("Waiting for your wallet to sign…");
    const signed = await race(d.sign(tx), "while the wallet was open");
    check("after the wallet signed (the signature was discarded)");
    o.onStatus?.("Submitting the exact prepared transaction…");
    const bytes = d.serialize(signed);
    // Last gate: nothing (status callbacks, serialization) may run between this check and submit.
    check("before submission (the signature was discarded)");
    const sub = await d.submit(bytes);
    if (!sub.ok) throw new Error(sub.error);
    for (let i = 0; i < (o.polls ?? 40); i++) {
      if (local.signal.aborted || (o.guard && !o.guard())) throw new ScopeChangedError(`Submitted ${sub.data.signature}; stopped watching because the view changed. Check it under Pending transactions.`);
      o.onStatus?.("Waiting for on-chain confirmation…");
      const c = await d.confirm();
      if (local.signal.aborted || (o.guard && !o.guard())) throw new ScopeChangedError(`Submitted ${sub.data.signature}; stopped watching because the view changed. Check it under Pending transactions.`);
      if (!c.ok) throw new Error(c.error);
      if (c.data.status === "confirmed") return { signature: sub.data.signature, id: c.data.id, detail: c.data.detail };
      await sleep(o.pollMs ?? 2500);
    }
    throw new Error(`Submitted ${sub.data.signature} but confirmation timed out. Re-check later — confirmation is idempotent.`);
  } finally { unwatch(); o.signal?.removeEventListener("abort", onOuter); }
}
