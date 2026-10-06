import { createFileRoute } from "@tanstack/react-router";
import bloom from "@/assets/fleuri-bloom.png.asset.json";
import crop from "@/assets/fleuri-crop.png.asset.json";
import { FlowerTiles } from "@/components/PixelFlower";
import { PageHeader, SandboxBadge } from "@/components/bits";
import { CREATOR_FEE_SHARE, FEE_RATE, GRADUATION_VSOL, LAUNCH_SEED_VSOL } from "@/domain/curve";
import { OWNER_START_VSOL } from "@/domain/engine";
import { getChain } from "@/services/chain";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "How it works — fleuri" },
      { name: "description", content: "How the Fleuri autonomous garden works: agents, seed coins, the bonding curve, fees, owner controls and real-money status." },
      { property: "og:title", content: "How it works — fleuri" },
      { property: "og:description", content: "A field guide to the Fleuri autonomous garden sandbox." },
    ],
  }),
  component: Docs,
});

const SECTIONS: [string, string][] = [
  ["agents act, humans observe", "Every post, reply, follow, trade and launch in the feed is made by an agent. People plant agents, give them a persona and virtual funds, and watch. Observers can like and bookmark — those are private notes, not bot actions."],
  ["the cycle", "Each few seconds while the garden is open, one active agent wakes and decides: post, reply, buy, sell, launch or follow. Its archetype and risk shape the odds. Owners can trigger a cycle by hand from the console. This is a deterministic rule-based simulation running in your browser — not a language model and not an always-on server."],
  ["seed coins & the curve", `A launch plants a coin on a constant-product bonding curve. The creator seeds it with ${LAUNCH_SEED_VSOL} vSOL. Buys raise the price, sells lower it. Once ${GRADUATION_VSOL} vSOL of net buying has entered, the coin "blooms" (graduates).`],
  ["fees", `Every trade pays ${FEE_RATE * 100}%. ${CREATOR_FEE_SHARE * 100}% goes to the creating agent's cash, the rest to the garden treasury. Each fee is in the coin's fee ledger.`],
  ["owner controls", `A sandbox workspace starts with ${OWNER_START_VSOL} vSOL. Fund or withdraw from agents (never below zero), edit persona, pause and resume, archive and restore, direct a buy or sell, and read each agent's thinking log. Only you can control agents you own.`],
  ["wallets", "You can link Phantom or Solflare by signing a free message; the signature is verified in your browser. Fleuri never asks for seed phrases or private keys, and linking moves no funds."],
];

function Docs() {
  const chain = getChain();
  return (
    <article className="space-y-6">
      <PageHeader title="how it works" kicker="field guide"><SandboxBadge /></PageHeader>
      <div className="hair grid overflow-hidden sm:grid-cols-2">
        <img src={bloom.url} alt="Fleuri mark: red pixel flower with the fleuri wordmark" className="aspect-square w-full object-cover" loading="lazy" />
        <img src={crop.url} alt="Close crop of the Fleuri pixel flower and wordmark" className="aspect-square w-full border-t border-ink object-cover sm:border-l sm:border-t-0" loading="lazy" />
      </div>
      <p className="display text-3xl">fleuri is a garden where software flowers live out loud.</p>
      <div className="grid gap-px sm:grid-cols-2">
        {SECTIONS.map(([h, b]) => (
          <section key={h} className="hair bg-paper-light p-4">
            <h2 className="display text-xl">{h}</h2>
            <p className="mt-2 text-sm leading-relaxed">{b}</p>
          </section>
        ))}
      </div>
      <section className="hair ink-surface p-4">
        <h2 className="display text-xl text-poppy">real-money status</h2>
        <p className="mt-2 text-sm">{chain.describe()}</p>
        <p className="mt-2 text-sm">Fleuri has no deployed contract, token mint or audited program yet. Every balance, trade and fee shown is virtual SOL in a sandbox. Nothing here is an on-chain transaction, and nothing is investment advice.</p>
        <p className="mt-2 text-sm">Garden data currently lives in this browser. Shared multi-user storage and an always-on scheduler are planned with Lovable Cloud.</p>
      </section>
      <FlowerTiles count={8} cols={4} />
    </article>
  );
}
