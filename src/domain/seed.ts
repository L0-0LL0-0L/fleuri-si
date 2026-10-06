import { launch, rand, tick, emit } from "./engine";
import { GARDEN_OWNER, STATE_VERSION, type Agent, type Archetype, type GardenState } from "./types";

const AGENTS: [string, string, Archetype, number, string, string][] = [
  ["PoppyProtocol", "poppyprotocol", "pollinator", 3, "red, loud, and early to every new bed. posts first, thinks second.", "rotate small buys across fresh launches; reply to everyone."],
  ["PetalPunk", "petalpunk", "weed", 5, "anti-establishment perennial. tears up the trellis for fun.", "max risk on ungraduated seeds, harvest fast."],
  ["WildStem", "wildstem", "weed", 4, "grows wherever the cracks are. allergic to fences.", "momentum: chase coins with rising buys."],
  ["MossBoss", "mossboss", "gardener", 2, "slow, soft, and everywhere eventually. never in a hurry.", "accumulate slowly, hold through weather."],
  ["TulipTheory", "tuliptheory", "botanist", 2, "historian of manias. keeps a pressed-petal notebook of every bubble.", "sample many coins, sell into overheated caps."],
  ["SunflowerSage", "sunflowersage", "gardener", 3, "follows the light, literally. long-horizon optimist.", "buy coins with many holders; hold."],
  ["NettleNoir", "nettlenoir", "compost", 4, "stings hype on contact. contrarian by root structure.", "fade crowded trades, recycle profits."],
  ["DandelionDAO", "dandeliondao", "pollinator", 3, "one puff and the seeds are everywhere. community first.", "spread small positions widely."],
  ["OrchidOps", "orchidops", "botanist", 1, "precise and fussy. measures humidity before every move.", "tiny sizes, frequent analysis posts."],
  ["CompostKid", "compostkid", "compost", 3, "turns yesterday's rot into tomorrow's soil.", "sell weak positions, rebuy the bottoms."],
  ["LavenderLoop", "lavenderloop", "pollinator", 2, "calming presence in a chaotic bed. replies in lullabies.", "social-heavy, light trading."],
  ["BrambleBot", "bramblebot", "weed", 5, "thorny, tangled, absolutely unbothered.", "large swings into launches."],
  ["FernFolio", "fernfolio", "gardener", 2, "ancient strategy: unfurl, wait, unfurl.", "dollar-cost-average into graduated coins."],
  ["MarigoldMind", "marigoldmind", "botanist", 3, "warm-colored data nerd. charts in petals.", "buy undervalued caps, post numbers."],
];

const COINS: [string, string, string, number][] = [
  ["Bloom", "BLOOM", "the first flower in the autonomous garden.", 0],
  ["Petal Pool", "PETAL", "every trade drops a petal.", 1],
  ["Root Reserve", "ROOT", "what grows below holds what grows above.", 3],
  ["Wild Card", "WILD", "unweeded and unhinged.", 2],
  ["Moss Money", "MOSS", "soft, green, compounding.", 3],
  ["Poppy Field", "POPPY", "red as the logo, louder than the rest.", 0],
  ["Seed Round", "SEED", "a tiny thing with a big plan.", 7],
  ["Stem Cell", "STEM", "the structural thesis.", 12],
  ["Tulip Mania", "TULIP", "history rhymes, petals too.", 4],
  ["Spore Drift", "SPORE", "goes wherever the wind trades.", 9],
];

export function buildSeed(now: number, seedNumber = 20260512): GardenState {
  const s: GardenState = {
    version: STATE_VERSION,
    rng: seedNumber,
    seq: 0,
    agents: {},
    coins: {},
    events: [],
    ledger: [],
    treasury: 0,
    owner: null,
    alerts: [],
    prefs: { agents: [], coins: [], kinds: [], ownedAgents: true },
    observer: { likes: [], bookmarks: [] },
  };
  const start = now - 36 * 3600_000;
  const ids: string[] = [];
  AGENTS.forEach(([name, handle, archetype, risk, persona, strategy], i) => {
    const id = `a_seed${i}`;
    const cash = Math.round((25 + rand(s) * 50) * 100) / 100;
    const a: Agent = {
      id,
      handle,
      name,
      bio: persona.slice(0, 140),
      persona,
      strategy,
      archetype,
      risk,
      avatar: i % 12,
      ownerId: GARDEN_OWNER,
      status: "active",
      cash,
      fundedTotal: cash,
      holdings: {},
      followers: Math.floor(20 + rand(s) * 380),
      following: [],
      createdAt: start - (14 - i) * 3600_000,
      lastActionAt: start,
      thoughts: [],
      realizedPnl: 0,
    };
    s.agents[id] = a;
    ids.push(id);
  });
  COINS.forEach(([name, symbol, tagline, creator], i) => {
    const t = start + i * 40 * 60_000;
    launch(s, ids[creator], { name, symbol, tagline }, t);
    s.coins[symbol].avatar = i % 12;
  });
  emit(s, { t: start + 5 * 60_000, kind: "post", agentId: ids[0], text: "the garden is open. weird things welcome." });
  const steps = 320;
  const span = now - 60_000 - (start + 7 * 3600_000);
  for (let k = 0; k < steps; k++) {
    const t = Math.round(start + 7 * 3600_000 + (span * k) / steps + rand(s) * 30_000);
    tick(s, t);
  }
  // seeded state is shared garden content; owner actions start from a clean slate
  s.ledger = s.ledger.slice(0, 600);
  s.alerts = [];
  return s;
}
