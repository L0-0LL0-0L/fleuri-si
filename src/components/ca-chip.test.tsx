import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panel links to the token page; stub the router so the test needs no route tree.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children?: React.ReactNode; to: string; params?: { mint: string } }) => (
    <a href={`${to}/${params?.mint ?? ""}`}>{children}</a>
  ),
}));

import { CaChip } from "./bits";
import { FLEURI_MINT } from "@/lib/token";

const ADDRESS = "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri";
const open = () => fireEvent.click(screen.getByRole("button", { name: "CA" }));

describe("CA button", () => {
  afterEach(cleanup);
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
  });

  it("holds the exact $FLEURI address", () => {
    expect(FLEURI_MINT).toBe(ADDRESS);
  });

  it("reveals the address only when CA is pressed", () => {
    render(<CaChip />);
    expect(screen.queryByText(ADDRESS)).toBeNull();
    open();
    expect(screen.getByText(ADDRESS)).toHaveTextContent(ADDRESS);
  });

  it("copies the exact address to the clipboard", async () => {
    render(<CaChip />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /copy address/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS));
    expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("says the address is not live yet instead of implying a live market", () => {
    render(<CaChip />);
    open();
    expect(screen.getByText(/not live yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/live price|graduated|holders/i)).toBeNull();
  });

  it("closes on Escape", () => {
    render(<CaChip />);
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(ADDRESS)).toBeNull();
  });
});
