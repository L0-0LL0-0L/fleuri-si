import { useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ARCHETYPES } from "@/domain/engine";
import type { GardenCommand } from "@/lib/garden.functions";
import type { Agent, Archetype } from "@/domain/types";
import { tokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";
import { FlowerTile } from "./PixelFlower";

function useRun() {
  const { store } = useGarden();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (c: GardenCommand, ok?: string) => {
    setError(null);
    setBusy(true);
    try {
      const r = await store.cmd(c);
      toast.success(ok ?? r.message);
      return true;
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong.";
      setError(m);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, setError, busy };
}

export function OwnerControls({ agent }: { agent: Agent }) {
  const { state } = useGarden();
  const { run, error, busy } = useRun();
  const [amount, setAmount] = useState("5");
  const id = useId();
  const owner = state!.owner!;
  const amt = Number(amount);
  const archived = agent.status === "archived";
  // One request id per bonus attempt, reused on retry so a lost reply never spends twice; cleared after success.
  const bonusReq = useRef<{ agentId: string; id: string } | null>(null);
  const bonus = async () => {
    if (bonusReq.current?.agentId !== agent.id) bonusReq.current = { agentId: agent.id, id: crypto.randomUUID() };
    if (await run({ type: "bonus", agentId: agent.id, useAi: true, requestId: bonusReq.current.id })) bonusReq.current = null;
  };
  return (
    <section className="hair space-y-3 bg-paper-light p-3" aria-label="Owner controls">
      <div className="flex flex-wrap gap-2">
        {agent.status === "active" && (
          <button className="btn btn-paper" type="button" onClick={() => run({ type: "status", agentId: agent.id, status: "paused" }, `@${agent.handle} paused.`)}>
            Pause
          </button>
        )}
        {agent.status === "paused" && (
          <button className="btn btn-ink" type="button" onClick={() => run({ type: "status", agentId: agent.id, status: "active" }, `@${agent.handle} resumed.`)}>
            Resume
          </button>
        )}
        <button
          className="btn btn-red"
          type="button"
          disabled={agent.status !== "active" || busy}
          title={agent.status !== "active" ? "Resume the agent to run a cycle" : "Runs one server-side cycle using Lovable AI (falls back to rules-based simulation if AI is unavailable). Free and unlimited, with a 5-second cooldown."}
          onClick={() => run({ type: "run", agentId: agent.id, useAi: true })}
        >
          {busy ? "Thinking…" : "Run a cycle"}
        </button>
        <button className="btn btn-paper" type="button" disabled={agent.status !== "active" || busy} title="Pollen Access: runs one extra cycle right away, even inside the 5-second cooldown. Uses one bonus cycle from your wallet's daily allowance." onClick={() => void bonus()}>
          Bonus cycle
        </button>
        {!archived && <EditAgent agent={agent} />}
        {archived ? (
          <button className="btn btn-paper" type="button" onClick={() => run({ type: "status", agentId: agent.id, status: "paused" }, "Restored (paused).")}>
            Restore
          </button>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button className="btn btn-paper" type="button">Archive</button>
            </AlertDialogTrigger>
            <AlertDialogContent className="border border-ink bg-paper">
              <AlertDialogHeader>
                <AlertDialogTitle className="display text-2xl">archive @{agent.handle}?</AlertDialogTitle>
                <AlertDialogDescription>It stops acting and leaves the directory. Holdings and history are kept, and you can restore it anytime.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="btn btn-paper">Keep growing</AlertDialogCancel>
                <AlertDialogAction className="btn btn-red" onClick={() => run({ type: "status", agentId: agent.id, status: "archived" }, "Archived. Restore anytime.")}>
                  Archive
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <form
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label htmlFor={`${id}-amt`} className="font-mono text-xs uppercase">amount (vSOL)</label>
          <input id={`${id}-amt`} type="number" inputMode="decimal" step="0.1" min="0" className="field num" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <button type="button" className="btn btn-ink" disabled={archived} onClick={() => run({ type: "fund", agentId: agent.id, amount: amt })}>
          Fund
        </button>
        <button type="button" className="btn btn-paper" onClick={() => run({ type: "withdraw", agentId: agent.id, amount: amt })}>
          Withdraw
        </button>
      </form>
      <p className="num text-xs text-ink-soft">wallet {owner.vsol.toFixed(2)} vSOL · agent cash {agent.cash.toFixed(4)} vSOL</p>
      <ManualTrade agent={agent} />
      {error && <p role="alert" className="text-sm font-semibold text-poppy-deep">{error}</p>}
      <p className="text-xs text-ink-soft">Bonus cycles come with <Link to="/access" className="underline">Pollen Access</Link>. Run a cycle stays free.</p>
    </section>
  );
}

function ManualTrade({ agent }: { agent: Agent }) {
  const { state } = useGarden();
  const { run, error } = useRun();
  const symbols = Object.keys(state!.coins).sort();
  const [sym, setSym] = useState(symbols[0] ?? "");
  const [size, setSize] = useState("0.5");
  const [frac, setFrac] = useState("50");
  const id = useId();
  const held = agent.holdings[sym]?.amount ?? 0;
  return (
    <details className="hair bg-paper p-2">
      <summary className="font-bold">Direct a sandbox trade</summary>
      <p className="mt-1 text-xs text-ink-soft">Humans cannot trade ungraduated seeds directly — you instruct your agent, and it executes a simulated trade on the curve.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-sym`} className="font-mono text-xs uppercase">coin</label>
          <select id={`${id}-sym`} className="field" value={sym} onChange={(e) => setSym(e.target.value)}>
            {symbols.map((s) => (
              <option key={s} value={s}>${s}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-size`} className="font-mono text-xs uppercase">buy vSOL</label>
          <div className="flex">
            <input id={`${id}-size`} type="number" step="0.01" min="0" className="field num" value={size} onChange={(e) => setSize(e.target.value)} />
            <button type="button" className="btn btn-ink ml-1" onClick={() => run({ type: "buy", agentId: agent.id, symbol: sym, amount: Number(size) })}>
              Buy
            </button>
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-frac`} className="font-mono text-xs uppercase">sell % (holds {tokens(held)})</label>
          <div className="flex">
            <input id={`${id}-frac`} type="number" min="1" max="100" className="field num" value={frac} onChange={(e) => setFrac(e.target.value)} />
            <button type="button" className="btn btn-paper ml-1" onClick={() => run({ type: "sell", agentId: agent.id, symbol: sym, fraction: Number(frac) / 100 })}>
              Sell
            </button>
          </div>
        </div>
      </div>
      {error && <p role="alert" className="mt-1 text-sm font-semibold text-poppy-deep">{error}</p>}
    </details>
  );
}

function EditAgent({ agent }: { agent: Agent }) {
  const { state } = useGarden();
  const { run, error } = useRun();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: agent.name, persona: agent.persona, strategy: agent.strategy, risk: agent.risk, archetype: agent.archetype, avatar: agent.avatar });
  const id = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setF({ name: agent.name, persona: agent.persona, strategy: agent.strategy, risk: agent.risk, archetype: agent.archetype, avatar: agent.avatar });
      }}
    >
      <DialogTrigger asChild>
        <button className="btn btn-paper" type="button">Edit</button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto border border-ink bg-paper sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="display text-2xl">re-pot @{agent.handle}</DialogTitle>
          <DialogDescription>Changes apply from its next cycle.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run({ type: "update", agentId: agent.id, patch: f })) setOpen(false);
          }}
        >
          <label className="block text-sm font-bold" htmlFor={`${id}-n`}>Name</label>
          <input id={`${id}-n`} className="field" value={f.name} maxLength={32} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <label className="block text-sm font-bold" htmlFor={`${id}-p`}>Persona</label>
          <textarea id={`${id}-p`} className="field min-h-20" value={f.persona} maxLength={400} onChange={(e) => setF({ ...f, persona: e.target.value })} />
          <label className="block text-sm font-bold" htmlFor={`${id}-s`}>Strategy</label>
          <textarea id={`${id}-s`} className="field min-h-16" value={f.strategy} maxLength={300} onChange={(e) => setF({ ...f, strategy: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-bold" htmlFor={`${id}-a`}>Archetype</label>
              <select id={`${id}-a`} className="field capitalize" value={f.archetype} onChange={(e) => setF({ ...f, archetype: e.target.value as Archetype })}>
                {ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold" htmlFor={`${id}-r`}>Risk {f.risk}/5</label>
              <input id={`${id}-r`} type="range" min={1} max={5} className="w-full accent-poppy" value={f.risk} onChange={(e) => setF({ ...f, risk: Number(e.target.value) })} />
            </div>
          </div>
          <div className="grid grid-cols-6 gap-1">
            {Array.from({ length: 12 }, (_, i) => (
              <button key={i} type="button" aria-label={`Portrait ${i + 1}`} aria-pressed={f.avatar === i} onClick={() => setF({ ...f, avatar: i })} className={cn(f.avatar === i && "outline-2 outline-poppy outline")}>
                <FlowerTile variant={i} animated={false} />
              </button>
            ))}
          </div>
          {error && <p role="alert" className="text-sm font-semibold text-poppy-deep">{error}</p>}
          <button type="submit" className="btn btn-red w-full">Save changes</button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
