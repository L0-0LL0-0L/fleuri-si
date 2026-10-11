// Rendered /receipts/new signing journeys. Remote signing and crypto are mocked (tested elsewhere);
// the real page callbacks, owner fencing and exact-signature recovery are under test.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: {} as any, user: "owner-a" as string | null, live: "owner-a" as string | null, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (o: any) => ({ ...o, useSearch: () => h.search }),
  useNavigate: () => h.navigate, Link: ({ children }: any) => <a>{children}</a>,
}));
vi.mock("@/store/garden", () => ({ useGarden: () => ({ userId: h.user, store: { get: () => ({ userId: h.live }), startSandbox: async () => {} } }) }));
vi.mock("@/lib/research.functions", () => ({ rrPrepare: vi.fn(), rrResume: vi.fn(), rrSign: vi.fn() }));
vi.mock("@/lib/greenhouse.functions", () => ({ ghRun: vi.fn() }));
vi.mock("@/lib/pq.functions", () => ({ pqMine: vi.fn() }));
vi.mock("@/pq/local", () => ({ loadLocal: () => {}, usePqLocal: () => ({ unlocked: true, envelope: { keyHash: "k".repeat(64) } }), withSecret: (fn: any) => fn({}) }));
vi.mock("@/pq/receipt", () => ({ receiptHash: () => "a".repeat(64), parseReceiptManifest: (m: any) => m, signReceipt: vi.fn(() => ({ publicKey: "PK", signature: "FRESH" })) }));
vi.mock("@/domain/greenhouse", async (orig) => ({ ...(await orig<any>()), SUPPORTED_ENGINES: ["greenhouse-rules-2"] }));
vi.mock("@/components/greenhouse/TrialReport", () => ({ TrialReport: () => null }));
vi.mock("@/components/receipts/ManifestReview", () => ({ ManifestReview: () => null }));
vi.mock("@/components/bits", () => ({ PageHeader: () => null, ListSkeleton: () => <p>loading</p> }));
vi.mock("@/components/pq/ui", () => ({ Panel: ({ children }: any) => <section>{children}</section> }));
vi.mock("@/routes/receipts.index", () => ({ ScopeNote: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { NewReceipt } from "@/routes/receipts.new";
import { rrResume, rrSign } from "@/lib/research.functions";
import { ghRun } from "@/lib/greenhouse.functions";
import { pqMine } from "@/lib/pq.functions";
import { signReceipt } from "@/pq/receipt";
import { readReceiptSig, receiptPendingKey, writeReceiptPending } from "@/lib/receipt-session";
import { toast } from "sonner";

const RUN = "33333333-3333-4333-8333-333333333333", RC = "55555555-5555-4555-8555-555555555555", ID = "66666666-6666-4666-8666-666666666666", REQ = "77777777-7777-4777-8777-777777777777";
const HASH = "a".repeat(64), KEY = "k".repeat(64);
const deferred = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear(); h.search = { draft: RC }; h.user = h.live = "owner-a"; h.navigate.mockReset(); vi.mocked(toast.success).mockReset();
  vi.mocked(rrSign).mockReset(); vi.mocked(signReceipt).mockClear();
  vi.mocked(rrResume).mockResolvedValue({ ok: true, data: { id: RC, status: "draft", runId: RUN, requestId: REQ, identityId: ID, manifestHash: HASH, manifest: { source: { runId: RUN }, issuer: { keyHash: KEY } } } } as any);
  vi.mocked(ghRun).mockResolvedValue({ ok: true, data: { id: RUN, mine: true, status: "done", input: { engineVersion: "greenhouse-rules-2" } } } as any);
  vi.mocked(pqMine).mockResolvedValue({ ok: true, data: { identities: [{ id: ID, key_hash: KEY, wallet: "WalletAAAAAA", cluster: "devnet", status: "registered" }] } } as any);
});
async function startSigning() {
  const view = render(<NewReceipt />);
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByText("Sign & save receipt"));
  await waitFor(() => expect(rrSign).toHaveBeenCalled());
  return view;
}

