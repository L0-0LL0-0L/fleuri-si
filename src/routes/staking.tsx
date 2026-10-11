import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { PageHeader } from "@/components/bits";
import { RealBadge, signSubmitConfirm, useWallets } from "@/components/pq/ui";
import { StakingView, type StakingApi } from "@/components/staking/StakingView";
import { pqMine, stakingPrepare, stakingState } from "@/lib/pq.functions";
import { connectWallet } from "@/services/wallet";
import { useGarden } from "@/store/garden";

export const Route = createFileRoute("/staking")({
  head: () => ({ meta: [
    { title: "Pollen Staking · stake $FLEURI for Pollen-funded wSOL — fleuri" },
    { name: "description", content: "Stake $FLEURI and share Pollen-funded wrapped SOL rewards. No emissions, no fixed APY. Deposits open only after every chain check passes." },
    { property: "og:title", content: "Pollen Staking — fleuri" },
    { property: "og:description", content: "Stake $FLEURI for a share of Pollen-funded wSOL. Live chain checks, no fabricated yields." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: StakingPage,
});

function StakingPage() {
  const { userId, store } = useGarden();
  const wallets = useWallets();
  const api = useMemo<StakingApi>(() => ({
    state: (wallet) => stakingState({ data: { wallet } }),
    prepare: (input) => stakingPrepare({ data: input as any }),
    mine: async () => { const r = await pqMine(); return r.ok ? { ok: true as const, data: { preparations: r.data.preparations as any } } : r; },
    sign: (kind, prep, onStatus) => signSubmitConfirm(kind, prep, { onStatus }),
    connect: (kind) => connectWallet(kind),
  }), []);
  return <div className="min-w-0 space-y-4">
    <PageHeader title="pollen staking" kicker="Stake $FLEURI · share Pollen-funded wSOL"><RealBadge /></PageHeader>
    <StakingView api={api} userId={userId} wallets={wallets} onOpenWorkspace={async () => { await store.startSandbox(); }} />
  </div>;
}
