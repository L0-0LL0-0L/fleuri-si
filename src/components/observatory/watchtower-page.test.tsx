import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ search: {} as any, watch: vi.fn(), known: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (o: any) => ({ ...o, useSearch: () => m.search, useNavigate: () => m.navigate }), Link: ({ children }: any) => <a>{children}</a> }));
vi.mock("@/lib/watchtower.functions", () => ({ wtWatch: m.watch, wtKnown: m.known }));
vi.mock("@/components/bits", () => ({ PageHeader: () => null }));
vi.mock("@/components/PixelFlower", () => ({ FlowerTiles: () => null }));
vi.mock("@/components/pq/ui", () => ({ Panel: ({ title, children }: any) => <section><h2>{title}</h2>{children}</section>, RealBadge: () => null, downloadBlob: vi.fn(), explorerAddr: () => "#" }));
import { Watchtower } from "@/routes/watchtower";
const A = "A".repeat(43), B = "B".repeat(43);
const reply = (pool: string) => ({ ok: true, data: { input: { cluster: "mainnet-beta", genesisHash: "g".repeat(10), fetchedAt: new Date(0).toISOString(), slots: { pool: 1, config: 1, damm: null, positions: null }, nowUnix: null,
  pool: { address: pool, baseMint: "M".repeat(43), quoteReserve: "1", migrationProgress: 0, isMigrated: 0 }, config: null, damm: { derived: null, derivationNote: "", account: "not_read", facts: null }, discovery: null, positions: [], positionErrors: [], vaults: [] },
  summary: { stage: { stage: "curve_active", reason: `reason-${pool[0]}` }, progressBps: null, checks: [], damm: { ok: false, reason: "no" }, configured: null, positions: [], routing: [], caveat: "c" } } });
beforeEach(() => { m.search = {}; m.watch.mockReset(); m.known.mockReset().mockResolvedValue({ ok: true, data: { cluster: "mainnet-beta", launches: [] } }); });
afterEach(cleanup);
describe("watchtower page", () => {
  it("drops a stale reply after the URL moves to another pool, and clears on empty URL", async () => {
    let finishA!: (v: any) => void;
    m.watch.mockImplementation(({ data }: any) => data.pool === A ? new Promise((r) => { finishA = r; }) : Promise.resolve(reply(B)));
    m.search = { pool: A }; const v = render(<Watchtower />);
    m.search = { pool: B }; v.rerender(<Watchtower />);
    await screen.findByText("reason-B");
    await act(async () => finishA(reply(A)));
    expect(screen.queryByText("reason-A")).toBeNull();
    m.search = {}; v.rerender(<Watchtower />);
    await waitFor(() => expect(screen.queryByText("reason-B")).toBeNull());
  });
  it("drops pool A when pool B is loading, rejected or mismatched, so A can't be read or exported", async () => {
    m.watch.mockResolvedValueOnce(reply(A));
    m.search = { pool: A }; const v = render(<Watchtower />);
    await screen.findByText("reason-A");
    let failB!: (e: any) => void;
    m.watch.mockImplementationOnce(() => new Promise((_, rej) => { failB = rej; }));
    m.search = { pool: B }; v.rerender(<Watchtower />);
    await waitFor(() => expect(screen.queryByText("reason-A")).toBeNull());
    expect(screen.queryByRole("button", { name: "Download JSON" })).toBeNull();
    await act(async () => failB(new TypeError("Failed to fetch")));
    expect(screen.queryByText("reason-A")).toBeNull(); expect(screen.queryByRole("button", { name: "Download JSON" })).toBeNull();
    cleanup();
    m.watch.mockResolvedValueOnce(reply(A)).mockResolvedValueOnce(reply(A)); // second reply answers B with A's data
    m.search = { pool: A }; const w = render(<Watchtower />);
    await screen.findByText("reason-A");
    m.search = { pool: B }; w.rerender(<Watchtower />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not match/);
    expect(screen.queryByText("reason-A")).toBeNull(); expect(screen.queryByRole("button", { name: "Download JSON" })).toBeNull();
  });
  it("offers Watch $FLEURI only on mainnet and reads the token.ts pool live", async () => {
    const { FLEURI_POOL } = await import("@/lib/token");
    m.known.mockResolvedValueOnce({ ok: true, data: { cluster: "devnet", launches: [] } });
    render(<Watchtower />);
    await waitFor(() => expect(m.known).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Watch $FLEURI" })).toBeNull();
    cleanup();
    render(<Watchtower />);
    (await screen.findByRole("button", { name: "Watch $FLEURI" })).click();
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { pool: FLEURI_POOL } })));
    expect(screen.getByText(/not through fleuri's launchpad/)).toBeTruthy();
  });
  it("shows a safe error on failure and on a network rejection", async () => {
    m.watch.mockResolvedValueOnce({ ok: false, error: "This account is not owned by Meteora Dynamic Bonding Curve." });
    m.search = { pool: A }; const v = render(<Watchtower />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not owned/);
    cleanup(); m.watch.mockRejectedValueOnce(new TypeError("Failed to fetch")); m.search = { pool: B }; render(<Watchtower />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be completed/);
    void v;
  });
});
