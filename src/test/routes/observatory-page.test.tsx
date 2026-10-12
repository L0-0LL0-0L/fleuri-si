// Rendered /observatory with fixture server replies: pagination guard, gaps, stale replies, route
// changes and network failures. Chain reads are faked; the real page logic is under test.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: {} as { vault?: string }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (o: any) => ({ ...o, useSearch: () => h.search, useNavigate: () => h.navigate }),
  Link: ({ children }: any) => <a>{children}</a>,
}));
vi.mock("@/lib/observatory.functions", () => ({ obsSnapshot: vi.fn(), obsHistory: vi.fn(), obsKnown: vi.fn() }));
vi.mock("@/components/pq/ui", () => ({
  Panel: ({ title, children }: any) => <section aria-label={title}>{children}</section>,
  RealBadge: () => null, downloadBlob: vi.fn(), explorerTx: () => "#", explorerAddr: () => "#",
}));
vi.mock("@/components/PixelFlower", () => ({ FlowerTiles: () => null }));
vi.mock("@/components/bits", () => ({ PageHeader: () => null }));

import { Observatory, EXAMPLE_VAULT } from "@/routes/observatory";
import { obsHistory, obsKnown, obsSnapshot } from "@/lib/observatory.functions";

const A = "A".repeat(43), B = "B".repeat(43), TV = "T".repeat(43);
const vault = (address: string) => ({ address, tokenVault: TV, mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, supported: true, funded: "100", claimed: "0", unclaimed: "100", dust: "0", totalShare: 1, recipients: [], owner: "O".repeat(43), base: "b", feeVaultType: 0, pdaIssues: [] });
const snap = (address: string) => ({ ok: true, data: { cluster: "mainnet-beta", genesisHash: "g", slot: 10, observedAt: new Date(0).toISOString(), program: "dfs", vault: vault(address) } });
const tx = (signature: string, slot: number, extra: any = {}) => ({ signature, slot, blockTime: 1, status: "success", via: ["vault"], entries: [{ kind: "fund", amount: "7", source: "dbc_creator_trading_fee", sourceProgram: "dbc", evidence: "proved", feePerShare: "1" }], otherVaultEvents: 0, ...extra });
const cov = (oldest: string, exhausted: boolean) => ({ address: "x", oldestSignature: oldest, oldestSlot: 1, pages: 1, exhausted, error: null });
const page = (address: string, txs: any[], exhausted = false) => ({ ok: true, data: { cluster: "mainnet-beta", vault: address, observedAt: "", txs, coverage: { vault: cov(txs.at(-1)?.signature ?? "none", exhausted), tokenVault: cov(txs.at(-1)?.signature ?? "none", exhausted) } } });
const deferred = <T,>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((r, j) => { res = r; rej = j; }); return { p, res, rej }; };

afterEach(cleanup);
beforeEach(() => {
  h.search = {}; h.navigate.mockReset();
  vi.mocked(obsSnapshot).mockReset(); vi.mocked(obsHistory).mockReset();
  vi.mocked(obsKnown).mockReset().mockResolvedValue({ ok: true, data: { cluster: "mainnet-beta", vaults: [] } } as any);
});

