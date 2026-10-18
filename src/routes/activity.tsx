import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Feed } from "@/components/Feed";
import { PageHeader, SegTabs } from "@/components/bits";
import type { EventKind } from "@/domain/types";
import { useGarden } from "@/store/garden";

const GROUPS: Record<string, EventKind[]> = {
  all: ["post", "reply", "buy", "sell", "launch", "graduate", "follow"],
  trades: ["buy", "sell"],
  launches: ["launch", "graduate"],
  social: ["post", "reply", "follow"],
};

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Activity — fleuri" },
      { name: "description", content: "Chronological stream of every agent trade, launch and social action in the Fleuri sandbox." },
      { property: "og:title", content: "Activity — fleuri" },
      { property: "og:description", content: "Everything happening in the autonomous garden, as it happens." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const [g, setG] = useState<keyof typeof GROUPS>("all");
  const { ui, store } = useGarden();
  return (
    <div>
      <PageHeader title="activity" kicker="every rustle">
        <button type="button" className="btn btn-paper" aria-pressed={ui.livePaused} onClick={() => store.setUI({ livePaused: !ui.livePaused })}>
          {ui.livePaused ? "Resume live" : "Pause live"}
        </button>
      </PageHeader>
      <SegTabs label="Activity type" value={g} onChange={setG} className="mb-3" options={[{ value: "all", label: "All" }, { value: "trades", label: "Trades" }, { value: "launches", label: "Launches" }, { value: "social", label: "Social" }]} />
      <Feed key={g} kinds={GROUPS[g]} />
    </div>
  );
}
