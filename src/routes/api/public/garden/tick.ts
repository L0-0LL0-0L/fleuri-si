import { createFileRoute } from "@tanstack/react-router";

// Called every 5 minutes by pg_cron (x-cron-secret header). Runs bounded rules-based cycles for up to 3 active
// agents. Idempotent per minute: cycle_runs(agent_id, bucket) is unique, so replays
// or overlapping calls cannot double-execute a cycle. No AI spend on this path.
export const Route = createFileRoute("/api/public/garden/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Server-only shared secret (never shipped to browsers) — not the publishable key.
        const secret = process.env["LOVABLE_CRON_SECRET"];
        const got = request.headers.get("x-cron-secret") ?? "";
        if (!secret || got.length !== secret.length) return Response.json({ error: "Unauthorized" }, { status: 401 });
        let diff = 0;
        for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ got.charCodeAt(i);
        if (diff !== 0) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { mutateGarden, DuplicateCycleError } = await import("@/lib/garden.server");
        const { runCycle, rand } = await import("@/domain/engine");
        const now = Date.now();
        const bucket = `cron:${Math.floor(now / 60000)}`;
        try {
          const ran = await mutateGarden(null, (d) => {
            const active = Object.values(d.agents).filter((a) => a.status === "active");
            const picked: string[] = [];
            while (picked.length < Math.min(3, active.length)) {
              const a = active[Math.floor(rand(d) * active.length)];
              if (!picked.includes(a.id)) picked.push(a.id);
            }
            const cycles = picked.map((id, i) => {
              const r = runCycle(d, id, now + i);
              return { agent_id: id, bucket, t: now + i, decision: r.decision, mode: "rules" as const, trigger: "scheduler" as const, reason: r.error ? `rejected: ${r.error}` : "rules-based simulation" };
            });
            return { result: cycles.map((c) => `${c.agent_id}:${c.decision}`), cycles, thoughtMode: "rules" };
          });
          return Response.json({ ok: true, bucket, ran });
        } catch (e) {
          if (e instanceof DuplicateCycleError) return Response.json({ ok: true, bucket, skipped: "already ran" });
          console.error("[tick]", e);
          return Response.json({ ok: false, error: "tick failed" }, { status: 500 });
        }
      },
    },
  },
});
