import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/bits";
import { Panel, RealBadge } from "@/components/pq/ui";
import { getPqReadiness, pqPublicLaunches } from "@/lib/pq.functions";

export const Route = createFileRoute("/launchpad")({
  head: () => ({
    meta: [
      { title: "Launchpad — fleuri" },
      { name: "description", content: "Real Meteora DBC launches with ML-DSA-65 launch passports. Shows live readiness and confirmed launches." },
      { property: "og:title", content: "Launchpad — fleuri" },
      { property: "og:description", content: "Post-quantum launch provenance on Meteora, separate from the vSOL sandbox." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LaunchpadPage,
});

type Res = { ok: true; data: any } | { ok: false; error: string };

function LaunchpadPage() {
  const [ready, setReady] = useState<Res | null>(null);
  const [launches, setLaunches] = useState<Res | null>(null);
  useEffect(() => {
    getPqReadiness().then(setReady, (e) => setReady({ ok: false, error: String(e?.message ?? e) }));
    pqPublicLaunches().then(setLaunches, (e) => setLaunches({ ok: false, error: String(e?.message ?? e) }));
  }, []);
  const rd = ready?.ok ? ready.data : null;
  const problems: string[] = rd?.problems ?? rd?.missing ?? [];
  const isReady = !!rd && (rd.ready === true || rd.ok === true) && problems.length === 0;

  return (
    <div className="space-y-4">
      <PageHeader title="launchpad" kicker="real launches">
        <RealBadge cluster={rd?.cluster} />
      </PageHeader>
      <p className="max-w-prose text-sm">
        Real Meteora launches, separate from the vSOL garden. Each launch carries a passport signed by your PQ identity. This proves who launched and on what terms. It does not make Solana custody quantum-safe.
      </p>
      <Panel title="readiness">
        {!ready ? <p className="text-sm">Checking configuration…</p> : !ready.ok ? (
          <p role="alert" className="text-sm text-poppy-deep">Not ready: {ready.error}</p>
        ) : isReady ? (
          <p className="text-sm">Configuration validated. Launching starts from your <Link to="/identity" className="underline">PQ identity</Link>.</p>
        ) : (
          <>
            <p className="text-sm font-semibold">Real launches are not available yet.</p>
            {problems.length > 0 && <ul className="list-disc pl-5 text-sm">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </>
        )}
      </Panel>
      <Panel title="confirmed launches">
        {!launches ? <p className="text-sm">Loading…</p> : !launches.ok ? (
          <p role="alert" className="text-sm text-poppy-deep">{launches.error}</p>
        ) : launches.data.length === 0 ? (
          <p className="text-sm text-ink-soft">No confirmed launches yet.</p>
        ) : (
          <ul className="divide-y divide-ink/20">
            {launches.data.map((l: any) => {
              const p = Array.isArray(l.passports) ? l.passports[0] : l.passports;
              const hash: string | undefined = p?.manifest_hash;
              return (
                <li key={l.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 truncate"><strong>${p?.manifest?.token?.symbol ?? "?"}</strong> · {l.lifecycle} · {l.cluster}</span>
                  {hash && <Link to="/passport/$hash" params={{ hash }} className="underline">passport</Link>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <p className="text-sm"><Link to="/verify" className="underline">Verify any passport</Link></p>
    </div>
  );
}
