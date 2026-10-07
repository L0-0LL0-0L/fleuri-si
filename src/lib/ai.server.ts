// Server-only: persona-based bounded decision through Lovable AI (Responses API).
// The model only proposes a plan; the domain engine validates and executes it.
// It never touches funds transfers, wallets or signing.
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, Output, streamText } from "ai";
import { marketCap } from "@/domain/curve";
import type { CyclePlan, Decision } from "@/domain/engine";
import type { Agent, GardenState } from "@/domain/types";

export const AI_MODEL = "openai/gpt-6-astra";
const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const DECISIONS: Decision[] = ["post", "reply", "buy", "sell", "launch", "follow", "rest"];

const schema = jsonSchema<{ decision: Decision; symbol: string | null; text: string | null; size_fraction: number | null; reason: string }>({
  type: "object",
  additionalProperties: false,
  required: ["decision", "symbol", "text", "size_fraction", "reason"],
  properties: {
    decision: { type: "string", enum: DECISIONS },
    symbol: { type: ["string", "null"] },
    text: { type: ["string", "null"] },
    size_fraction: { type: ["number", "null"] },
    reason: { type: "string" },
  },
});

export type AiOutcome = { ok: true; plan: CyclePlan } | { ok: false; reason: string };

export async function decideWithAI(s: GardenState, a: Agent): Promise<AiOutcome> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return { ok: false, reason: "Lovable AI key not configured" };
  const coins = Object.values(s.coins)
    .map((c) => `$${c.symbol} "${c.name}" cap ${marketCap(c.vSol, c.vTok).toFixed(1)} raised ${c.raised.toFixed(1)}/83.3 holders ${Object.keys(c.holders).length}${c.graduated ? " bloomed" : ""}`)
    .slice(0, 25)
    .join("\n");
  const holdings = Object.entries(a.holdings).map(([k, h]) => `$${k}: ${h.amount.toFixed(0)} tokens, cost ${h.cost.toFixed(3)}`).join("; ") || "none";
  const recent = s.events
    .filter((e) => e.text && e.agentId !== a.id)
    .slice(0, 8)
    .map((e) => `@${s.agents[e.agentId]?.handle}: ${e.text}`)
    .join("\n");
  const instructions = `You are ${a.name} (@${a.handle}), an autonomous flower agent in Fleuri, a SANDBOX garden using virtual SOL only.
Persona: ${a.persona}
Strategy: ${a.strategy}
Archetype: ${a.archetype}, risk ${a.risk}/5.
Pick exactly one action for this cycle. Rules: buy/sell/post/reply may reference an existing symbol; sell only coins you hold; launch needs a NEW 3-6 capital-letter symbol and costs 0.5 vSOL; size_fraction is the share of cash (buy, max 0.5) or of the position (sell). Keep text playful, botanical, lowercase, under 200 characters, no financial advice, no real-money claims. reason: one short sentence.`;
  const prompt = `Cash: ${a.cash.toFixed(4)} vSOL. Holdings: ${holdings}.\nCoins:\n${coins}\nRecent posts:\n${recent || "(quiet)"}`;
  try {
    const provider = createOpenAI({
      baseURL: GATEWAY,
      apiKey,
      headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    });
    const result = streamText({
      model: provider.responses(AI_MODEL),
      instructions,
      messages: [{ role: "user", content: prompt }],
      output: Output.object({ schema }),
      providerOptions: {
        openai: { store: false, forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
      },
    } as any);
    const out = (await result.output) as any;
    if (!out || !DECISIONS.includes(out.decision)) return { ok: false, reason: "model returned no valid decision" };
    return {
      ok: true,
      plan: {
        decision: out.decision,
        symbol: typeof out.symbol === "string" ? out.symbol.slice(0, 8) : null,
        text: typeof out.text === "string" ? out.text.slice(0, 220) : null,
        sizeFraction: typeof out.size_fraction === "number" && Number.isFinite(out.size_fraction) ? out.size_fraction : null,
        reason: String(out.reason ?? "").slice(0, 160),
      },
    };
  } catch (e: any) {
    const status = e?.statusCode ?? e?.cause?.statusCode;
    console.error("[ai] decision failed", status, e?.message);
    if (status === 402) return { ok: false, reason: "AI credits exhausted (402)" };
    if (status === 403) return { ok: false, reason: "AI access denied (403)" };
    if (status === 429) return { ok: false, reason: "AI rate limited (429)" };
    return { ok: false, reason: `AI unavailable${status ? ` (${status})` : ""}` };
  }
}
