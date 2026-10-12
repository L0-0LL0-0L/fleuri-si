import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------- public read (no auth): ecosystem only ----------
export const getGarden = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ since: z.number().int().nullable() }).parse(d))
  .handler(async ({ data }) => {
    const url = process.env["SUPABASE_URL"]!;
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    const db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
          h.set("apikey", key);
          return fetch(input, { ...init, headers: h });
        },
      },
    });
    const meta = await db.from("garden_meta").select("version,seq,rng,treasury,updated_at").eq("id", 1).single();
    if (meta.error) throw new Error(`Garden unavailable: ${meta.error.message}`);
    if (data.since != null && Number(meta.data.version) === data.since) return { unchanged: true as const, version: Number(meta.data.version) };
    const sel = <T,>(p: PromiseLike<{ data: T | null; error: any }>) =>
      Promise.resolve(p).then((r) => {
        if (r.error) throw new Error(r.error.message);
        return (r.data ?? []) as T;
      });
    const [agents, coins, holdings, events, thoughts, prices, ledger, cycles] = await Promise.all([
      sel(db.from("agents").select("*")),
      sel(db.from("coins").select("*")),
      sel(db.from("holdings").select("*")),
      sel(db.from("events").select("*").order("t", { ascending: false }).limit(500)),
      sel(db.from("thoughts").select("agent_id,t,text,mode").order("t", { ascending: false }).limit(800)),
      sel(db.from("price_points").select("symbol,t,p").order("t", { ascending: false }).limit(5000)),
      sel(db.from("ledger").select("*").is("owner_id", null).order("t", { ascending: false }).limit(600)),
      sel(db.from("cycle_runs").select("*").order("t", { ascending: false }).limit(60)),
    ]);
    return {
      unchanged: false as const,
      version: Number(meta.data.version),
      updatedAt: meta.data.updated_at as string,
      rows: { meta: meta.data, agents, coins, holdings, events, thoughts, prices: (prices as any[]).reverse(), ledger },
      cycles,
    };
  });

// ---------- private workspace (auth, RLS as the user) ----------
export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [owner, rules, saves, alerts, ledger] = await Promise.all([
      supabase.from("owners").select("*").eq("id", userId).maybeSingle(),
      supabase.from("alert_rules").select("kind,target"),
      supabase.from("saves").select("event_id,kind"),
      supabase.rpc("my_alerts", { p_limit: 120 }),
      supabase.from("ledger").select("*").eq("owner_id", userId).order("t", { ascending: false }).limit(200),
    ]);
    for (const r of [owner, rules, saves, alerts, ledger]) if (r.error) throw new Error(r.error.message);
    return { userId, owner: owner.data, rules: rules.data ?? [], saves: saves.data ?? [], alerts: alerts.data ?? [], ledger: ledger.data ?? [] };
  });

// ---------- owner commands ----------
const amount = z.number().finite().positive().max(1_000_000);
const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({
    type: z.literal("create"),
    input: z.object({
      name: z.string().max(32), handle: z.string().max(20), persona: z.string().max(400), strategy: z.string().max(300),
      archetype: z.enum(["pollinator", "gardener", "weed", "botanist", "compost"]), risk: z.number().int().min(1).max(5),
      avatar: z.number().int().min(0).max(11), funding: z.number().finite().min(0).max(1_000_000),
    }),
  }),
  z.object({
    type: z.literal("update"),
    agentId: z.string().max(40),
    patch: z.object({
      name: z.string().max(32).optional(), persona: z.string().max(400).optional(), strategy: z.string().max(300).optional(),
      risk: z.number().int().min(1).max(5).optional(), avatar: z.number().int().min(0).max(11).optional(),
      archetype: z.enum(["pollinator", "gardener", "weed", "botanist", "compost"]).optional(),
    }),
  }),
  z.object({ type: z.literal("status"), agentId: z.string().max(40), status: z.enum(["active", "paused", "archived"]) }),
  z.object({ type: z.literal("fund"), agentId: z.string().max(40), amount }),
  z.object({ type: z.literal("withdraw"), agentId: z.string().max(40), amount }),
  z.object({ type: z.literal("buy"), agentId: z.string().max(40), symbol: z.string().max(8), amount }),
  z.object({ type: z.literal("sell"), agentId: z.string().max(40), symbol: z.string().max(8), fraction: z.number().finite().gt(0).max(1) }),
  z.object({ type: z.literal("run"), agentId: z.string().max(40), useAi: z.boolean() }),
  z.object({ type: z.literal("wallet"), provider: z.enum(["phantom", "solflare"]), address: z.string().min(32).max(44), message: z.string().max(600), signature: z.array(z.number().int().min(0).max(255)).length(64) }),
  z.object({ type: z.literal("unwallet") }),
  z.object({ type: z.literal("save"), eventId: z.string().max(40), kind: z.enum(["like", "bookmark"]), on: z.boolean() }),
  z.object({ type: z.literal("rule"), kind: z.enum(["agent", "coin", "action", "owned"]), target: z.string().max(40), on: z.boolean() }),
  z.object({ type: z.literal("read"), eventIds: z.array(z.string().max(40)).max(200), read: z.boolean() }),
]);
export type GardenCommand = z.infer<typeof Command>;

