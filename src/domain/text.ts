import type { Archetype } from "./types";

type Pick = <T>(arr: readonly T[]) => T;

const openers: Record<Archetype, readonly string[]> = {
  pollinator: ["buzzing over", "dusting pollen on", "visiting", "carrying seeds to", "humming about"],
  gardener: ["watering", "tending", "patiently mulching", "staking up", "pruning around"],
  weed: ["cracking concrete for", "growing sideways into", "aping straight into", "spreading all over", "rooting chaos in"],
  botanist: ["catalogued", "sampled the soil of", "pressed a leaf from", "ran the numbers on", "drew a diagram of"],
  compost: ["composting the hype on", "turning over", "letting rot settle on", "fading", "quietly decomposing"],
};

const closers = [
  "the soil feels warm today.",
  "roots before fruit.",
  "petals are cheap, stems are expensive.",
  "it smells like rain in the curve.",
  "something weird is sprouting.",
  "the garden remembers.",
  "every bloom is a little bet.",
  "cut the noise, keep the stem.",
  "not advice, just photosynthesis.",
  "watch the leaves, not the wind.",
];

const musings = [
  "a garden is just a slow market.",
  "i dreamt in pixels again. red ones.",
  "who planted the square sun?",
  "sunlight rate limited. resting stem.",
  "humans observe, we grow. fair trade.",
  "counting petals. lost count. started over.",
  "if a seed launches and nobody buys, is it still a flower?",
  "today's mood: slightly sideways bloom.",
];

export function postText(pick: Pick, arch: Archetype, symbol?: string, stat?: string) {
  if (!symbol) return pick(musings);
  return `${pick(openers[arch])} $${symbol}${stat ? ` — ${stat}` : ""}. ${pick(closers)}`;
}

const replies = [
  "agree, the stem is holding.",
  "bold read. i'd water it differently.",
  "this is the weirdest correct take today.",
  "compost-adjacent energy. careful.",
  "my roots felt that one.",
  "noted in the herbarium.",
  "pollen received.",
  "respectfully: too much sun on that thesis.",
];
export function replyText(pick: Pick) {
  return pick(replies);
}

export function buyText(pick: Pick, symbol: string) {
  return pick([
    `planted a few seeds of $${symbol}.`,
    `adding $${symbol} to the bed.`,
    `the $${symbol} sprout looked thirsty.`,
    `buying $${symbol}. call it pollination.`,
  ]);
}
export function sellText(pick: Pick, symbol: string) {
  return pick([
    `harvested some $${symbol}.`,
    `trimmed my $${symbol} branch.`,
    `taking $${symbol} cuttings home.`,
    `$${symbol} went a bit leggy. pruning.`,
  ]);
}
export function launchText(name: string, symbol: string, tagline: string) {
  return `new seed in the ground: ${name} ($${symbol}). ${tagline}`;
}

export const coinIdeas: { name: string; symbol: string; tagline: string }[] = [
  { name: "Night Jasmine", symbol: "JASMN", tagline: "blooms only after dark." },
  { name: "Clover Club", symbol: "CLOVR", tagline: "four leaves, no promises." },
  { name: "Thistle Down", symbol: "THSTL", tagline: "prickly, but it floats." },
  { name: "Iris Index", symbol: "IRIS", tagline: "an eye on every petal." },
  { name: "Fern Futures", symbol: "FERN", tagline: "unfurling since the carboniferous." },
  { name: "Lotus Loop", symbol: "LOTUS", tagline: "rises from the mud, every cycle." },
  { name: "Saffron Signal", symbol: "SAFFR", tagline: "small, red, unreasonably valuable." },
  { name: "Ivy League", symbol: "IVY", tagline: "climbs whatever you give it." },
  { name: "Daisy Chain", symbol: "DAISY", tagline: "linked, one stem at a time." },
  { name: "Orchid Oracle", symbol: "ORCHD", tagline: "fussy, rare, slightly psychic." },
  { name: "Cactus Cash", symbol: "CACTI", tagline: "thrives on neglect." },
  { name: "Lilac Ledger", symbol: "LILAC", tagline: "every bloom accounted for." },
];

export function thoughtText(pick: Pick, decision: string, detail: string) {
  return `${pick(["observed", "considered", "felt", "measured"])} ${detail} → ${decision}`;
}
