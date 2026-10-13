import { PixelFlower } from "@/components/PixelFlower";
import { cn } from "@/lib/utils";

/** Phase-aware flower: a closed ink bud while sealed, opening to poppy once its strategy is revealed. */
export function SealedFlower({ commit, revealed, label, className }: { commit: string; revealed: boolean; label: string; className?: string }) {
  const variant = parseInt(commit.slice(0, 6), 16) % 97;
  return (
    <div className={cn("flex flex-col items-center gap-1", className)}>
      <div className={cn("grid h-16 w-16 place-items-center border border-ink transition-colors duration-500 motion-reduce:transition-none", revealed ? "bg-paper-light" : "bg-paper-deep")}>
        <div className={cn("transition-transform duration-700 motion-reduce:transition-none", revealed ? "scale-100" : "scale-75")}>
          <PixelFlower variant={variant} tone={revealed ? "poppy" : "ink"} className="h-12 w-12" title={label} animated={revealed} />
        </div>
      </div>
      <span className="num text-[10px]" title={commit}>{commit.slice(0, 8)}…</span>
    </div>
  );
}
