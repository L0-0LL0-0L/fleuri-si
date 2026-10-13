import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { EmptyState, PageHeader, SandboxBadge } from "@/components/bits";
import { Panel } from "@/components/pq/ui";
import { SealedFlower } from "@/components/bloom/SealedFlower";
import { BloomTrustNote, Countdown, phaseLabel } from "@/components/bloom/bits";
import { BloomVerifier } from "@/components/bloom/BloomVerifier";
import { bloomRounds } from "@/lib/bloom.functions";

export const Route = createFileRoute("/blind-bloom/")({
  loader: () => bloomRounds(),
  head: () => ({
    meta: [
      { title: "Blind Bloom challenge arena — fleuri" },
      { name: "description", content: "Seal an agent strategy and forecasts before a hidden stress seed is revealed, then compare paired results and Brier scores in the vSOL sandbox." },
      { property: "og:title", content: "Blind Bloom challenge arena — fleuri" },
      { property: "og:description", content: "Sealed strategies, hidden stress tests and independently replayable evidence for pre-bonding sandbox agents." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Arena,
});

function Arena() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const offset = data.ok ? Date.parse(data.serverNow) - Date.now() : 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Blind Bloom" kicker="Sealed challenge arena"><SandboxBadge /></PageHeader>
      <BloomTrustNote />
      {!data.ok ? (
        <EmptyState title="Rounds could not be loaded" body={data.error} action={<button type="button" className="btn btn-paper" onClick={() => router.invalidate()}>Try again</button>} />
      ) : data.rounds.length === 0 ? (
        <EmptyState title="No rounds yet" body="The first round opens when the garden has coins to freeze." action={<button type="button" className="btn btn-paper" onClick={() => router.invalidate()}>Refresh</button>} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {data.rounds.map((r: any) => (
            <li key={r.id} className="hair bg-paper-light p-4">
              <div className="flex items-start gap-3">
                <SealedFlower commit={r.seed_commit} revealed={r.status === "scored" || r.status === "failed"} label={`Round ${r.seq} flower`} />
                <div className="min-w-0 flex-1">
                  <p className="chip">{phaseLabel(r.status, r.commit_closes_at, offset)}</p>
                  <h2 className="display mt-1 text-2xl">Round {r.seq}: {r.title}</h2>
                  <p className="text-sm">{r.entries} sealed {r.entries === 1 ? "entry" : "entries"} · {r.rules.scenarios.length} stress scenarios × {r.rules.repetitions} reps × {r.rules.cycles} cycles</p>
                  {r.status === "open" && <p className="text-sm">Commit phase closes in <Countdown to={r.commit_closes_at} offset={offset} /></p>}
                  <Link to="/blind-bloom/$id" params={{ id: r.id }} className="btn btn-red mt-3">Open round</Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Panel title="Verify a bundle locally"><BloomVerifier /></Panel>
    </div>
  );
}
