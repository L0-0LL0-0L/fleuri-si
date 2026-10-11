// AGENTS.md: browser code must not import @solana/spl-token. The receipt UI and its chain reader stay
// on the small fetch-based memo reader instead of the evidence-reader/chain-read modules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = ["src/components/receipts/ReceiptChecks.tsx", "src/routes/receipts.$id.tsx", "src/routes/receipts.new.tsx", "src/routes/receipts.index.tsx", "src/pq/memo-reader.ts", "src/pq/anchor-review.ts", "src/pq/receipt.ts", "scripts/verify-receipt.ts"];
describe("receipt browser import hygiene", () => {
  it.each(files)("%s does not import spl-token, evidence-reader or chain-read", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/@solana\/spl-token|pq\/evidence-reader|pq\/chain-read|\.\/chain-read|\.\/evidence-reader/);
  });
});