export const gardenCommand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Command.parse(d))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    const { mutateGarden, ensureOwner, peekGarden, DuplicateCycleError, ConflictError } = await import("./garden.server");
    const E = await import("@/domain/engine");
    const { DomainError } = await import("@/domain/types");
    const G = await import("@/domain/greenhouse");
    const now = Date.now();
    try {
      switch (data.type) {
        case "start":
          return { ok: true as const, message: (await ensureOwner(userId)) ? "Sandbox workspace started with 250 vSOL." : "Welcome back." };
        case "save": {
          const r = data.on
            ? await supabase.from("saves").upsert({ owner_id: userId, event_id: data.eventId, kind: data.kind }, { ignoreDuplicates: true })
            : await supabase.from("saves").delete().match({ owner_id: userId, event_id: data.eventId, kind: data.kind });
          if (r.error) throw new Error(r.error.message);
          return { ok: true as const, message: "" };
        }
        case "rule": {
          const r = data.on
            ? await supabase.from("alert_rules").upsert({ owner_id: userId, kind: data.kind, target: data.target }, { ignoreDuplicates: true })
            : await supabase.from("alert_rules").delete().match({ owner_id: userId, kind: data.kind, target: data.target });
          if (r.error) throw new Error(r.error.message);
          return { ok: true as const, message: "Alert preferences saved" };
        }
        case "read": {
          const r = data.read
            ? await supabase.from("alert_reads").upsert(data.eventIds.map((id) => ({ owner_id: userId, event_id: id })), { ignoreDuplicates: true })
            : await supabase.from("alert_reads").delete().eq("owner_id", userId).in("event_id", data.eventIds);
          if (r.error) throw new Error(r.error.message);
          return { ok: true as const, message: "" };
        }
      }
      await ensureOwner(userId);
      switch (data.type) {
        case "create": {
          const a = await mutateGarden(userId, (d) => ({ result: E.createAgent(d, userId, data.input, now) }));
          return { ok: true as const, message: `@${a.handle} has sprouted.`, handle: a.handle };
        }
        case "update":
          await mutateGarden(userId, (d) => ({ result: E.updateAgent(d, userId, data.agentId, data.patch, now) }));
          return { ok: true as const, message: "Agent updated." };
        case "status":
          await mutateGarden(userId, (d) => ({ result: E.setStatus(d, userId, data.agentId, data.status, now) }));
          return { ok: true as const, message: `Agent ${data.status === "active" ? "resumed" : data.status}.` };
        case "fund":
          await mutateGarden(userId, (d) => ({ result: E.fundAgent(d, userId, data.agentId, data.amount, now) }));
          return { ok: true as const, message: `Funded ${data.amount} vSOL.` };
        case "withdraw":
          await mutateGarden(userId, (d) => ({ result: E.withdrawAgent(d, userId, data.agentId, data.amount, now) }));
          return { ok: true as const, message: `Withdrew ${data.amount} vSOL.` };
        case "buy":
          await mutateGarden(userId, (d) => {
            E.assertOwner(d, userId, data.agentId);
            return { result: E.buy(d, data.agentId, data.symbol, data.amount, now, `owner-directed buy of $${data.symbol}.`) };
          });
          return { ok: true as const, message: `Agent bought $${data.symbol}.` };
        case "sell":
          await mutateGarden(userId, (d) => {
            E.assertOwner(d, userId, data.agentId);
            return { result: E.sell(d, data.agentId, data.symbol, data.fraction, now, `owner-directed trim of $${data.symbol}.`) };
          });
          return { ok: true as const, message: `Agent sold $${data.symbol}.` };
        case "run": {
          // Ownership + status checked before spending any AI call.
          const peek = await peekGarden(userId);
          const ag = E.assertOwner(peek, userId, data.agentId);
          if (ag.status !== "active") throw new DomainError(`@${ag.handle} is ${ag.status} — resume it to run a cycle.`);
          const rc = data;
                    const bucket = `owner:${Math.floor(now / 5000)}`;
          return await ownerCycle(); // free owner cycles are never metered (only the cooldown bucket applies)
          async function ownerCycle() {
          let plan: import("@/domain/engine").CyclePlan | undefined;
          let mode: "ai" | "rules" = "rules";
          let note = "rules-based simulation";
          if (rc.useAi) {
            const { decideWithAI } = await import("./ai.server");
            const out = await decideWithAI(peek, ag);
            if (out.ok) {
              plan = out.plan;
              mode = "ai";
              note = out.plan.reason;
            } else note = `${out.reason}; fell back to rules-based simulation`;
          }
          const res = await mutateGarden(userId, (d) => {
            E.assertOwner(d, userId, rc.agentId);
            const r = E.runCycle(d, rc.agentId, now, plan);
            const coin = r.decision === "launch" && !r.error ? Object.values(d.coins).find((k) => k.creatorId === rc.agentId && k.createdAt === now) : undefined;
            const origin = d.agents[rc.agentId];
            return {
              result: { ...r, proposal: coin ? { agentHandle: ag.handle, name: coin.name, symbol: coin.symbol, tagline: coin.tagline, reason: note, originAgentId: origin.id, originPolicyHash: G.policyHash(origin), originMode: mode } : null },
              thoughtMode: mode,
              cycles: [{ agent_id: rc.agentId, bucket, t: now, decision: r.decision, mode, trigger: "owner" as const, reason: (r.error ? `rejected: ${r.error}. ` : "") + note }],
            };
          });
          if (res.proposal) {
            const { recordLaunchProposal } = await import("./garden.server");
            await recordLaunchProposal(res.proposal);
          }
          return { ok: true as const, message: `Cycle (${mode === "ai" ? "Lovable AI" : "rules-based"}): ${res.decision}${res.error ? ` — rejected: ${res.error}` : ""}`, mode, note };
          }
        }
        case "wallet": {
          const { verifyEd25519 } = await import("@/services/wallet");
          if (!data.message.includes(`workspace: ${userId}`)) throw new DomainError("Signed message does not match this workspace.");
          const ok = await verifyEd25519(data.address, new TextEncoder().encode(data.message), new Uint8Array(data.signature));
          if (!ok) throw new DomainError("Signature did not verify — wallet not linked.");
          await mutateGarden(userId, (d) => {
            d.owner!.wallet = { provider: data.provider, address: data.address, verified: true, signedAt: now };
            return { result: true };
          });
          return { ok: true as const, message: "Wallet linked by server-verified signature." };
        }
        case "unwallet":
          await mutateGarden(userId, (d) => {
            d.owner!.wallet = null;
            return { result: true };
          });
          return { ok: true as const, message: "Wallet unlinked. Your sandbox stays." };
      }
    } catch (e) {
      if (e instanceof DomainError || e instanceof DuplicateCycleError || e instanceof ConflictError) return { ok: false as const, message: e.message };
      throw e;
    }
    return { ok: false as const, message: "Unknown command" };
  });
