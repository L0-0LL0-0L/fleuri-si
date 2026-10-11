import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/components/PixelFlower", () => ({ FlowerTiles: () => null }));
vi.mock("@/components/pq/ui", () => ({
  Panel: ({ title, children }: any) => <section aria-label={title}><h2>{title}</h2>{children}</section>,
  PendingTransactions: ({ rows }: any) => (rows.length ? <div>Pending: {rows.map((r: any) => r.kind).join(",")}</div> : null),
  WalletButtons: ({ onPick }: any) => <button onClick={() => onPick("phantom")}>Connect Phantom</button>,
  explorerAddr: (a: string) => a,
}));

import { StakingView, type StakingApi } from "./StakingView";
import { EXIT_CHECK_IDS } from "@/pq/staking";

const W1 = "Wallet1111111111111111111111111111111111111", W2 = "Wallet2222222222222222222222222222222222222";
const ids = ["cluster", "rpc", "configured", "program", "code", "upgrade", "mint", "mintAuth", "freezeAuth", "pool", "vaults", "source"];
function snap(o: { wallet?: string | null; claimable?: string; rpc?: boolean; deposits?: boolean; unclaimed?: string } = {}) {
  const exitOk = (id: string) => (EXIT_CHECK_IDS as readonly string[]).includes(id);
  return {
    cluster: "mainnet-beta", programId: "Prog", placeholder: "Ph", stakeMint: "M", chainTime: 1_000,
    checks: ids.map((id) => ({ id, label: id, ok: id === "rpc" ? o.rpc ?? true : exitOk(id) || !!o.deposits, detail: id })),
    depositsEnabled: !!o.deposits, facts: { programUpgradeable: false },
    pool: { ledger: { duration: "604800", cooldown: "604800", streamEnd: "0", totalActive: "1", dfsFundedTotal: "0", treasuryTotal: "0", distributedTotal: "0", claimedTotal: "0", unallocated: "0" } },
    feeSource: { address: "FV", unclaimedForPool: o.unclaimed ?? "0" },
    position: o.wallet ? { active: "5", pendingAmount: "0", unlockTs: "0", claimable: o.claimable ?? "0" } : null,
    balances: o.wallet ? { fleuri: "10" } : undefined,
  };
}
const api = (state: StakingApi["state"]): StakingApi => ({ state, prepare: vi.fn(), mine: vi.fn(async () => ({ ok: true as const, data: { preparations: [] } })), sign: vi.fn(), connect: vi.fn(async () => W1) });
const claimBtn = () => screen.getByRole("button", { name: "Claim wSOL" });

