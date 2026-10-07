// One-off: seed the shared sandbox garden into the cloud through garden_commit.
// Usage: bun scripts/seed-cloud.ts   (requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env)
import { createClient } from "@supabase/supabase-js";
import { commitPayload } from "../src/domain/persist";
import { buildSeed } from "../src/domain/seed";
import { STATE_VERSION, type GardenState } from "../src/domain/types";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: meta } = await db.from("garden_meta").select("version").eq("id", 1).single();
const { count } = await db.from("agents").select("id", { count: "exact", head: true });
if ((count ?? 0) > 0) {
  console.log("already seeded; agents =", count);
  process.exit(0);
}
const empty: GardenState = {
  version: STATE_VERSION, rng: 0, seq: 0, agents: {}, coins: {}, events: [], ledger: [], treasury: 0, owner: null, alerts: [],
  prefs: { agents: [], coins: [], kinds: [], ownedAgents: false }, observer: { likes: [], bookmarks: [] },
};
const seed = buildSeed(Date.now());
const payload = commitPayload(empty, seed, Number(meta!.version), [], "rules");
console.log("rows:", Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v])));
const { data, error } = await db.rpc("garden_commit", { p: payload as any });
if (error) throw error;
console.log("seeded at version", data);
