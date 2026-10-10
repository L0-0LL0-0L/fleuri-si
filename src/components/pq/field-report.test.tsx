import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldReport } from "./FieldReport";
afterEach(cleanup);
const AUTH = "9gMUCqxZ1wQ4bH3sV7yP2kLmN8rT5uE6cA1dF4gHnqRp";
const ok = (immutable: unknown, authority: unknown) => ({ status: "ok", loader: "BPFLoaderUpgradeab1e11111111111111111111111", programData: AUTH, immutable, authority, slot: 5 });
function report(tokenProgram: any, unavailable: Record<string, string> = {}) {
  return { jobId: "j", receipt: { outputDigest: "e".repeat(64), notice: "", payment: { transaction: "5".repeat(88), slot: 1, amount: "500000" } },
    report: { mint: AUTH, cluster: "mainnet-beta", observedSlot: 1, observedAt: "2026-10-10T00:00:00.000Z", disclaimer: "", unavailable: { protocol: "Not a fleuri launch.", ...unavailable },
      facts: { mint: { program: "spl-token", decimals: 6, supply: "1", mintAuthorityRevoked: true, freezeAuthorityRevoked: true }, metadata: null, holders: null, ...(tokenProgram ? { tokenProgram } : {}) } } };
}
const row = () => screen.getByText("Token program upgrade").parentElement as HTMLElement;
describe("field report upgrade authority", () => {
  it("shows upgradeable with the authority link when immutable=false", () => {
    render(<FieldReport result={report(ok(false, AUTH))} />);
    expect(row()).toHaveTextContent(/Upgradeable by/); expect(row()).not.toHaveTextContent(/Immutable/);
    expect(within(row()).getByRole("link")).toHaveAttribute("href", expect.stringContaining(AUTH));
  });
  it("shows immutable only when the validated flag is true", () => {
    render(<FieldReport result={report(ok(true, null))} />);
    expect(row()).toHaveTextContent(/Immutable/);
  });
  it.each([["missing flag", ok(undefined, AUTH)], ["non-boolean flag", ok("false", AUTH)], ["upgradeable without authority", ok(false, null)]])("treats %s as unavailable, never immutable", (_n, info) => {
    render(<FieldReport result={report(info)} />);
    expect(row()).not.toHaveTextContent(/Immutable/); expect(row()).not.toHaveTextContent(/Upgradeable by/); expect(row()).toHaveTextContent(/n\/a/i);
  });
  it("shows the reader's unavailable reason when no fact was recorded", () => {
    render(<FieldReport result={report(null, { tokenProgram: "Loader X is not decoded here." })} />);
    expect(row()).toHaveTextContent("Loader X is not decoded here."); expect(row()).not.toHaveTextContent(/Immutable/);
  });
});