describe("StakingView live state", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("Claim enables when polled claimable goes from zero to positive", async () => {
    let claimable = "0";
    const state = vi.fn(async (w: string | null) => ({ ok: true as const, data: snap({ wallet: w, claimable }) }));
    render(<StakingView api={api(state)} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={50} />);
    fireEvent.click(await screen.findByText("Connect Phantom"));
    await waitFor(() => expect(screen.getByTestId("claimable").textContent).toBe("0 wSOL"));
    expect(claimBtn()).toBeDisabled();
    claimable = "1500";
    await waitFor(() => expect(screen.getByTestId("claimable").textContent).toBe("0.0000015 wSOL"));
    expect(claimBtn()).toBeEnabled();
  });

  it("polls without overlapping reads", async () => {
    let live = 0, maxLive = 0;
    const state = vi.fn(async (w: string | null) => { live++; maxLive = Math.max(maxLive, live); await new Promise((r) => setTimeout(r, 60)); live--; return { ok: true as const, data: snap({ wallet: w }) }; });
    render(<StakingView api={api(state)} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={10} />);
    await waitFor(() => expect(state.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    expect(maxLive).toBe(1);
  });

  it("a failed read marks data stale and disables actions", async () => {
    let fail = false;
    const state = vi.fn(async (w: string | null) => (fail ? { ok: false as const, error: "RPC down" } : { ok: true as const, data: snap({ wallet: w, claimable: "9" }) }));
    render(<StakingView api={api(state)} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Connect Phantom"));
    await waitFor(() => expect(claimBtn()).toBeEnabled());
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByLabelText("freshness").textContent).toMatch(/Stale: Latest read failed \(RPC down\)/));
    expect(claimBtn()).toBeDisabled();
  });

  it("server-reported stale RPC keeps actions off", async () => {
    const state = vi.fn(async (w: string | null) => ({ ok: true as const, data: snap({ wallet: w, claimable: "9", rpc: false }) }));
    render(<StakingView api={api(state)} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Connect Phantom"));
    await waitFor(() => expect(screen.getByTestId("claimable").textContent).toBe("0.000000009 wSOL"));
    expect(claimBtn()).toBeDisabled();
    expect(screen.getByLabelText("freshness").textContent).toMatch(/^Stale/);
  });

  it("drops out-of-order results and clears owned state on disconnect", async () => {
    const resolvers: (() => void)[] = [];
    const state = vi.fn((w: string | null) => new Promise<any>((r) => resolvers.push(() => r({ ok: true, data: snap({ wallet: w, claimable: w === W1 ? "111" : "0" }) }))));
    const a = api(state); (a.connect as any).mockResolvedValueOnce(W1);
    render(<StakingView api={a} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={60_000} />);
    await act(async () => resolvers[0]());
    fireEvent.click(await screen.findByText("Connect Phantom"));
    await waitFor(() => expect(resolvers.length).toBe(2));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" })); // switch away before W1's read returns
    await waitFor(() => expect(resolvers.length).toBe(3));
    await act(async () => resolvers[1]()); // stale W1 result arrives late: ignored
    await act(async () => resolvers[2]());
    expect(screen.queryByTestId("claimable")).toBeNull();
    expect(screen.getByText("Connect Phantom")).toBeInTheDocument();
  });

  it("Collect Pollen rewards needs a positive Pollen balance and harvest readiness", async () => {
    let unclaimed = "0";
    const state = vi.fn(async (w: string | null) => ({ ok: true as const, data: snap({ wallet: w, unclaimed }) }));
    render(<StakingView api={api(state)} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Connect Phantom"));
    await waitFor(() => expect(screen.getByTestId("claimable")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Collect Pollen rewards" })).toBeDisabled(); // source check fails + zero balance
    unclaimed = "5"; (state as any).mockImplementation(async (w: string | null) => { const s = snap({ wallet: w, unclaimed }); s.checks.find((c) => c.id === "source")!.ok = true; return { ok: true, data: s }; });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Collect Pollen rewards" })).toBeEnabled());
  });

  it("shows an in-page review with cost and cancels without signing", async () => {
    const state = vi.fn(async (w: string | null) => ({ ok: true as const, data: snap({ wallet: w, claimable: "9" }) }));
    const a = api(state);
    (a.prepare as any).mockResolvedValue({ ok: true, data: { preparationId: "p", transaction: "x", cluster: "mainnet-beta", cost: { networkFeeLamports: 5000, simulatedChangeLamports: 2044280 }, review: { action: "claim", programId: "Prog", expectedClaim: "9", createsTokenAccount: true } } });
    render(<StakingView api={a} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Connect Phantom"));
    await waitFor(() => expect(claimBtn()).toBeEnabled());
    fireEvent.click(claimBtn());
    const review = await screen.findByLabelText("Review before signing");
    expect(review.textContent).toMatch(/0\.000005 SOL/);
    expect(review.textContent).toMatch(/0\.00204428 SOL/);
    expect(review.textContent).toMatch(/Claim wSOL rewards/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelled. Nothing was signed.");
    expect(a.sign).not.toHaveBeenCalled();
  });

  it("lists owner staking recoveries only", async () => {
    const state = vi.fn(async (w: string | null) => ({ ok: true as const, data: snap({ wallet: w }) }));
    const a = api(state); (a.mine as any).mockResolvedValue({ ok: true, data: { preparations: [{ id: "1", kind: "staking_claim" }, { id: "2", kind: "launch" }] } });
    render(<StakingView api={a} userId="u" wallets={{ phantom: true, solflare: false }} onOpenWorkspace={async () => {}} pollMs={60_000} />);
    expect(await screen.findByText("Pending: staking_claim")).toBeInTheDocument();
  });
});
