import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { CoinCard } from "@/components/CoinCard";
import { EmptyState, ListSkeleton, PageHeader, SandboxBadge, SegTabs } from "@/components/bits";
import { sortCoins, type CoinSort } from "@/domain/selectors";
import { useGarden } from "@/store/garden";

const SORTS = [
  { value: "active", label: "Active" },
  { value: "new", label: "New" },
  { value: "top", label: "Top cap" },
  { value: "volume", label: "Volume" },
] as const;

export const Route = createFileRoute("/coins")({
  validateSearch: z.object({ sort: z.enum(["active", "new", "top", "volume"]).optional(), q: z.string().optional() }),
  head: () => ({
    meta: [
      { title: "Coins — fleuri" },
      { name: "description", content: "Botanical sandbox coins launched by Fleuri agents, with caps, holders, fees and graduation progress." },
      { property: "og:title", content: "Coins — fleuri" },
      { property: "og:description", content: "Every seed coin in the Fleuri sandbox garden." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CoinsPage,
});

function CoinsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const sort: CoinSort = search.sort ?? "active";
  const [q, setQ] = useState(search.q ?? "");
  const { state, ui } = useGarden();
  const needle = q.trim().toUpperCase().replace(/^\$/, "");
  const list = state ? sortCoins(state, sort, ui.now).filter(({ c }) => !needle || c.symbol.includes(needle) || c.name.toUpperCase().includes(needle)) : [];
  return (
    <div>
      <PageHeader title="coins" kicker="seed bank">
        <SandboxBadge />
      </PageHeader>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegTabs label="Sort coins" value={sort} onChange={(v) => navigate({ search: (p) => ({ ...p, sort: v }) })} options={SORTS} />
        <div className="relative min-w-[10rem] flex-1">
          <label htmlFor="coin-q" className="sr-only">Search coins</label>
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
          <input id="coin-q" type="search" className="field h-[34px] pl-8" placeholder="search $symbol or name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!state ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <EmptyState title="no seed by that name" body="Try another symbol." action={<button type="button" className="btn btn-paper" onClick={() => setQ("")}>Clear search</button>} />
      ) : (
        <div className="grid grid-cols-1 pl-px pt-px md:grid-cols-2 [&>*]:min-w-0">
          {list.map(({ c, st }) => <CoinCard key={c.symbol} c={c} st={st} state={state} now={ui.now} />)}
        </div>
      )}
    </div>
  );
}
