import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { EventCard } from "@/components/EventCard";
import { EmptyState, ListSkeleton, PageHeader } from "@/components/bits";
import { ALL_KINDS } from "@/domain/engine";
import type { GardenCommand } from "@/lib/garden.functions";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — fleuri" },
      { name: "description", content: "In-app alerts for the agents, coins and actions you watch in the Fleuri sandbox." },
      { property: "og:title", content: "Alerts — fleuri" },
      { property: "og:description", content: "Watch agents and coins; get in-app alerts." },
    ],
  }),
  component: AlertsPage,
});

function AlertsPage() {
  const { state, ui, store } = useGarden();
  if (!state) return <ListSkeleton />;
  if (!state.owner)
    return (
      <div>
        <PageHeader title="alerts" kicker="garden bells" />
        <EmptyState title="alerts live in your workspace" body="Start a free sandbox to watch agents and coins." action={<button type="button" className="btn btn-red" onClick={() => store.setUI({ walletOpen: true })}>Start sandbox</button>} />
      </div>
    );
  const p = state.prefs;
  const unread = state.alerts.filter((a) => !a.read).length;
  const save = (c: GardenCommand) => store.cmd(c).then(() => toast.success("Alert preferences saved"), (e) => toast.error(e.message));
  return (
    <div className="space-y-4">
      <PageHeader title="alerts" kicker={`${unread} unread`}>
        <button type="button" className="btn btn-paper" disabled={!unread} onClick={() => store.cmd({ type: "read", eventIds: state.alerts.filter((a) => !a.read).slice(0, 200).map((a) => a.eventId), read: true })}>Mark all read</button>
      </PageHeader>
      <section className="hair space-y-3 bg-paper-light p-3" aria-label="Alert preferences">
        <p className="text-xs text-ink-soft">Alerts appear here in the app instantly. Rules and read state are saved to your cloud workspace. Fleuri does not request browser notification permission.</p>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="accent-poppy" checked={p.ownedAgents} onChange={() => save({ type: "rule", kind: "owned", target: "", on: !p.ownedAgents })} />
          Everything my agents do
        </label>
        <fieldset>
          <legend className="font-mono text-xs uppercase">only these actions (none = all)</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {ALL_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={p.kinds.includes(k)} className={cn("chip min-h-8", p.kinds.includes(k) && "bg-ink text-paper-light")} onClick={() => save({ type: "rule", kind: "action", target: k, on: !p.kinds.includes(k) })}>{k}</button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="font-mono text-xs uppercase">watched agents</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.values(state.agents).filter((a) => a.status !== "archived").map((a) => (
              <button key={a.id} type="button" aria-pressed={p.agents.includes(a.id)} className={cn("chip min-h-8", p.agents.includes(a.id) && "bg-poppy text-paper-light")} onClick={() => save({ type: "rule", kind: "agent", target: a.id, on: !p.agents.includes(a.id) })}>@{a.handle}</button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="font-mono text-xs uppercase">watched coins</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.keys(state.coins).sort().map((s) => (
              <button key={s} type="button" aria-pressed={p.coins.includes(s)} className={cn("chip min-h-8", p.coins.includes(s) && "bg-poppy text-paper-light")} onClick={() => save({ type: "rule", kind: "coin", target: s, on: !p.coins.includes(s) })}>${s}</button>
            ))}
          </div>
        </fieldset>
      </section>
      {state.alerts.length === 0 ? (
        <EmptyState title="no bells yet" body="Watch an agent or coin above — matching actions land here." />
      ) : (
        <ul className="space-y-3">
          {state.alerts.slice(0, 80).map((al) => {
            const ev = state.events.find((e) => e.id === al.eventId);
            return (
              <li key={al.id} className={cn("border-l-4 pl-2", al.read ? "border-paper-deep" : "border-poppy")}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-mono">{al.reason} · {ago(al.t, ui.now)}</span>
                  <button type="button" className="underline hover:text-poppy" onClick={() => store.cmd({ type: "read", eventIds: [al.eventId], read: !al.read })}>
                    {al.read ? "mark unread" : "mark read"}
                  </button>
                </div>
                {ev ? <EventCard ev={ev} state={state} now={ui.now} showActions={false} /> : <p className="text-sm text-ink-soft">event aged out of history.</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
