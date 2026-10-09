import { Link } from "@tanstack/react-router";
import type { Coin, GardenState } from "@/domain/types";
import type { coinStats } from "@/domain/selectors";
import { ago, pct, signedPct, sol } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./PixelFlower";
import { Progress } from "./bits";
import { Sparkline } from "./charts";

export function CoinCard({ c, st, state, now }: { c: Coin; st: ReturnType<typeof coinStats>; state: GardenState; now: number }) {
  const creator = state.agents[c.creatorId];
  return (
    <Link to="/c/$symbol" params={{ symbol: c.symbol }} className="hair -mt-px -ml-px block min-w-0 bg-paper-light/70 p-3 transition-colors hover:bg-paper-light">
      <div className="flex items-start gap-3">
        <AgentAvatar variant={c.avatar} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="display text-xl">${c.symbol}</span>
            {c.graduated && <span className="chip bg-poppy text-paper-light">bloomed</span>}
            <span className={cn("num ml-auto text-xs", st.change24 >= 0 ? "text-sprout" : "text-poppy-deep")}>{signedPct(st.change24)}</span>
          </div>
          <p className="truncate text-sm">{c.name} · <span className="text-ink-soft">{c.tagline}</span></p>
          <p className="truncate text-xs text-ink-soft">by @{creator?.handle} · {ago(c.createdAt, now)} old</p>
        </div>
        <Sparkline points={c.history} className="hidden shrink-0 sm:block" />
      </div>
      <dl className="num mt-3 grid grid-cols-4 gap-2 text-[0.72rem]">
        <div><dt className="text-ink-soft">cap</dt><dd className="font-semibold">{sol(st.cap, 1)}</dd></div>
        <div><dt className="text-ink-soft">vol 24h</dt><dd className="font-semibold">{sol(st.vol24, 2)}</dd></div>
        <div><dt className="text-ink-soft">holders</dt><dd className="font-semibold">{st.holders}</dd></div>
        <div><dt className="text-ink-soft">fees</dt><dd className="font-semibold">{sol(c.fees, 3)}</dd></div>
        <div><dt className="text-ink-soft">buys/sells</dt><dd>{c.buys}/{c.sells}</dd></div>
        <div><dt className="text-ink-soft">creator</dt><dd>{pct(st.creatorPct)}</dd></div>
        <div><dt className="text-ink-soft">top 10</dt><dd>{pct(st.top10)}</dd></div>
        <div><dt className="text-ink-soft">to bloom</dt><dd>{c.graduated ? "done" : sol(st.toGraduate, 1)}</dd></div>
      </dl>
      <div className="mt-2 flex items-center gap-2">
        <Progress value={st.progress} label={`$${c.symbol} graduation progress`} />
        <span className="num w-10 shrink-0 text-right text-xs">{Math.round(st.progress * 100)}%</span>
      </div>
    </Link>
  );
}