describe("signing page owner fencing", () => {
  it("a delayed rrSign success after the live store owner changes (before re-render) neither navigates nor toasts", async () => {
    const d = deferred<any>(); vi.mocked(rrSign).mockReturnValue(d.p);
    await startSigning();
    h.live = "owner-b"; // store changed; React has not rendered the new key yet
    await act(async () => { d.res({ ok: true, data: { recovered: false } }); });
    expect(h.navigate).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
    expect(readReceiptSig("owner-a", RC, HASH, localStorage)?.signature).toBe("FRESH"); // kept for A's recovery
  });
  it("a key-changing rerender (new owner) drops the old reply", async () => {
    const d = deferred<any>(); vi.mocked(rrSign).mockReturnValue(d.p);
    const view = await startSigning();
    h.user = h.live = "owner-b"; view.rerender(<NewReceipt />);
    await act(async () => { d.res({ ok: true, data: { recovered: false } }); });
    expect(h.navigate).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
  });
  it("unmount during save drops the reply and keeps the saved signature", async () => {
    const d = deferred<any>(); vi.mocked(rrSign).mockReturnValue(d.p);
    const view = await startSigning(); view.unmount();
    await act(async () => { d.res({ ok: true, data: { recovered: false } }); });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(readReceiptSig("owner-a", RC, HASH, localStorage)).not.toBeNull();
  });
  it("a stable owner navigates to the signed receipt", async () => {
    vi.mocked(rrSign).mockResolvedValue({ ok: true, data: { recovered: false } } as any);
    await startSigning();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: "/receipts/$id", params: { id: RC } }));
  });
  it("legacy recovery resends the exact earlier signature, not a fresh one", async () => {
    writeReceiptPending("owner-a", { requestId: REQ, runId: RUN, identityId: ID, receiptId: RC, manifestHash: HASH, publicKey: "OLDPK", signature: "OLDSIG" }, localStorage);
    expect(localStorage.getItem(receiptPendingKey("owner-a", RUN))).toContain("OLDSIG");
    vi.mocked(rrSign).mockResolvedValue({ ok: true, data: { recovered: true } } as any);
    render(<NewReceipt />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByText("Resend my saved signature"));
    await waitFor(() => expect(rrSign).toHaveBeenCalledWith({ data: { id: RC, publicKey: "OLDPK", signature: "OLDSIG" } }));
    expect(signReceipt).not.toHaveBeenCalled();
  });
  it("legacy signature survives a second reload before resend (durably migrated per draft)", async () => {
    writeReceiptPending("owner-a", { requestId: REQ, runId: RUN, identityId: ID, receiptId: RC, manifestHash: HASH, publicKey: "OLDPK", signature: "OLDSIG" }, localStorage);
    vi.mocked(rrSign).mockResolvedValue({ ok: true, data: { recovered: true } } as any);
    const first = render(<NewReceipt />);
    expect(await screen.findByText("Resend my saved signature")).toBeInTheDocument();
    first.unmount();
    expect(readReceiptSig("owner-a", RC, HASH, localStorage)).toMatchObject({ publicKey: "OLDPK", signature: "OLDSIG" });
    render(<NewReceipt />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(await screen.findByText("Resend my saved signature"));
    await waitFor(() => expect(rrSign).toHaveBeenCalledWith({ data: { id: RC, publicKey: "OLDPK", signature: "OLDSIG" } }));
    expect(signReceipt).not.toHaveBeenCalled();
  });
  it("keeps the old run record intact when the per-draft signature cannot be stored", async () => {
    writeReceiptPending("owner-a", { requestId: REQ, runId: RUN, identityId: ID, receiptId: RC, manifestHash: HASH, publicKey: "OLDPK", signature: "OLDSIG" }, localStorage);
    const orig = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) { if (k.startsWith("fleuri.receipt.sig")) throw new Error("quota"); return orig.call(this, k, v); });
    render(<NewReceipt />);
    expect(await screen.findByText("Resend my saved signature")).toBeInTheDocument();
    spy.mockRestore();
    expect(localStorage.getItem(receiptPendingKey("owner-a", RUN))).toContain("OLDSIG");
  });
});
