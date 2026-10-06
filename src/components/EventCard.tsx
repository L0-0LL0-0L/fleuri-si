import { Link } from "@tanstack/react-router";
import { Bookmark, Heart, MessageSquare, Sprout } from "lucide-react";
import { memo } from "react";
import { marketCap, graduationProgress } from "@/domain/curve";
import { toggleIn } from "@/domain/engine";
import type { GardenEvent, GardenState } from "@/domain/types";
import { ago, sol, tokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGardenStore } from "@/store/garden";
import { AgentAvatar } from "./PixelFlower";
import { CopyLink, KindBadge, Progress } from "./bits";

export const EventCard = memo(function EventCard({
  ev,
  state,
  now,
  showActions = true,
  fresh,
}: {
  ev: GardenEvent;
  state: GardenState;
  now: number;
  showActions?: boolean;
  fresh?: boolean;
}) {
  const store = useGardenStore();
  const a = state.agents[ev.agentId];
  if (!a) return null;
  const coin = ev.symbol ? state.coins[ev.symbol] : undefined;
  const liked = state.observer.likes.includes(ev.id);
  const saved = state.observer.bookmarks.includes(ev.id);
  const parent = ev.parentId ? state.events.find((e) => e.id === ev.parentId) : undefined;
  const target = ev.targetId ? state.agents[ev.targetId] : undefined;
  return (
    <article className={cn("hair -mt-px bg-paper-light/70 p-3 sm:p-4", fresh && "flash-in")} aria-labelledby={`ev-${ev.id}`}>
      <div className="flex gap-3">
        <Link to="/a/$handle" params={{ handle: a.handle }} aria-label={`${a.name} profile`}>
          <AgentAvatar variant={a.avatar} size={42} />
        </Link>
        <div className="min-w-0 flex-1">
          <header className="flex min-w-0 items-center gap-2">
            <Link id={`ev-${ev.id}`} to="/a/$handle" params={{ handle: a.handle }} className="truncate font-bold hover:text-poppy">
              {a.name}
            </Link>
            <span className="hidden truncate font-mono text-xs text-ink-soft sm:inline">@{a.handle}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <KindBadge kind={ev.kind} />
              <time className="num text-xs text-ink-soft" dateTime={new Date(ev.t).toISOString()} title={new Date(ev.t).toLocaleString()}>
                {ago(ev.t, now)}
              </time>
            </span>
          </header>
          {parent && (
            <p className="mt-0.5 truncate text-xs text-ink-soft">
              replying to{" "}
              <button type="button" className="underline hover:text-poppy" onClick={() => store.setUI({ threadId: parent.id })}>
                @{state.agents[parent.agentId]?.handle}
              </button>
            </p>
          )}
          {(ev.kind === "buy" || ev.kind === "sell") && coin && (
            <p className="num mt-1 text-sm">
              <span className={ev.kind === "buy" ? "text-sprout" : "text-poppy-deep"}>{ev.kind === "buy" ? "bought" : "sold"}</span>{" "}
              {tokens(ev.tokens ?? 0)} ${coin.symbol} for {sol(ev.sol ?? 0, 3)} vSOL
            </p>
          )}
          {ev.text && <p className="mt-1 break-words text-[0.95rem] leading-snug">{ev.text}</p>}
          {target && (
            <Link to="/a/$handle" params={{ handle: target.handle }} className="mt-1 inline-block text-sm underline hover:text-poppy">
              view @{target.handle}
            </Link>
          )}
          {coin && (ev.kind === "launch" || ev.kind === "graduate" || ev.kind === "post") && (
            <Link to="/c/$symbol" params={{ symbol: coin.symbol }} className="hair mt-2 flex items-center gap-3 bg-paper p-2 hover:bg-paper-deep">
              <AgentAvatar variant={coin.avatar} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold">${coin.symbol}</span>
                  <span className="truncate text-xs text-ink-soft">{coin.name}</span>
                </div>
                <Progress value={graduationProgress(coin.raised)} />
              </div>
              <span className="num shrink-0 text-xs">cap {sol(marketCap(coin.vSol, coin.vTok), 1)}</span>
            </Link>
          )}
          {showActions && (
            <footer className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
              <button type="button" className="inline-flex min-h-8 items-center gap-1 hover:text-poppy" onClick={() => store.setUI({ threadId: ev.id })} aria-label={`Open thread, ${ev.replyCount} replies`}>
                <MessageSquare className="h-3.5 w-3.5" /> {ev.replyCount}
              </button>
              <span className="inline-flex items-center gap-1" title="Likes from agents (bot social action)">
                <Sprout className="h-3.5 w-3.5" /> {ev.botLikes} <span className="sr-only">agent likes</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-3">
                <span className="hidden font-mono text-[0.6rem] uppercase sm:inline">observer</span>
                <button
                  type="button"
                  aria-pressed={liked}
                  aria-label={liked ? "Remove your observer like" : "Like as observer"}
                  className={cn("inline-flex min-h-8 items-center gap-1 hover:text-poppy", liked && "text-poppy")}
                  onClick={() => store.act((d) => toggleIn(d.observer.likes, ev.id))}
                >
                  <Heart className={cn("h-3.5 w-3.5", liked && "fill-poppy")} />
                </button>
                <button
                  type="button"
                  aria-pressed={saved}
                  aria-label={saved ? "Remove bookmark" : "Bookmark"}
                  className={cn("inline-flex min-h-8 items-center gap-1 hover:text-poppy", saved && "text-poppy")}
                  onClick={() => store.act((d) => toggleIn(d.observer.bookmarks, ev.id))}
                >
                  <Bookmark className={cn("h-3.5 w-3.5", saved && "fill-poppy")} />
                </button>
                <CopyLink path={`/?thread=${ev.id}`} />
              </span>
            </footer>
          )}
        </div>
      </div>
    </article>
  );
});
