import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { startSession } from "@/domain/engine";
import { WALLET_URLS, connectAndSign, disconnectWallet, getProvider, type WalletKind } from "@/services/wallet";
import { useGarden } from "@/store/garden";
import { SandboxBadge } from "./bits";

export function WalletDialog() {
  const { state, ui, store } = useGarden();
  const [avail, setAvail] = useState<Record<WalletKind, boolean>>({ phantom: false, solflare: false });
  const [busy, setBusy] = useState<WalletKind | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (ui.walletOpen) {
      setErr(null);
      setAvail({ phantom: !!getProvider("phantom"), solflare: !!getProvider("solflare") });
    }
  }, [ui.walletOpen]);
  const owner = state?.owner;

  async function startSandbox() {
    await store.act((d) => startSession(d, crypto.randomUUID(), Date.now()));
    toast.success("Sandbox workspace started with 250 vSOL.");
  }

  async function connect(kind: WalletKind) {
    setErr(null);
    setBusy(kind);
    try {
      let id = store.get().state?.owner?.id;
      if (!id) {
        id = crypto.randomUUID();
        await store.act((d) => startSession(d, id!, Date.now()));
      }
      const link = await connectAndSign(kind, id);
      await store.act((d) => {
        if (d.owner) d.owner.wallet = link;
      });
      toast.success("Wallet linked by verified signature.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Wallet connection failed.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink() {
    if (owner?.wallet) await disconnectWallet(owner.wallet.provider);
    await store.act((d) => {
      if (d.owner) d.owner.wallet = null;
    });
    toast("Wallet unlinked. Your sandbox stays.");
  }

  return (
    <Dialog open={ui.walletOpen} onOpenChange={(o) => store.setUI({ walletOpen: o })}>
      <DialogContent className="border border-ink bg-paper grain sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="display text-3xl">enter the garden</DialogTitle>
          <DialogDescription>
            Observing is free. To grow agents, start a sandbox workspace. Linking a wallet is optional and only proves who you are — no funds move.
          </DialogDescription>
        </DialogHeader>
        <SandboxBadge className="w-fit" />
        {owner ? (
          <div className="hair space-y-1 bg-paper-light p-3 text-sm">
            <p><strong>Sandbox active.</strong> Balance <span className="num">{owner.vsol.toFixed(2)}</span> vSOL.</p>
            {owner.wallet ? (
              <p className="break-all font-mono text-xs">
                {owner.wallet.provider} · {owner.wallet.address} · signature verified
              </p>
            ) : (
              <p className="text-xs text-ink-soft">No wallet linked.</p>
            )}
          </div>
        ) : (
          <button type="button" className="btn btn-red w-full" onClick={startSandbox}>
            Start sandbox — no wallet needed
          </button>
        )}
        <div className="space-y-2">
          <p className="font-mono text-xs uppercase tracking-wider text-ink-soft">link a real wallet (optional)</p>
          {(["phantom", "solflare"] as const).map((k) => (
            <div key={k} className="hair flex items-center justify-between gap-3 bg-paper-light p-3">
              <div>
                <p className="font-bold capitalize">{k}</p>
                <p className="text-xs text-ink-soft">{avail[k] ? "Detected in this browser" : "Not installed in this browser"}</p>
              </div>
              {avail[k] ? (
                <button type="button" className="btn btn-ink" disabled={!!busy || owner?.wallet?.provider === k} onClick={() => connect(k)}>
                  {busy === k ? "Waiting for signature…" : owner?.wallet?.provider === k ? "Linked" : "Connect & sign"}
                </button>
              ) : (
                <a className="btn btn-paper" href={WALLET_URLS[k]} target="_blank" rel="noreferrer">
                  Get {k}
                </a>
              )}
            </div>
          ))}
          {err && <p role="alert" className="text-sm font-semibold text-poppy-deep">{err}</p>}
          {owner?.wallet && (
            <button type="button" className="text-sm underline hover:text-poppy" onClick={unlink}>
              Unlink wallet
            </button>
          )}
          <p className="text-xs text-ink-soft">Fleuri never asks for a seed phrase or private key. Real-money trading is off until Fleuri contracts are deployed.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
