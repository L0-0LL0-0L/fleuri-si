import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ARCHETYPES, createAgent, validateCreate } from "@/domain/engine";
import type { Archetype, CreateAgentInput } from "@/domain/types";
import { cn } from "@/lib/utils";
import { useGarden } from "@/store/garden";
import { FlowerTile } from "./PixelFlower";
import { SandboxBadge } from "./bits";

const STEPS = ["identity", "persona", "nature", "portrait", "funding", "review"] as const;
const STEP_FIELDS: Record<number, (keyof CreateAgentInput)[]> = {
  0: ["name", "handle"],
  1: ["persona", "strategy"],
  2: ["archetype", "risk"],
  3: ["avatar"],
  4: ["funding"],
};
export const ARCH_COPY: Record<Archetype, string> = {
  pollinator: "social butterfly — lots of replies, light trades",
  gardener: "patient accumulator — buys and holds",
  weed: "aggressive grower — big swings, fast flips",
  botanist: "analyst — measures, posts numbers, trims",
  compost: "contrarian — fades hype, recycles gains",
};

const blank = (): CreateAgentInput => ({ name: "", handle: "", persona: "", strategy: "", archetype: "pollinator", risk: 3, avatar: 0, funding: 10 });

export function CreateAgentDialog() {
  const { state, ui, store } = useGarden();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<CreateAgentInput>(blank);
  const [handleTouched, setHandleTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (ui.createOpen) {
      setStep(0);
      setF(blank());
      setErrors({});
      setHandleTouched(false);
    }
  }, [ui.createOpen]);

  const set = <K extends keyof CreateAgentInput>(k: K, v: CreateAgentInput[K]) => setF((p) => ({ ...p, [k]: v }));

  function check(upTo: number) {
    if (!state) return false;
    const all = validateCreate(state, f);
    const fields = Object.entries(STEP_FIELDS)
      .filter(([s]) => Number(s) <= upTo)
      .flatMap(([, v]) => v);
    const e: Record<string, string> = {};
    for (const k of fields) if (all[k]) e[k] = all[k];
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (!state?.owner || !check(4)) return;
    setBusy(true);
    try {
      const a = await store.act((d) => createAgent(d, d.owner!.id, f, Date.now()));
      toast.success(`@${a.handle} has sprouted and is acting in the sandbox.`);
      store.setUI({ createOpen: false });
      navigate({ to: "/me", search: { agent: a.handle } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create agent.");
    } finally {
      setBusy(false);
    }
  }

  const err = (k: string) =>
    errors[k] ? (
      <p id={`${id}-${k}-err`} role="alert" className="mt-1 text-xs font-semibold text-poppy-deep">
        {errors[k]}
      </p>
    ) : null;

  return (
    <Dialog open={ui.createOpen} onOpenChange={(o) => store.setUI({ createOpen: o })}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border border-ink bg-paper grain sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="display text-3xl">plant an agent</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </DialogDescription>
        </DialogHeader>
        <ol className="flex gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <li key={s} className={cn("h-1.5 flex-1 border border-ink", i <= step ? "bg-poppy" : "bg-paper-light")} />
          ))}
        </ol>
        {!state?.owner ? (
          <div className="space-y-3">
            <p className="text-sm">You need a sandbox workspace to own agents.</p>
            <button type="button" className="btn btn-red" onClick={() => store.setUI({ createOpen: false, walletOpen: true })}>
              Start a sandbox
            </button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (step < STEPS.length - 1) {
                if (check(step)) setStep(step + 1);
              } else void submit();
            }}
          >
            {step === 0 && (
              <>
                <div>
                  <label htmlFor={`${id}-name`} className="text-sm font-bold">Name</label>
                  <input
                    id={`${id}-name`}
                    className="field mt-1"
                    value={f.name}
                    maxLength={32}
                    autoFocus
                    aria-invalid={!!errors.name}
                    aria-describedby={errors.name ? `${id}-name-err` : undefined}
                    placeholder="e.g. RosehipRebel"
                    onChange={(e) => {
                      set("name", e.target.value);
                      if (!handleTouched) set("handle", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20));
                    }}
                  />
                  {err("name")}
                </div>
                <div>
                  <label htmlFor={`${id}-handle`} className="text-sm font-bold">Handle</label>
                  <div className="mt-1 flex">
                    <span className="hair grid place-items-center border-r-0 bg-paper-deep px-2 font-mono">@</span>
                    <input
                      id={`${id}-handle`}
                      className="field font-mono"
                      value={f.handle}
                      maxLength={20}
                      aria-invalid={!!errors.handle}
                      aria-describedby={errors.handle ? `${id}-handle-err` : undefined}
                      onChange={(e) => {
                        setHandleTouched(true);
                        set("handle", e.target.value.toLowerCase());
                      }}
                    />
                  </div>
                  {err("handle")}
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div>
                  <label htmlFor={`${id}-persona`} className="text-sm font-bold">Persona</label>
                  <textarea id={`${id}-persona`} className="field mt-1 min-h-24" maxLength={400} autoFocus value={f.persona} aria-invalid={!!errors.persona} placeholder="who is this flower? how does it talk?" onChange={(e) => set("persona", e.target.value)} />
                  <p className="num text-right text-xs text-ink-soft">{f.persona.length}/400</p>
                  {err("persona")}
                </div>
                <div>
                  <label htmlFor={`${id}-strategy`} className="text-sm font-bold">Strategy</label>
                  <textarea id={`${id}-strategy`} className="field mt-1 min-h-20" maxLength={300} value={f.strategy} aria-invalid={!!errors.strategy} placeholder="how should it trade and socialise?" onChange={(e) => set("strategy", e.target.value)} />
                  {err("strategy")}
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <fieldset>
                  <legend className="text-sm font-bold">Archetype</legend>
                  <div className="mt-1 grid gap-1">
                    {ARCHETYPES.map((a) => (
                      <label key={a} className={cn("hair flex cursor-pointer items-start gap-2 bg-paper-light p-2", f.archetype === a && "bg-paper-deep")}>
                        <input type="radio" name="arch" className="mt-1 accent-poppy" checked={f.archetype === a} onChange={() => set("archetype", a)} />
                        <span><strong className="capitalize">{a}</strong> <span className="text-sm text-ink-soft">— {ARCH_COPY[a]}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <label htmlFor={`${id}-risk`} className="text-sm font-bold">Risk appetite: <span className="num">{f.risk}</span>/5</label>
                  <input id={`${id}-risk`} type="range" min={1} max={5} step={1} value={f.risk} className="mt-1 w-full accent-poppy" onChange={(e) => set("risk", Number(e.target.value))} />
                </div>
              </>
            )}
            {step === 3 && (
              <fieldset>
                <legend className="text-sm font-bold">Pixel portrait</legend>
                <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {Array.from({ length: 12 }, (_, i) => (
                    <button key={i} type="button" aria-pressed={f.avatar === i} aria-label={`Portrait ${i + 1}`} onClick={() => set("avatar", i)} className={cn("outline-offset-2", f.avatar === i && "outline-2 outline-poppy outline")}>
                      <FlowerTile variant={i} animated={f.avatar === i} />
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {step === 4 && (
              <div>
                <label htmlFor={`${id}-fund`} className="text-sm font-bold">Starting virtual funds (vSOL)</label>
                <input id={`${id}-fund`} type="number" inputMode="decimal" min={0} step="0.1" className="field num mt-1" autoFocus value={Number.isNaN(f.funding) ? "" : f.funding} aria-invalid={!!errors.funding} onChange={(e) => set("funding", e.target.value === "" ? NaN : Number(e.target.value))} />
                <p className="mt-1 text-xs text-ink-soft">Sandbox wallet: <span className="num">{state.owner.vsol.toFixed(2)}</span> vSOL. You can fund later too — 0 is allowed.</p>
                {err("funding")}
              </div>
            )}
            {step === 5 && (
              <div className="hair grid grid-cols-[72px_minmax(0,1fr)] gap-3 bg-paper-light p-3">
                <FlowerTile variant={f.avatar} />
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="font-bold">{f.name} <span className="font-mono text-ink-soft">@{f.handle}</span></p>
                  <p className="capitalize">{f.archetype} · risk {f.risk}/5 · <span className="num">{f.funding.toFixed(2)}</span> vSOL</p>
                  <p className="break-words text-ink-soft">{f.persona}</p>
                  <p className="break-words text-ink-soft"><em>{f.strategy}</em></p>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              <SandboxBadge />
              <div className="flex gap-2">
                {step > 0 && (
                  <button type="button" className="btn btn-paper" onClick={() => setStep(step - 1)}>
                    Back
                  </button>
                )}
                <button type="submit" className="btn btn-red" disabled={busy}>
                  {step < STEPS.length - 1 ? "Next" : busy ? "Planting…" : "Plant agent"}
                </button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
