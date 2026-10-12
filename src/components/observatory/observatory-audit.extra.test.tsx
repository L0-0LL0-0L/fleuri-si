// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { Observatory } from "@/routes/observatory";

const mocks = vi.hoisted(() => ({
  search: {} as { vault?: string },
  snapshot: vi.fn(), history: vi.fn(), known: vi.fn(), navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    createFileRoute: () => (options: any) => ({ ...options, useSearch: () => mocks.search, useNavigate: () => mocks.navigate }),
    Link: ({ children }: any) => React.createElement("a", {}, children),
  };
});
vi.mock("@/lib/observatory.functions", () => ({ obsSnapshot: mocks.snapshot, obsHistory: mocks.history, obsKnown: mocks.known }));
vi.mock("@/components/bits", async () => {
  const React = await import("react");
  return { PageHeader: ({ title, children }: any) => React.createElement("header", {}, React.createElement("h1", {}, title), children) };
});
vi.mock("@/components/PixelFlower", () => ({ FlowerTiles: () => null }));
vi.mock("@/components/pq/ui", async () => {
  const React = await import("react");
  return {
    Panel: ({ title, children }: any) => React.createElement("section", {}, React.createElement("h2", {}, title), children),
    RealBadge: ({ cluster }: any) => React.createElement("span", {}, cluster),
    downloadBlob: vi.fn(), explorerAddr: () => "#address", explorerTx: () => "#transaction",
  };
});

const VAULT = "DwyTJxxgyA8KF2MS8Jnmw4PymX2NjvBjnnQjLjj1tG5r";
const TOKEN = "So11111111111111111111111111111111111111112";
function snapshot() {
  return { cluster: "mainnet-beta", genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", slot: 123, observedAt: "2026-10-12T08:00:00.000Z", program: "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh", vault: {
    address: VAULT, tokenVault: TOKEN, mint: TOKEN, supported: true, decimals: 9, symbol: "SOL (wrapped)",
    funded: "10", claimed: "0", unclaimed: "10", dust: "0", recipients: [], recipientSlots: [], totalShare: 10000,
    owner: VAULT, base: VAULT, feeVaultType: 1, feePerShare: "1", pdaIssues: [],
  } };
}
function history() {
  const c = (address: string) => ({ address, oldestSignature: null, oldestSlot: null, pages: 1, exhausted: true, error: null });
  return { cluster: "mainnet-beta", vault: VAULT, tokenVault: TOKEN, scope: { vault: VAULT, tokenVault: TOKEN }, observedAt: "2026-10-12T08:00:01.000Z", txs: [], coverage: { vault: c(VAULT), tokenVault: c(TOKEN) } };
}
beforeEach(() => {
  mocks.search = { vault: VAULT };
  mocks.snapshot.mockReset().mockResolvedValue({ ok: true, data: snapshot() });
  mocks.history.mockReset().mockResolvedValue({ ok: true, data: history() });
  mocks.known.mockReset().mockResolvedValue({ ok: true, data: [] });
  mocks.navigate.mockReset();
});
afterEach(cleanup);

describe("Observatory URL scope regressions", () => {
  it("finishes an initial deep-link lookup under React StrictMode", async () => {
    render(<StrictMode><Observatory /></StrictMode>);
    await screen.findByRole("heading", { name: /current account totals/i });
  });

  it("clears the observed vault when back navigation removes the vault parameter", async () => {
    const view = render(<Observatory />);
    await screen.findByRole("heading", { name: /current account totals/i });
    await waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
    mocks.search = {};
    view.rerender(<Observatory />);
    await waitFor(() => expect(screen.queryByRole("heading", { name: /current account totals/i })).toBeNull());
    expect((screen.getByRole("textbox", { name: "Vault address" }) as HTMLInputElement).value).toBe("");
  });

  it("ignores a late snapshot after the URL's vault parameter has been removed", async () => {
    let finish!: (value: unknown) => void;
    mocks.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Observatory />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    mocks.search = {};
    view.rerender(<Observatory />);
    await act(async () => { finish({ ok: true, data: snapshot() }); });
    expect(screen.queryByRole("heading", { name: /current account totals/i })).toBeNull();
    expect(mocks.history).not.toHaveBeenCalled();
  });
});
