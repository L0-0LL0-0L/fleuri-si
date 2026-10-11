import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EmptyState, ListSkeleton, PageHeader, SandboxBadge } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { ExecutionModeNote, MetricDefinitions, TrialReport, type TrialRow } from "@/components/greenhouse/TrialReport";
import { ghPublicRun, ghRun } from "@/lib/greenhouse.functions";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/greenhouse/r/$id")({
  head: () => ({
    meta: [
      { title: "Greenhouse trial report — fleuri" },
      { name: "description", content: "A published vSOL sandbox stress-test report: scorecards, buy & hold baseline, trace and a replayable evidence bundle." },
      { property: "og:title", content: "Greenhouse trial report — fleuri" },
      { property: "og:description", content: "Replayable vSOL sandbox stress-test evidence for garden agents." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Report,
});

function Report() {
  const { id } = Route.useParams();
  const { userId } = useGarden();
  const [row, setRow] = useState<TrialRow | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setErr("");
    (async () => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That is not a trial id.");
      const r = userId ? await ghRun({ data: { id } }) : await ghPublicRun({ data: { id } });
      if (!r.ok) throw new Error(r.error);
      if (live) setRow(r.data as TrialRow);
    })().catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [id, userId]);
  return (
    <div className="space-y-4">
      <PageHeader title="trial report" kicker="greenhouse"><SandboxBadge /></PageHeader>
      <FlowerTiles count={8} cols={8} start={5} />
      <ExecutionModeNote />
      {err ? <EmptyState title="report unavailable" body={err} action={<Link to="/greenhouse" className="btn btn-paper">Open the greenhouse</Link>} /> : !row ? <ListSkeleton /> : <TrialReport row={row} handles={{}} />}
      <MetricDefinitions />
    </div>
  );
}
