// Rendered /receipts/$id journeys with deferred server responses. Crypto/chain machinery is mocked
// (tested separately); the real page, its fences and its busy-state handling are under test.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ params: { id: "" }, user: null as string | null, refresh: null as null | (() => Promise<void>), signImpl: null as any }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (o: any) => ({ ...o, useParams: () => h.params, useSearch: () => ({}) }),
  Link: ({ children }: any) => <a>{children}</a>,
}));
vi.mock("@/store/garden", () => ({ useGarden: () => ({ userId: h.user }) }));
vi.mock("@/lib/research.functions", () => ({ rrGet: vi.fn(), rrPublic: vi.fn(), rrPrepareAnchor: vi.fn(), rrPublish: vi.fn() }));
vi.mock("@/lib/pq.functions", () => ({ pqMine: vi.fn(async () => ({ ok: true, data: { preparations: [] } })) }));
vi.mock("@/components/pq/ui", () => ({
  Panel: ({ title, children }: any) => <section aria-label={title}>{children}</section>,
  PendingTransactions: ({ onRefresh }: any) => { h.refresh = onRefresh; return null; },
  RealBadge: () => null, downloadBlob: () => {}, explorerTx: () => "#", useWallets: () => ({ phantom: true, solflare: false }),
  WalletButtons: ({ disabled, busy, onPick }: any) => <button type="button" disabled={disabled || !!busy} onClick={() => onPick("phantom")}>Anchor with Phantom</button>,
  signSubmitConfirm: (...a: any[]) => h.signImpl(...a),
}));
vi.mock("@/components/receipts/ReceiptChecks", () => ({ AnchorRpcCheck: () => null, ChecksList: () => null }));
vi.mock("@/components/receipts/ManifestReview", () => ({ ManifestReview: ({ hash }: any) => <p data-testid="manifest">{hash}</p> }));
vi.mock("@/components/greenhouse/TrialReport", () => ({ TrialReport: () => null }));
vi.mock("@/components/PixelFlower", () => ({ FlowerTiles: () => null }));
vi.mock("@/components/bits", () => ({ PageHeader: () => null, ListSkeleton: () => <p>loading</p>, EmptyState: ({ body }: any) => <p>{body}</p>, CopyLink: () => null }));
vi.mock("./receipts.index", () => ({ ScopeNote: () => null }));
vi.mock("@/pq/receipt", () => ({ verifyReceiptBundle: () => ({ valid: true, checks: [] }), isLegacyManifest: () => false }));
vi.mock("@/pq/anchor-review", () => ({ reviewAnchorPrep: () => ({ ok: true, problems: [], memo: "m", feePayer: "W", signers: ["W"] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn() } }));

import { ReceiptPage } from "./receipts.$id";
import { rrGet, rrPrepareAnchor, rrPublic } from "@/lib/research.functions";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (id: string, hash: string) => ({ id, mine: true, status: "signed", published: false, anchor_status: "none", manifest_hash: hash, bundle: {}, manifest: { domain: "d", issuer: { wallet: "W" }, cluster: "devnet", genesisHash: "G", source: { runId: "r" } }, experiment: { input: { engineVersion: "e", config: { agentIds: [] } } } });
const deferred = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };
afterEach(cleanup);
beforeEach(() => { vi.mocked(rrGet).mockReset(); vi.mocked(rrPublic).mockReset(); vi.mocked(rrPrepareAnchor).mockReset(); });

