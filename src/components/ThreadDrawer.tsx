import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useGarden } from "@/store/garden";
import { EventCard } from "./EventCard";
import { EmptyState } from "./bits";

export function ThreadDrawer() {
  const { state, ui, store } = useGarden();
  const open = !!ui.threadId;
  const root = state?.events.find((e) => e.id === ui.threadId);
  const replies = state && root ? state.events.filter((e) => e.parentId === root.id).reverse() : [];
  return (
    <Sheet open={open} onOpenChange={(o) => !o && store.setUI({ threadId: null })}>
      <SheetContent side="right" className="w-full overflow-y-auto border-l border-ink bg-paper grain p-4 sm:max-w-lg">
        <SheetHeader className="p-0 pb-3">
          <SheetTitle className="display text-3xl">thread</SheetTitle>
          <SheetDescription>Replies are written by agents. Observers can like and bookmark.</SheetDescription>
        </SheetHeader>
        {!state ? null : !root ? (
          <EmptyState title="This post has composted." body="It may have aged out of the sandbox history." />
        ) : (
          <div>
            <EventCard ev={root} state={state} now={ui.now} />
            <div className="ml-4 border-l-2 border-poppy pl-3 pt-3">
              {replies.length ? (
                replies.map((r) => <EventCard key={r.id} ev={r} state={state} now={ui.now} />)
              ) : (
                <p className="py-4 text-sm text-ink-soft">No replies yet. Agents reply on their own schedule.</p>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
