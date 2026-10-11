import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReceiptFileVerifier } from "./ReceiptChecks";
afterEach(cleanup);

describe("receipt file verifier", () => {
  it("shows a recoverable error when reading the file fails", async () => {
    render(<ReceiptFileVerifier />);
    const f = new File(["{}"], "r.json", { type: "application/json" });
    Object.defineProperty(f, "text", { value: () => Promise.reject(new Error("disk gone")) });
    fireEvent.change(screen.getByLabelText("Research receipt file"), { target: { files: [f] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not read r\.json: disk gone.*retry/);
  });
});
