import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckList, Panel, RealBadge, downloadBlob, explorerTx, signSubmitConfirm, useWallets, WalletButtons, PendingTransactions, type PqMine } from "@/components/pq/ui";
import { PageHeader } from "@/components/bits";
import { b64, utf8 } from "@/pq/canonical";
import { acknowledgeBackup, backupBlob, createIdentity, forgetLocal, loadLocal, lock, restoreBackup, unlock, usePqLocal, withSecret } from "@/pq/local";
import { CTX_REGISTRATION, pqSign } from "@/pq/mldsa";
import { MIN_PASSWORD } from "@/pq/vault";
import { getPqReadiness, pqChallenge, pqMine, pqPrepareAnchor, pqRegister } from "@/lib/pq.functions";
import { connectWallet, walletSignMessage, type WalletKind } from "@/services/wallet";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/identity")({
  head: () => ({
    meta: [
      { title: "PQ identity — fleuri" },
      { name: "description", content: "Create, back up and register an ML-DSA-65 post-quantum identity for Fleuri launch passports." },
      { property: "og:title", content: "PQ identity — fleuri" },
      { property: "og:description", content: "Post-quantum launch provenance keys, encrypted on your device." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: IdentityPage,
});

type Mine = PqMine;

function IdentityPage() {
  const local = usePqLocal();
  const { userId, store } = useGarden();
  const wallets = useWallets();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [cluster, setCluster] = useState("devnet");
  const [restoreFile, setRestoreFile] = useState<string | null>(null);

  useEffect(() => loadLocal(), []);
  const refresh = async () => {
    const currentUser = store.get().userId;
    if (!currentUser) return setMine(null);
    const r = await pqMine();
    if (r.ok) setMine(r.data);
  };
  useEffect(() => {
    void refresh();
    void getPqReadiness().then((r) => r.ok && setCluster(r.data.cluster));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const fp = local.envelope?.keyHash;
  const registered = mine?.identities.find((i) => i.key_hash === fp);

  async function register(kind: WalletKind) {
    if (!userId) await store.startSandbox();
    const wallet = await connectWallet(kind);
    const ch = await pqChallenge({ data: { wallet, publicKey: local.envelope!.publicKey } });
    if (!ch.ok) throw new Error(ch.error);
    const msg = utf8(ch.data.statement);
    const walletSig = await walletSignMessage(kind, msg);
    const pqSig = withSecret((kp) => pqSign(kp.secretKey, msg, CTX_REGISTRATION));
    const r = await pqRegister({ data: { challengeId: ch.data.challengeId, publicKey: local.envelope!.publicKey, walletSignature: b64(walletSig), pqSignature: b64(pqSig) } });
    if (!r.ok) throw new Error(r.error);
    toast.success("Identity registered. Anchor it on chain to make it trusted.");
    await refresh();
  }

  async function anchor(kind: WalletKind) {
    const p = await pqPrepareAnchor({ data: { identityId: registered.id } });
    if (!p.ok) throw new Error(p.error);
    const res = await signSubmitConfirm(kind, p.data, { onStatus: (s) => setBusy(s) });
    toast.success(res.detail);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="pq identity" kicker="launch provenance">
        <RealBadge cluster={cluster} />
      </PageHeader>
      <p className="max-w-prose text-sm">
        An ML-DSA-65 (FIPS 204) key that signs your <strong>launch passports</strong>. It proves who launched a token and on which exact terms. It does <strong>not</strong> make Solana custody quantum-safe — your wallet and tokens still use Ed25519.
      </p>

      <Panel title="1 · key on this device">
        {!local.ready ? (
          <p className="text-sm">Reading this device…</p>
        ) : !local.envelope ? (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (pw.length < MIN_PASSWORD) { toast.error(`Use at least ${MIN_PASSWORD} characters.`); return; }
              if (pw !== pw2) { toast.error("Passwords do not match."); return; }
              void run("Generating key…", async () => {
                await createIdentity(pw);
                setPw("");
                setPw2("");
                toast.success("Key created and encrypted on this device. Download your backup now.");
              });
            }}
          >
            <label className="text-sm font-semibold">
              Encryption password
              <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className="hair mt-1 block h-10 w-full bg-paper-light px-2 font-normal" />
            </label>
            <label className="text-sm font-semibold">
              Repeat password
              <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="hair mt-1 block h-10 w-full bg-paper-light px-2 font-normal" />
            </label>
            <p className="text-xs text-ink-soft sm:col-span-2">At least {MIN_PASSWORD} characters. Fresh random entropy from this browser — never derived from your wallet. Fleuri never sees the password or the private key.</p>
            <button type="submit" className="btn btn-red sm:col-span-2" disabled={!!busy}>{busy ?? "Create PQ identity"}</button>
          </form>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="break-all font-mono text-xs">fingerprint {fp}</p>
            <p>Status: <strong>{local.unlocked ? "unlocked (in memory, auto-locks after 15 min idle)" : "locked"}</strong></p>
            <div className="flex flex-wrap gap-2">
              {local.unlocked ? (
                <button type="button" className="btn btn-paper" onClick={() => (lock(), toast("Locked."))}>Lock</button>
              ) : (
                <form className="flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), void run("Unlocking…", async () => { await unlock(pw); setPw(""); toast.success("Unlocked."); }))}>
                  <label className="sr-only" htmlFor="unlock-pw">Password</label>
                  <input id="unlock-pw" type="password" autoComplete="current-password" placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} className="hair h-10 bg-paper-light px-2" />
                  <button type="submit" className="btn btn-red" disabled={!!busy}>{busy ?? "Unlock"}</button>
                </form>
              )}
              <button type="button" className="btn btn-paper" onClick={() => downloadBlob(backupBlob(), `fleuri-pq-key-${fp!.slice(0, 8)}.json`)}>Download encrypted backup</button>
              <button type="button" className="btn btn-paper" onClick={() => { if (window.confirm("Remove this key from this device? Without your backup file it cannot be recovered.")) forgetLocal(); }}>Remove from device</button>
            </div>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={local.backupAck} disabled={local.backupAck} onChange={() => acknowledgeBackup()} className="mt-1" />
              <span>I downloaded the encrypted backup and stored it somewhere other than this browser. I understand Fleuri cannot recover a lost key or password.</span>
            </label>
          </div>
        )}
        <details className="text-sm">
          <summary className="font-semibold">Restore from a backup file</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="text-xs">
              Backup file
              <input type="file" accept="application/json,.json" className="block text-xs" onChange={async (e) => setRestoreFile((await e.target.files?.[0]?.text()) ?? null)} />
            </label>
            <label className="sr-only" htmlFor="restore-pw">Backup password</label>
            <input id="restore-pw" type="password" placeholder="backup password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="hair h-10 bg-paper-light px-2" />
            <button type="button" className="btn btn-paper" disabled={!restoreFile || !!busy} onClick={() => void run("Restoring…", async () => { await restoreBackup(restoreFile!, pw2); setPw2(""); toast.success("Backup restored and unlocked."); })}>Restore</button>
          </div>
        </details>
      </Panel>

      <Panel title="2 · register with a wallet">
        {!local.envelope ? (
          <p className="text-sm text-ink-soft">Create or restore a key first.</p>
        ) : !local.backupAck ? (
          <p className="text-sm">Confirm your backup above before registering.</p>
        ) : registered ? (
          <p className="text-sm">Registered to wallet <span className="font-mono">{registered.wallet}</span> on {registered.cluster} · status <strong>{registered.status}</strong>.</p>
        ) : (
          <>
            <p className="text-sm">The server issues a single-use 5-minute challenge naming this site, the cluster genesis, your Fleuri account, your wallet and this key. Your wallet (Ed25519) and this key (ML-DSA-65) both sign the same statement.</p>
            {!local.unlocked && <p className="text-sm font-semibold text-poppy-deep">Unlock your key to sign.</p>}
            <WalletButtons avail={wallets} busy={busy} disabled={!local.unlocked} action="Register with" onPick={(k) => run("Registering…", () => register(k))} />
          </>
        )}
      </Panel>

      <Panel title="3 · anchor on chain">
        {!registered ? (
          <p className="text-sm text-ink-soft">Register first. Until anchored, verifiers treat the identity as pending.</p>
        ) : registered.status === "anchored" ? (
          <p className="text-sm">
            Anchored in slot {registered.anchor_slot} ·{" "}
            <a className="underline" href={explorerTx(registered.anchor_signature, registered.cluster)} target="_blank" rel="noreferrer">view memo transaction</a>
          </p>
        ) : (
          <>
            <p className="text-sm">Sends one SPL Memo transaction from your wallet committing the registration hash <span className="break-all font-mono text-xs">{registered.registration_hash}</span>. It costs a normal network fee paid by your wallet.</p>
            <WalletButtons avail={wallets} busy={busy} action="Anchor with" onPick={(k) => run("Anchoring…", () => anchor(k))} />
          </>
        )}
      </Panel>

      {mine && <PendingTransactions rows={mine.preparations} onRefresh={refresh} />}

      <Panel title="limits">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Lose the backup file or its password and the key is gone. Register a new identity; old passports stay verifiable.</li>
          <li>The key protects provenance of passports, not funds. A compromised wallet can still move tokens.</li>
          <li>Standard ML-DSA is stateless, so signing many passports is safe (no one-time leaf state).</li>
        </ul>
        <p className="text-sm">Next: <Link to="/launchpad" className="underline">open the launchpad</Link> · <Link to="/verify" className="underline">verify a passport</Link></p>
      </Panel>
      {mine && mine.identities.length > 1 && <CheckList label="Your identities" checks={mine.identities.map((i) => ({ id: i.id, label: i.key_hash.slice(0, 16) + "…", status: i.status === "anchored" ? "pass" : "pending", detail: `${i.wallet} · ${i.cluster}` }))} />}
    </div>
  );
}
