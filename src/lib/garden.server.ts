// Server-only: loads the shared sandbox garden from the cloud, applies one domain
// operation and commits it atomically through the garden_commit RPC (service role).
import { commitPayload, stateFromRows, type CycleRow } from "@/domain/persist";
import type { GardenState } from "@/domain/types";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function loadForMutation(db: Admin, ownerId: string | null) {
  const q = (p: PromiseLike<{ data: any; error: any }>) =>
    Promise.resolve(p).then((r) => {
      if (r.error) throw new Error(r.error.message);
      return r.data;
    });
  const [meta, agents, coins, holdings, events, owner] = await Promise.all([
    q(db.from("garden_meta").select("*").eq("id", 1).single()),
    q(db.from("agents").select("*")),
    q(db.from("coins").select("*")),
    q(db.from("holdings").select("*")),
    q(db.from("events").select("*").order("t", { ascending: false }).limit(300)),
    ownerId ? q(db.from("owners").select("*").eq("id", ownerId).maybeSingle()) : Promise.resolve(null),
  ]);
  const state = stateFromRows({ meta, agents, coins, holdings, events, owner });
  return { state, version: Number(meta.version) };
}

export class ConflictError extends Error {}
export class DuplicateCycleError extends Error {}

/**
 * Run `fn` against a fresh copy of the garden and commit the diff atomically.
 * Retries on optimistic-version conflicts; duplicate cycle buckets abort.
 */
export async function mutateGarden<R>(
  ownerId: string | null,
  fn: (draft: GardenState) => { result: R; cycles?: CycleRow[]; thoughtMode?: "rules" | "ai" | "owner" | "system" },
  maxAttempts = 5,
): Promise<R> {
  const db = await admin();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { state, version } = await loadForMutation(db, ownerId);
    const before = structuredClone(state);
    const out = fn(state); // throws DomainError on invalid input -> nothing is written
    const payload = commitPayload(before, state, version, out.cycles ?? [], out.thoughtMode ?? "owner");
    const { error } = await db.rpc("garden_commit", { p: payload as any });
    if (!error) return out.result;
    if (error.code === "40001" || /version_conflict/.test(error.message)) {
      await new Promise((r) => setTimeout(r, 40 * attempt + Math.random() * 60));
      continue;
    }
    if (error.code === "23505" && /cycle_runs/.test(error.message + (error.details ?? ""))) throw new DuplicateCycleError("That cycle already ran — try again in a few seconds.");
    throw new Error(`Cloud commit failed: ${error.message}`);
  }
  throw new ConflictError("The garden was busy; please try again.");
}

/** Read-only snapshot for building AI prompts. */
export async function peekGarden(ownerId: string | null) {
  const db = await admin();
  return (await loadForMutation(db, ownerId)).state;
}

export type LaunchProposalDraft = { agentHandle: string; name: string; symbol: string; tagline: string; reason: string };

/**
 * Best-effort record of an agent's virtual launch as a real-launch proposal.
 * Never throws: a proposal is advisory and must not fail the garden commit.
 */
export async function recordLaunchProposal(p: LaunchProposalDraft) {
  try {
    const db = await admin();
    const { error } = await db.from("launch_proposals").insert({
      agent_handle: p.agentHandle,
      name: p.name.slice(0, 32),
      symbol: p.symbol.slice(0, 10),
      tagline: p.tagline.slice(0, 200),
      reason: p.reason.slice(0, 200),
    });
    if (error) console.error("[proposals] insert failed", error.message);
  } catch (e) {
    console.error("[proposals] insert failed", (e as Error).message);
  }
}

export async function ensureOwner(ownerId: string) {
  const db = await admin();
  const { data } = await db.from("owners").select("id").eq("id", ownerId).maybeSingle();
  if (data) return false;
  const { startSession } = await import("@/domain/engine");
  await mutateGarden(ownerId, (d) => {
    startSession(d, ownerId, Date.now());
    return { result: true };
  });
  await db.from("alert_rules").upsert({ owner_id: ownerId, kind: "owned", target: "" }, { onConflict: "owner_id,kind,target", ignoreDuplicates: true });
  return true;
}
