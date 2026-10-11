// Rendered launchpad approval: a deferred pqPrepareLaunch must never open the wallet or submit after
// the owner changes (in the store or via re-render) or the page unmounts. Chain/crypto are mocked.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: "owner-a" as string | null, live: "owner-a" as string | null, sign: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (o: any) => o, Link: ({ children }: any) => <a>{children}</a> }));
vi.mock("@/store/garden", () => ({ useGarden: () => ({ userId: h.user, state: { agents: {} }, store: { get: () => ({ userId: h.live }), startSandbox: async () => {} } }) }));
vi.mock("@/lib/pq.functions", () => ({
  getPqReadiness: vi.fn(async () => ({ ok: true, data: { ready: true, cluster: "devnet", checks: [], dbcConfig: "C" } })),
  pqMine: vi.fn(async () => ({ ok: true, data: { identities: [{ id: "i1", key_hash: "K", cluster: "devnet", status: "anchored" }], launches: [], preparations: [] } })),
  pqPublicLaunches: vi.fn(async () => ({ ok: true, data: [] })), pqLaunchProposals: vi.fn(async () => ({ ok: true, data: [] })),
  pqStartLaunch: vi.fn(async () => ({ ok: true, data: { template: { token: {} } } })), pqPrepareLaunch: vi.fn(),
  pqPinImage: vi.fn(), pqPrepareMigration: vi.fn(), pqRefreshLifecycle: vi.fn(), pqSetProposalStatus: vi.fn(),
}));
vi.mock("@/lib/greenhouse.functions", () => ({ ghEvidence: vi.fn(async () => ({ ok: true, data: [] })), ghMyRuns: vi.fn(async () => ({ ok: true, data: [] })) }));
vi.mock("@/lib/research.functions", () => ({ rrForRuns: vi.fn() }));
vi.mock("@/pq/local", () => ({ loadLocal: () => {}, usePqLocal: () => ({ unlocked: true, backupAck: true, envelope: { keyHash: "K" } }), withSecret: (fn: any) => fn({}) }));
vi.mock("@/pq/passport", () => ({ parseManifest: (m: any) => m, signPassport: () => ({ manifestHash: "H".repeat(64) }) }));
vi.mock("@/components/pq/ui", () => ({
  Panel: ({ children }: any) => <section>{children}</section>, CheckList: () => null, PassportTerms: () => null, PendingTransactions: () => null, RealBadge: () => null,
  WalletButtons: ({ onPick, busy }: any) => <button type="button" disabled={!!busy} onClick={() => onPick("phantom")}>Launch with Phantom</button>,
  downloadPassport: () => {}, explorerTx: () => "#", lifecycleLabel: {}, useWallets: () => ({ phantom: true, solflare: false }),
  signSubmitConfirm: (...a: any[]) => h.sign(...a),
}));
vi.mock("@/components/greenhouse/ProposalEvidence", () => ({ AttachEvidence: () => null, EvidenceList: () => null, FrozenEvidence: () => null, freezeReview: () => ({}), originAgentId: () => null }));
vi.mock("@/components/bits", () => ({ PageHeader: () => null }));
vi.mock("@/components/PixelFlower", () => ({ FlowerTiles: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn() } }));

import { Launchpad } from "@/routes/launchpad";
import { pqPrepareLaunch } from "@/lib/pq.functions";

const deferred = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };
const prepOk = { ok: true, data: { preparationId: "p", transaction: "AA==" } };
afterEach(cleanup);
beforeEach(() => { h.user = h.live = "owner-a"; h.sign.mockReset(); h.sign.mockResolvedValue({ signature: "S", detail: "ok" }); vi.mocked(pqPrepareLaunch).mockReset(); });

async function reachWallet() {
  const view = render(<Launchpad />);
  const go = await screen.findByText("Review exact launch terms");
  await waitFor(() => expect(go).toBeEnabled());
  fireEvent.change(screen.getByPlaceholderText("a strange little bloom"), { target: { value: "Rose" } });
  fireEvent.change(screen.getByPlaceholderText("BLOOM"), { target: { value: "ROSE" } });
  fireEvent.submit(go.closest("form")!);
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByText("Sign launch passport"));
  const d = deferred<any>(); vi.mocked(pqPrepareLaunch).mockReturnValue(d.p);
  fireEvent.click(await screen.findByText("Launch with Phantom"));
  await waitFor(() => expect(pqPrepareLaunch).toHaveBeenCalled());
  return { view, d };
}

describe("launch approval scope around preparation", () => {
  it("opens the wallet with the captured co-signer when nothing changes", async () => {
    const { d } = await reachWallet();
    await act(async () => { d.res(prepOk); });
    await waitFor(() => expect(h.sign).toHaveBeenCalledTimes(1));
    expect(h.sign.mock.calls[0][2].coSign).toHaveLength(1);
  });
  it("live store owner change during preparation: wallet never opens", async () => {
    const { d } = await reachWallet();
    h.live = "owner-b";
    await act(async () => { d.res(prepOk); });
    expect(h.sign).not.toHaveBeenCalled();
  });
  it("owner change re-render during preparation: wallet never opens", async () => {
    const { view, d } = await reachWallet();
    h.user = h.live = "owner-b"; view.rerender(<Launchpad />);
    await act(async () => { d.res(prepOk); });
    expect(h.sign).not.toHaveBeenCalled();
  });
  it("unmount during preparation: wallet never opens", async () => {
    const { view, d } = await reachWallet();
    view.unmount();
    await act(async () => { d.res(prepOk); });
    expect(h.sign).not.toHaveBeenCalled();
  });
  it("a scope change while the wallet is open makes the guard refuse submission", async () => {
    let guard: () => boolean = () => true; h.sign.mockImplementation((_k: any, _p: any, o: any) => { guard = o.guard; return new Promise(() => {}); });
    const { d } = await reachWallet();
    await act(async () => { d.res(prepOk); });
    await waitFor(() => expect(h.sign).toHaveBeenCalled());
    expect(guard()).toBe(true); h.live = "owner-b"; expect(guard()).toBe(false);
  });
});
