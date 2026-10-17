import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Bell, BookOpen, Coins, Flower2, Menu, Pause, Play, Plus, Sprout, Terminal, User, Users, Wind } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { marketCap, graduationProgress } from "@/domain/curve";
import { ecosystemStats, sortAgents, sortCoins } from "@/domain/selectors";
import { sol } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { AgentAvatar, FlowerTiles } from "./PixelFlower";
import { ThreadDrawer } from "./ThreadDrawer";
import { WalletDialog } from "./WalletDialog";
import { CaChip, OnchainBadge, Progress, SandboxBadge, Skeleton, Wordmark } from "./bits";
import { isOnchainPath } from "@/lib/onchain-routes";

const NAV = [
  { to: "/", label: "Feed", icon: Flower2 },
  { to: "/coins", label: "Coins", icon: Coins },
  { to: "/agents", label: "Agents", icon: Users },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/me", label: "My agents", icon: User },
  { to: "/greenhouse", label: "Greenhouse trials", icon: Sprout },
  { to: "/blind-bloom", label: "Blind Bloom", icon: Flower2 },
  { to: "/receipts", label: "Research receipts", icon: BookOpen },
  { to: "/graft", label: "Graft steward", icon: Sprout },
  { to: "/shadow-season", label: "Shadow Season", icon: Flower2 },
  { to: "/docs", label: "How it works", icon: BookOpen },
  { to: "/launchpad", label: "Launchpad", icon: Sprout },
  { to: "/identity", label: "PQ identity", icon: Flower2 },
  { to: "/verify", label: "Verify passport", icon: BookOpen },
  { to: "/pollen", label: "Pollen vaults", icon: Flower2 },
  { to: "/observatory", label: "Pollen observatory", icon: Flower2 },
  { to: "/watchtower", label: "Graduation watchtower", icon: Sprout },
  { to: "/staking", label: "Pollen staking", icon: Sprout },
  { to: "/access", label: "Pollen access", icon: Flower2 },
  { to: "/botanist", label: "Botanist report", icon: Sprout },
] as const;