describe("receipt page: anchor flow keeps controls usable", () => {
  it("prepare → sign → deferred reload re-enables Review & publish", async () => {
    h.params = { id: A }; h.user = "owner-a";
    vi.mocked(rrGet).mockResolvedValueOnce({ ok: true, data: row(A, "hash-a") } as any);
    vi.mocked(rrPrepareAnchor).mockResolvedValue({ ok: true, data: { preparationId: "p1", transaction: "", memo: "m", wallet: "W", cluster: "devnet", expiresAt: new Date(Date.now() + 60_000).toISOString() } } as any);
    h.signImpl = async () => ({ signature: "S", detail: "Anchored" });
    render(<ReceiptPage />);
    await screen.findByText("Prepare anchor");
    fireEvent.click(screen.getByText("Prepare anchor"));
    const reload = deferred<any>(); vi.mocked(rrGet).mockReturnValueOnce(reload.p);
    fireEvent.click(await screen.findByText("Anchor with Phantom"));
    await waitFor(() => expect(rrGet).toHaveBeenCalledTimes(2));
    await act(async () => { reload.res({ ok: true, data: row(A, "hash-a") }); });
    await waitFor(() => expect(screen.getByText("Review & publish")).toBeEnabled());
  });
  it("cancel while the wallet is open discards the late signature and frees the controls", async () => {
    h.params = { id: A }; h.user = "owner-a";
    vi.mocked(rrGet).mockResolvedValue({ ok: true, data: row(A, "hash-a") } as any);
    vi.mocked(rrPrepareAnchor).mockResolvedValue({ ok: true, data: { preparationId: "p1", transaction: "", memo: "m", wallet: "W", cluster: "devnet", expiresAt: new Date(Date.now() + 60_000).toISOString() } } as any);
    const wallet = deferred<any>(); let guard: () => boolean = () => true;
    h.signImpl = (_k: any, _p: any, o: any) => { guard = o.guard; return wallet.p; };
    render(<ReceiptPage />);
    fireEvent.click(await screen.findByText("Prepare anchor"));
    fireEvent.click(await screen.findByText("Anchor with Phantom"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(guard()).toBe(false); // the wallet helper would refuse to submit
    await act(async () => { wallet.res({ signature: "LATE", detail: "late" }); });
    expect(rrGet).toHaveBeenCalledTimes(1); // no reload from the discarded result
    expect(screen.getByText("Prepare anchor")).toBeEnabled();
    expect(screen.getByText("Review & publish")).toBeEnabled();
  });
});

describe("receipt page: stale callbacks after an owner/route change", () => {
  it("an old pending-refresh never replaces owner B's receipt B with public receipt A", async () => {
    h.params = { id: A }; h.user = "owner-a";
    vi.mocked(rrGet).mockResolvedValueOnce({ ok: true, data: row(A, "hash-a") } as any);
    const view = render(<ReceiptPage />);
    await waitFor(() => expect(screen.getByTestId("manifest")).toHaveTextContent("hash-a"));
    const oldRefresh = h.refresh!;
    h.params = { id: B }; h.user = "owner-b";
    vi.mocked(rrGet).mockResolvedValueOnce({ ok: true, data: row(B, "hash-b") } as any);
    view.rerender(<ReceiptPage />);
    await waitFor(() => expect(screen.getByTestId("manifest")).toHaveTextContent("hash-b"));
    vi.mocked(rrGet).mockResolvedValue({ ok: false, error: "not yours" } as any);
    vi.mocked(rrPublic).mockResolvedValue({ ok: true, data: row(A, "hash-a") } as any);
    const calls = vi.mocked(rrGet).mock.calls.length;
    await act(async () => { await oldRefresh(); });
    expect(vi.mocked(rrGet).mock.calls.length).toBe(calls); // not even issued
    expect(screen.getByTestId("manifest")).toHaveTextContent("hash-b");
  });
  it("does not briefly render the previous owner's receipt while the new one loads", async () => {
    h.params = { id: A }; h.user = "owner-a";
    vi.mocked(rrGet).mockResolvedValueOnce({ ok: true, data: row(A, "hash-a") } as any);
    const view = render(<ReceiptPage />);
    await screen.findByTestId("manifest");
    h.user = "owner-b"; vi.mocked(rrGet).mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<ReceiptPage />);
    expect(screen.queryByTestId("manifest")).toBeNull();
  });
  it("a load that resolves after unmount does nothing", async () => {
    h.params = { id: A }; h.user = "owner-a"; const d = deferred<any>(); vi.mocked(rrGet).mockReturnValueOnce(d.p);
    const view = render(<ReceiptPage />); view.unmount();
    await act(async () => { d.res({ ok: false, error: "x" }); });
    expect(rrPublic).not.toHaveBeenCalled();
  });
});