describe("observatory page", () => {
  it("loads older history once per click burst, passing the cursor, and merges the page", async () => {
    h.search = { vault: A };
    vi.mocked(obsSnapshot).mockResolvedValue(snap(A) as any);
    vi.mocked(obsHistory).mockResolvedValueOnce(page(A, [tx("sig-new", 9)]) as any);
    render(<Observatory />);
    await screen.findByText(/sig-new/);
    const older = deferred<any>(); vi.mocked(obsHistory).mockReturnValueOnce(older.p);
    const btn = screen.getByRole("button", { name: "Load older" });
    fireEvent.click(btn); fireEvent.click(btn); fireEvent.click(btn);
    expect(obsHistory).toHaveBeenCalledTimes(2);
    expect(vi.mocked(obsHistory).mock.calls[1][0]).toEqual({ data: { vault: A, streams: ["vault", "tokenVault"], cursors: { vault: "sig-new", tokenVault: "sig-new" } } });
    await act(async () => older.res(page(A, [tx("sig-old", 3)], true)));
    expect(screen.getByText(/sig-old/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "End of RPC history" })).toBeTruthy();
    expect(screen.queryByText(/full history/i)).toBeNull();
    expect(screen.getByText(/not proof of complete history/)).toBeTruthy();
  });

  it("shows rate-limited / unread transactions as gaps outside totals", async () => {
    h.search = { vault: A };
    vi.mocked(obsSnapshot).mockResolvedValue(snap(A) as any);
    vi.mocked(obsHistory).mockResolvedValue(page(A, [tx("sig-ok", 9), tx("sig-gap", 8, { status: "unavailable", entries: [], reason: "Not read: the RPC rate-limited this request. Retry later." })]) as any);
    render(<Observatory />);
    await screen.findByText(/rate-limited this request/);
    expect(screen.getAllByText(/1 transaction\(s\) could not be read or decoded and are gaps/).length).toBeGreaterThan(0);
    // Only the readable deposit counts: 7 base units = 0.000000007 SOL.
    expect(screen.getAllByText("0.000000007 SOL").length).toBeGreaterThan(0);
  });

  it("ignores a stale lookup that resolves after the route moved to another vault", async () => {
    const slowA = deferred<any>();
    vi.mocked(obsSnapshot).mockImplementation(({ data }: any) => (data.vault === A ? slowA.p : Promise.resolve(snap(B))) as any);
    vi.mocked(obsHistory).mockImplementation(({ data }: any) => Promise.resolve(page(data.vault, [tx(`sig-${data.vault[0]}`, 5)])) as any);
    h.search = { vault: A };
    const { rerender } = render(<Observatory />);
    h.search = { vault: B }; rerender(<Observatory />);
    await screen.findByText(/sig-B/);
    await act(async () => slowA.res(snap(A)));
    expect(screen.queryByText(/sig-A/)).toBeNull();
    expect(screen.getByText(new RegExp(B))).toBeTruthy();
  });

  it("clears the lookup when the route loses its vault", async () => {
    h.search = { vault: A };
    vi.mocked(obsSnapshot).mockResolvedValue(snap(A) as any);
    vi.mocked(obsHistory).mockResolvedValue(page(A, [tx("sig-new", 9)]) as any);
    const { rerender } = render(<Observatory />);
    await screen.findByText(/sig-new/);
    h.search = {}; rerender(<Observatory />);
    await waitFor(() => expect(screen.queryByText(/sig-new/)).toBeNull());
    expect((screen.getByLabelText("Vault address") as HTMLInputElement).value).toBe("");
  });

  it("recovers from a network rejection while paging and discards replies for another vault", async () => {
    h.search = { vault: A };
    vi.mocked(obsSnapshot).mockResolvedValue(snap(A) as any);
    vi.mocked(obsHistory).mockResolvedValueOnce(page(A, [tx("sig-new", 9)]) as any);
    render(<Observatory />);
    await screen.findByText(/sig-new/);
    vi.mocked(obsHistory).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
    vi.mocked(obsHistory).mockResolvedValueOnce(page(B, [tx("sig-wrong", 2)]) as any);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText(/did not match this vault/);
    expect(screen.queryByText(/sig-wrong/)).toBeNull();
  });

  it("offers the public example only on mainnet and survives a failed vault list", async () => {
    render(<Observatory />);
    fireEvent.click(await screen.findByRole("button", { name: "Try a public example vault" }));
    expect(h.navigate).toHaveBeenCalledWith({ search: { vault: EXAMPLE_VAULT }, replace: false });
    cleanup();
    vi.mocked(obsKnown).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<Observatory />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Try a public example vault" })).toBeNull();
    expect(screen.getByLabelText("Vault address")).toBeTruthy();
  });
});