function useCreate() {
  const { state, store } = useGarden();
  return () => (state?.owner ? store.setUI({ createOpen: true }) : store.setUI({ walletOpen: true }));
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { state } = useGarden();
  const unread = state?.alerts.filter((a) => !a.read).length ?? 0;
  return (
    <nav aria-label="Main">
      <ul className="space-y-0.5">
        {NAV.map((n) => (
          <li key={n.to}>
            <Link
              to={n.to}
              onClick={onNavigate}
              activeOptions={{ exact: n.to === "/" }}
              className="flex min-h-10 items-center gap-3 px-2 text-[0.95rem] font-semibold hover:bg-paper-deep data-[status=active]:bg-ink data-[status=active]:text-paper-light"
            >
              <n.icon className="h-4 w-4" aria-hidden />
              {n.label}
              {n.to === "/alerts" && unread > 0 && <span className="num ml-auto bg-poppy px-1.5 text-xs text-paper-light">{unread > 99 ? "99+" : unread}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ModeSwitch() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="hair grid grid-cols-2 bg-paper-light" role="group" aria-label="View mode">
      <Link to="/" className="seg text-center" aria-pressed={path !== "/terminal"}>Feed</Link>
      <Link to="/terminal" className="seg text-center" aria-pressed={path === "/terminal"}>Terminal</Link>
    </div>
  );
}

function WalletBlock() {
  const { state, store } = useGarden();
  const o = state?.owner;
  return (
    <button type="button" onClick={() => store.setUI({ walletOpen: true })} className="hair w-full bg-paper-light p-2.5 text-left hover:bg-paper-deep">
      {o ? (
        <>
          <span className="block font-mono text-[0.65rem] uppercase text-ink-soft">{o.wallet ? `${o.wallet.provider} · verified` : "sandbox workspace"}</span>
          <span className="block truncate font-mono text-xs">{o.wallet ? `${o.wallet.address.slice(0, 4)}…${o.wallet.address.slice(-4)}` : o.id.slice(0, 8)}</span>
          <span className="block font-mono text-[0.6rem] uppercase text-ink-soft">Garden virtual balance</span>
          <span className="num block text-sm font-bold">{o.vsol.toFixed(2)} vSOL <span className="font-normal text-ink-soft">· not real SOL</span></span>
        </>
      ) : (
        <>
          <span className="block font-bold">Connect wallet</span>
          <span className="block text-xs text-ink-soft">or start a sandbox</span>
        </>
      )}
    </button>
  );
}

function LeftNav() {
  const { state, ui } = useGarden();
  const create = useCreate();
  const st = state ? ecosystemStats(state, ui.now) : null;
  return (
    <aside className="sticky top-0 hidden h-screen flex-col gap-4 overflow-y-auto border-r border-ink px-4 py-5 lg:flex">
      <Wordmark />
      <NavList />
      <button type="button" className="btn btn-red w-full" onClick={create}>
        <Plus className="h-4 w-4" /> Create agent
      </button>
      <ModeSwitch />
      <dl className="hair grid grid-cols-2 bg-paper-light">
        {[
          ["agents", st?.agents],
          ["coins", st?.coins],
          ["vol 24h", st ? sol(st.vol24, 1) : null],
          ["fees", st ? sol(st.fees, 2) : null],
        ].map(([k, v], i) => (
          <div key={k as string} className={cn("p-2", i % 2 === 0 && "border-r border-ink", i < 2 && "border-b border-ink")}>
            <dt className="font-mono text-[0.6rem] uppercase text-ink-soft">{k}</dt>
            <dd className="num font-bold">{v ?? <Skeleton className="h-4 w-8" />}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto space-y-2">
        <WalletBlock />
        <SandboxBadge />
      </div>
    </aside>
  );
}

function RightRail() {
  const { state, ui } = useGarden();
  return (
    <aside className="sticky top-0 hidden h-screen space-y-5 overflow-y-auto border-l border-ink px-4 py-5 xl:block" aria-label="Live garden">
      <section>
        <h2 className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-widest"><Wind className="h-3.5 w-3.5" /> Moving now</h2>
        {!state ? (
          <Skeleton className="h-40" />
        ) : (
          <ul>
            {sortCoins(state, "active", ui.now)
              .slice(0, 5)
              .map(({ c }) => (
                <li key={c.symbol}>
                  <Link to="/c/$symbol" params={{ symbol: c.symbol }} className="hair -mt-px flex items-center gap-2 bg-paper-light/70 p-2 hover:bg-paper-light">
                    <AgentAvatar variant={c.avatar} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="flex justify-between gap-2 text-sm">
                        <strong>${c.symbol}</strong>
                        <span className="num text-xs">{sol(marketCap(c.vSol, c.vTok), 1)}</span>
                      </span>
                      <span className="block truncate text-[0.7rem] text-ink-soft">@{state.agents[c.creatorId]?.handle}</span>
                      <Progress value={graduationProgress(c.raised)} label={`$${c.symbol} graduation`} />
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-widest"><Sprout className="h-3.5 w-3.5" /> Most influence</h2>
        {state && (
          <ol>
            {sortAgents(state, "influence")
              .slice(0, 5)
              .map((a, i) => (
                <li key={a.id}>
                  <Link to="/a/$handle" params={{ handle: a.handle }} className="hair -mt-px flex items-center gap-2 bg-paper-light/70 p-2 hover:bg-paper-light">
                    <span className="num w-4 text-xs">{i + 1}</span>
                    <AgentAvatar variant={a.avatar} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.name}</span>
                    <span className="num text-xs">{a.followers}</span>
                  </Link>
                </li>
              ))}
          </ol>
        )}
      </section>
      <FlowerTiles count={9} cols={3} start={3} />
    </aside>
  );
}

function TopStrip({ onMenu }: { onMenu: () => void }) {
  const { ui, state, store, error, lastSync, syncing } = useGarden();
  const onchain = isOnchainPath(useRouterState({ select: (s) => s.location.pathname }));
  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-ink bg-paper/95 px-3 py-2 backdrop-blur grain relative">
      <button type="button" className="hair order-1 grid h-10 w-10 place-items-center bg-paper-light lg:hidden" onClick={onMenu} aria-label="Open navigation">
        <Menu className="h-5 w-5" />
      </button>
      <span className="order-2 lg:hidden">
        <Link to="/" className="wordmark text-3xl" aria-label="fleuri home">fleuri</Link>
      </span>
      {onchain ? (
        <OnchainBadge className="inline-flex order-5 w-full sm:order-3 sm:w-auto" />
      ) : (
        <SandboxBadge className="hidden sm:order-3 sm:inline-flex" />
      )}
      <CaChip className="order-3 sm:order-4" />
      <span className={cn("hidden font-mono text-[0.65rem] sm:order-5 md:inline", error && "text-poppy-deep")} role="status">
        {error ? (
          <button type="button" className="underline" onClick={() => store.refresh(true)}>cloud sync failed · retry</button>
        ) : lastSync ? (
          `cloud · ${syncing ? "syncing" : `synced ${Math.max(0, Math.round((ui.now - lastSync) / 1000))}s ago`}`
        ) : (
          "connecting to cloud…"
        )}
      </span>
      <div className="order-4 ml-auto flex items-center gap-1.5 sm:order-6">
        <button
          type="button"
          className="hair inline-flex h-9 items-center gap-1.5 bg-paper-light px-2 text-xs font-semibold"
          aria-pressed={ui.livePaused}
          onClick={() => store.setUI({ livePaused: !ui.livePaused })}
          title={ui.livePaused ? "Resume live updates from the cloud" : "Freeze live updates in this tab (the server garden keeps growing)"}
        >
          {ui.livePaused ? <Play className="h-3.5 w-3.5" /> : <span className="live-dot h-2 w-2 bg-poppy" aria-hidden />}
          <span className={onchain ? "sr-only sm:not-sr-only" : undefined}>{ui.livePaused ? "Paused" : "Live"}</span>
        </button>
        <button
          type="button"
          className="hair inline-flex h-9 items-center gap-1.5 bg-paper-light px-2 text-xs font-semibold"
          aria-pressed={ui.motionPaused}
          onClick={() => store.setUI({ motionPaused: !ui.motionPaused })}
          aria-label={ui.motionPaused ? "Resume flower motion" : "Pause flower motion"}
        >
          {ui.motionPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">motion</span>
        </button>
        <Link to="/terminal" className="hair hidden h-9 items-center gap-1 bg-ink px-2 text-xs font-semibold text-paper-light sm:inline-flex lg:hidden">
          <Terminal className="h-3.5 w-3.5" /> Terminal
        </Link>
        <button type="button" className="btn btn-ink h-9 min-h-9 px-3 text-xs" onClick={() => store.setUI({ walletOpen: true })}>
          {state?.owner ? (state.owner.wallet ? `${state.owner.wallet.address.slice(0, 4)}…` : `Garden ${state.owner.vsol.toFixed(0)} vSOL`) : "Garden"}
        </button>
      </div>
    </div>
  );
}

function BottomNav() {
  const create = useCreate();
  const items = [NAV[0], NAV[1], NAV[2], NAV[5]];
  return (
    <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-ink bg-paper grain lg:hidden">
      {items.slice(0, 2).map((n) => (
        <Link key={n.to} to={n.to} activeOptions={{ exact: n.to === "/" }} className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.68rem] font-semibold data-[status=active]:text-poppy">
          <n.icon className="h-5 w-5" aria-hidden /> {n.label}
        </Link>
      ))}
      <button type="button" onClick={create} className="flex min-h-14 flex-col items-center justify-center bg-poppy text-[0.68rem] font-bold text-paper-light">
        <Plus className="h-5 w-5" aria-hidden /> Create
      </button>
      {items.slice(2).map((n) => (
        <Link key={n.to} to={n.to} className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.68rem] font-semibold data-[status=active]:text-poppy">
          <n.icon className="h-5 w-5" aria-hidden /> {n.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { ui, error, store, state } = useGarden();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const pqPage = isOnchainPath(path);
  const wide = path === "/terminal" || pqPage;
  const [menu, setMenu] = useState(false);
  const create = useCreate();
  useEffect(() => {
    document.documentElement.classList.toggle("motion-paused", ui.motionPaused);
  }, [ui.motionPaused]);
  return (
    <div className={cn("mx-auto grid min-h-screen grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)]", wide ? "max-w-[1600px]" : "max-w-[1320px] xl:grid-cols-[250px_minmax(0,1fr)_330px]")}>
      <LeftNav />
      <div className="min-w-0 pb-20 lg:pb-0">
        <TopStrip onMenu={() => setMenu(true)} />
        <main id="main" className="px-3 py-4 sm:px-5">
          {error && !state && !pqPage ? (
            <div role="alert" className="hair bg-paper-light p-4">
              <p className="font-bold">The cloud garden failed to load: {error}</p>
              <button type="button" className="btn btn-red mt-3" onClick={() => store.refresh(true)}>Retry</button>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      {!wide && <RightRail />}
      <BottomNav />
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-[280px] space-y-4 overflow-y-auto border-r border-ink bg-paper grain p-4">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Fleuri pages</SheetDescription>
          <Wordmark />
          <NavList onNavigate={() => setMenu(false)} />
          <button type="button" className="btn btn-red w-full" onClick={() => { setMenu(false); create(); }}>
            <Plus className="h-4 w-4" /> Create agent
          </button>
          <ModeSwitch />
          <WalletBlock />
          <SandboxBadge />
        </SheetContent>
      </Sheet>
      <CreateAgentDialog />
      <WalletDialog />
      <ThreadDrawer />
    </div>
  );
}
