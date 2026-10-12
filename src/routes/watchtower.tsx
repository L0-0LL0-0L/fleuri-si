import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { Panel, RealBadge, downloadBlob, explorerAddr } from "@/components/pq/ui";
import { wtKnown, wtWatch } from "@/lib/watchtower.functions";
import { formatUnits } from "@/pq/pollen";
import { STAGE_TEXT, SOL_MINT, type Status, type WatchInput, type summarize } from "@/pq/watchtower";

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A real public mainnet DBC pool that graduated to DAMM v2; used only as a reading example, unrelated to Fleuri. */
export const EXAMPLE_POOL = "ApRDdrCb7UiN6oEqTYRS5CHTwFhzfeepfiRinL6hvoFQ";

export const Route = createFileRoute("/watchtower")({
  validateSearch: z.object({ pool: z.string().regex(ADDR).optional().catch(undefined), vault: z.string().regex(ADDR).optional().catch(undefined) }),
  head: () => ({ meta: [
    { title: "Graduation Watchtower — fleuri" },
    { name: "description", content: "Watch a Meteora bonding-curve pool graduate to DAMM v2: curve progress, migration steps, the verified pool, liquidity locks and fee routing — read live from Solana." },
    { property: "og:title", content: "Graduation Watchtower — fleuri" },
    { property: "og:description", content: "Public, read-only graduation tracking for Meteora DBC pools, with every status proved from chain accounts." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Watchtower,
});

type Result = { input: WatchInput; summary: ReturnType<typeof summarize> };
const TONE: Record<Status, string> = { verified: "bg-ink text-paper-light", pending: "bg-paper-deep", unknown: "bg-paper-light", unavailable: "bg-paper-light", failed: "bg-poppy text-paper-light", unsupported: "bg-paper-deep" };
const Chip = ({ s }: { s: Status }) => <span className={`chip ${TONE[s]} uppercase`}>{s}</span>;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Copy({ text, label }: { text: string; label: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 1500); };
  return <button type="button" className="btn btn-paper !min-h-0 px-2 py-0.5 text-xs" aria-label={`Copy ${label}`} onClick={() => {
    try { const p = navigator.clipboard?.writeText(text); if (!p) flash("copy blocked"); else p.then(() => flash("copied"), () => flash("copy blocked")); } catch { flash("copy blocked"); }
  }}>{msg ?? "copy"}</button>;
}
const Addr = ({ a, cluster, label }: { a: string; cluster: string; label: string }) => <span className="inline-flex flex-wrap items-center gap-1"><a className="font-mono underline break-all" href={explorerAddr(a, cluster)} target="_blank" rel="noreferrer">{short(a)} ↗</a><Copy text={a} label={label} /></span>;

export function Watchtower() {
  const { pool: param, vault: vaultParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [input, setInput] = useState(param ?? ""); const [vaultIn, setVaultIn] = useState(vaultParam ?? "");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const [known, setKnown] = useState<{ pool: string; cluster: string }[]>([]); const [cluster, setCluster] = useState<string | null>(null);
  const gen = useRef(0); const current = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    wtKnown().then((r) => { if (live && r.ok) { setKnown(r.data.launches ?? []); setCluster(r.data.cluster ?? null); } }, () => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const key = param ? `${param}|${vaultParam ?? ""}` : null;
    if (key && key !== current.current) { setInput(param!); setVaultIn(vaultParam ?? ""); void load(param!, vaultParam); }
    if (!key && current.current) { gen.current++; current.current = null; setRes(null); setErr(""); setBusy(false); setInput(""); setVaultIn(""); }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [param, vaultParam]);
  useEffect(() => () => { gen.current++; current.current = null; }, []);

  async function load(pool: string, vault?: string) {
    const g = ++gen.current; current.current = `${pool}|${vault ?? ""}`;
    setBusy(true); setErr(""); setNote("");
    try {
      const r = await wtWatch({ data: vault ? { pool, vault } : { pool } });
      if (g !== gen.current) return;
      if (!r.ok) { setRes(null); setErr(r.error); return; }
      if (r.data.input.pool.address !== pool) { setErr("The reply did not match the requested pool, so it was discarded."); return; }
      setRes(r.data as Result);
    } catch { if (g === gen.current) setErr("The read could not be completed. Check your connection and try again."); }
    finally { if (g === gen.current) setBusy(false); }
  }
  function submit(pool: string, vault: string) {
    const p = pool.trim(), v = vault.trim();
    if (!ADDR.test(p)) { setErr("Enter a valid Solana pool address (base58, 32–44 characters)."); return; }
    if (v && !ADDR.test(v)) { setErr("The fee-sharing vault address is not a valid Solana address."); return; }
    void navigate({ search: v ? { pool: p, vault: v } : { pool: p }, replace: false });
    if (`${p}|${v}` === current.current) void load(p, v || undefined);
  }
  function exportJson() {
    if (!res) return;
    try {
      const doc = { format: "fleuri.graduation-watchtower/v1", note: "Public chain observation. Accounts were read in separate confirmed batches (slots listed); not one atomic snapshot. Integers are exact base-unit strings.", ...res };
      downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), `graduation-watchtower-${res.input.pool.address.slice(0, 8)}-${res.input.slots.pool}.json`);
    } catch { setNote("The download could not be created in this browser."); }
  }

  const i = res?.input, s = res?.summary;
  const sol = i?.config?.quoteMint === SOL_MINT;
  const q = (x: string) => (sol ? `${formatUnits(x, 9)} SOL` : `${x} base units`);
  return <div className="space-y-4">
    <PageHeader title="graduation watchtower." kicker="public · read-only · Meteora DBC → DAMM v2">{i && <RealBadge cluster={i.cluster} />}</PageHeader>
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <p className="max-w-prose text-sm">Watch a bonding-curve pool grow up. See how close it is to graduating, which migration step it's on, and whether its DAMM v2 pool really exists. You'll also see who holds the liquidity and how it's locked. Nothing is marked done or locked unless the chain accounts prove it. No wallet, no signing.</p>
      <FlowerTiles count={4} cols={4} className="w-40" />
    </div>

    <Panel title="Find a pool">
      <form className="grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); submit(input, vaultIn); }}>
        <input aria-label="DBC pool address" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Meteora DBC pool address" className="hair min-w-0 bg-paper-light px-2 py-2 font-mono text-xs" />
        <button className="btn btn-red" disabled={busy || !input.trim()}>{busy ? "Reading…" : "Watch"}</button>
        <input aria-label="Fee-sharing vault to check (optional)" value={vaultIn} onChange={(e) => setVaultIn(e.target.value)} placeholder="Optional: fee-sharing vault to check routing against" className="hair min-w-0 bg-paper-light px-2 py-2 font-mono text-xs sm:col-span-2" />
      </form>
      {known.length > 0 && <label className="block text-sm">Or pick a launch recorded on fleuri
        <select className="hair mt-1 h-11 w-full bg-paper-light px-2 font-mono text-xs" value="" disabled={busy} onChange={(e) => { if (e.target.value) { setInput(e.target.value); submit(e.target.value, ""); } }}>
          <option value="">Choose…</option>{known.map((k) => <option key={k.pool} value={k.pool}>{short(k.pool)} · {k.cluster}</option>)}
        </select></label>}
      {cluster === "mainnet-beta" && <p className="text-xs">Just exploring? <button type="button" className="underline" disabled={busy} onClick={() => { setInput(EXAMPLE_POOL); submit(EXAMPLE_POOL, ""); }}>Try a public example pool</button> — a real mainnet pool that graduated, not launched by fleuri and unrelated to it.</p>}
      {err && <p role="alert" className="text-sm text-poppy-deep break-words">{err}</p>}
      {note && <p role="status" className="text-sm">{note}</p>}
      {!res && !busy && !err && <p className="text-sm text-ink-soft">Paste a pool address to begin. Only accounts owned by the Meteora Dynamic Bonding Curve program are read.</p>}
    </Panel>

    {i && s && <>
      <Panel title="Graduation status">
        <div className="flex flex-wrap items-center gap-2"><span className="display text-xl">{STAGE_TEXT[s.stage.stage].toLowerCase()}.</span></div>
        <p className="text-sm">{s.stage.reason}</p>
        {s.progressBps != null && <div className="space-y-1">
          <div className="hair h-3 w-full bg-paper-light" role="progressbar" aria-label="Curve progress" aria-valuemin={0} aria-valuemax={10000} aria-valuenow={s.progressBps}><div className="h-full bg-poppy" style={{ width: `${s.progressBps / 100}%` }} /></div>
          <p className="num text-xs">quote reserve {q(i.pool.quoteReserve)} of {q(i.config!.migrationQuoteThreshold)} threshold · {(s.progressBps / 100).toFixed(2)}%</p>
        </div>}
        <dl className="grid gap-1 text-xs sm:grid-cols-2">
          <div><dt className="inline font-semibold">Pool </dt><dd className="inline"><Addr a={i.pool.address} cluster={i.cluster} label="pool address" /></dd></div>
          <div><dt className="inline font-semibold">Base mint </dt><dd className="inline"><Addr a={i.pool.baseMint} cluster={i.cluster} label="base mint" /> · <Link to="/t/$mint" params={{ mint: i.pool.baseMint }} className="underline">token page</Link></dd></div>
          <div><dt className="inline font-semibold">migrationProgress </dt><dd className="inline num">{i.pool.migrationProgress} · isMigrated {i.pool.isMigrated}</dd></div>
          <div><dt className="inline font-semibold">Network </dt><dd className="inline">{i.cluster} · genesis <span className="font-mono">{short(i.genesisHash)}</span></dd></div>
          <div className="sm:col-span-2"><dt className="inline font-semibold">Read at </dt><dd className="inline num">pool slot {i.slots.pool} · config slot {i.slots.config ?? "—"} · DAMM slot {i.slots.damm ?? "—"} · positions slot {i.slots.positions ?? "—"} · fetched {new Date(i.fetchedAt).toUTCString()}</dd></div>
        </dl>
        <p className="text-xs text-ink-soft">{s.caveat}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-paper" disabled={busy} onClick={() => void load(i.pool.address, vaultParam)}>{busy ? "Reading…" : "Refresh"}</button>
          <button type="button" className="btn btn-paper" disabled={busy} onClick={exportJson}>Download JSON</button>
          <Link to="/observatory" className="btn btn-paper">Pollen Observatory</Link>
        </div>
      </Panel>

      <Panel title="Checks">
        <ul className="space-y-1 text-sm">{s.checks.map((c) => <li key={c.id} className="flex flex-wrap items-baseline gap-2"><Chip s={c.status} /><strong>{c.label}</strong><span>{c.detail}</span></li>)}</ul>
      </Panel>

      <Panel title="DAMM v2 pool">
        <p className="flex flex-wrap items-baseline gap-2 text-sm"><Chip s={s.damm.ok ? "verified" : i.pool.isMigrated ? "unknown" : "pending"} /> {s.damm.reason}</p>
        {i.damm.derived && <p className="text-xs">Expected address <Addr a={i.damm.derived} cluster={i.cluster} label="DAMM v2 pool" /> — {i.damm.derivationNote}</p>}
        {s.damm.ok && i.damm.facts && <dl className="grid gap-1 text-xs sm:grid-cols-2">
          <div>Liquidity <span className="num">{i.damm.facts.liquidity}</span></div>
          <div>Permanently locked (pool total) <span className="num">{i.damm.facts.permanentLockLiquidity}</span></div>
          <div>Fee collection mode {i.damm.facts.collectFeeMode === 1 ? "1 · quote token only" : i.damm.facts.collectFeeMode === 0 ? "0 · both tokens" : i.damm.facts.collectFeeMode}</div>
          <div>Dynamic fee {i.damm.facts.dynamicFeeInitialized ? "initialized on this pool" : "not initialized on this pool"}</div>
          <div>Protocol fee {i.damm.facts.protocolFeePercent}% · referral {i.damm.facts.referralFeePercent}% · compounding {i.damm.facts.compoundingFeeBps} bps</div>
          <div>Base fee schedule bytes <span className="font-mono break-all">{i.damm.facts.baseFeeBytesHex.slice(0, 32)}…</span> (not decoded here)</div>
        </dl>}
      </Panel>

      <Panel title="Liquidity · configured vs observed">
        {s.configured ? <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-xs"><caption className="text-left font-semibold">Configured split (config intent, not ownership)</caption><thead><tr className="text-left"><th>Bucket</th><th>Owner</th><th>Unlocked</th><th>Permanent lock</th><th>Vesting</th></tr></thead>
          <tbody>{s.configured.map((b) => <tr key={b.side} className="border-t border-ink/20"><td>{b.side}</td><td className="font-mono">{short(b.owner)}</td><td>{b.unlockedPct}%</td><td>{b.permanentPct}%</td><td>{b.vestingPct}%</td></tr>)}</tbody></table></div>
          : <p className="text-sm">Config unavailable, so the configured split is unknown.</p>}
        {i.discovery && <p className="text-xs"><Chip s={i.discovery.status === "found" ? "verified" : i.discovery.status === "unavailable" ? "unavailable" : "unknown"} /> {i.discovery.detail}</p>}
        {!i.discovery && <p className="text-xs">Positions are only looked for once the DAMM v2 pool verifies.</p>}
        {i.positionErrors.map((e) => <p key={e.address} className="text-xs text-poppy-deep">{short(e.address)}: {e.reason}</p>)}
        {s.positions.length > 0 && <ul className="space-y-2">{s.positions.map((p) => <li key={p.address} className="hair bg-paper p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2"><Chip s={p.status} /><Addr a={p.address} cluster={i.cluster} label="position" />{p.lockBadge && p.status === "verified" && <span className="chip bg-paper-light">{p.lockBadge}</span>}</div>
          {p.problems.map((x) => <p key={x} className="text-poppy-deep">{x}</p>)}
          {p.holder && <p>NFT held by <Addr a={p.holder} cluster={i.cluster} label="holder" /> ({p.holderRole === "dfs_vault" ? "a verified fee-sharing vault" : p.holderRole === "other" ? "not the partner or creator" : p.holderRole})</p>}
          <p className="num">unlocked {p.unlocked} · vesting {p.vested} · permanently locked {p.permanent} (liquidity units)</p>
          {BigInt(p.vested) > 0n && <p>Releasable from vesting now: {p.vestingReleasableNow ?? "unknown (no time reference)"}{p.separateVestingUnknown ? " · part of the vesting lives in separate vesting accounts that are not scanned" : ""}</p>}
        </li>)}</ul>}
      </Panel>

      <Panel title="Fee routing readiness">
        {i.vaults.length > 0 ? <p className="text-xs">Verified fee-sharing vault(s): {i.vaults.map((v) => <span key={v.address} className="mr-2"><Link to="/observatory" search={{ vault: v.address }} className="font-mono underline">{short(v.address)}</Link></span>)}</p>
          : <p className="text-xs">No fee-sharing vault was verified among the fee claimer, creator, position holders{vaultParam ? " or the vault you entered" : ""}.</p>}
        <ul className="space-y-1 text-sm">{s.routing.map((r) => <li key={r.source}><div className="flex flex-wrap items-baseline gap-2"><Chip s={r.status} /><strong>{r.source}</strong></div><ul className="list-disc pl-5 text-xs">{r.detail.map((d) => <li key={d}>{d}</li>)}</ul></li>)}</ul>
        <p className="text-xs text-ink-soft">Readiness means the accounts are set up so fees could reach the vault. It isn't a record of fees routed, and it doesn't mean dynamic fees or staking are live.</p>
      </Panel>
    </>}

    <Panel title="How to read this">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>Stages follow the DBC program's own migration steps: curve, curve complete, locker (only if base-token vesting is configured), pool creation, then graduated.</li>
        <li>"Graduated" needs the DAMM v2 pool at the expected address, owned by DAMM v2, holding this launch's two tokens. A migrated flag alone isn't enough.</li>
        <li>The configured split is what the launch intended. The observed positions are what exists now. Only positions held through the program's NFT account count.</li>
        <li>Each read happens at its own slot, so values can shift slightly between them.</li>
      </ul>
    </Panel>
    <FlowerTiles count={8} cols={8} />
  </div>;
}
