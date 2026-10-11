// Standalone CLI verifier for a Fleuri research receipt. Uses no Fleuri server or database.
// Usage: bun scripts/verify-receipt.ts receipt.json [--rpc https://api.devnet.solana.com]
import { readFileSync } from "node:fs";
import { verifyAnchor, verifyReceiptBundle } from "../src/pq/receipt";

const args = process.argv.slice(2);
const i = args.indexOf("--rpc"); const rpc = i >= 0 ? args[i + 1] : null;
const file = args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--rpc");
if (!file) { console.error("usage: bun scripts/verify-receipt.ts receipt.json [--rpc URL]"); process.exit(2); }
const v = verifyReceiptBundle(readFileSync(file, "utf8"));
if (rpc && v.manifest && v.bundle) {
  const [{ rpcConnection }, { readConfirmedTxEx }] = await Promise.all([import("../src/pq/evidence-reader"), import("../src/pq/chain-read")]);
  const conn = rpcConnection(rpc);
  const a = await verifyAnchor(v.manifest, v.bundle.manifestHash, v.bundle.anchorHint, { genesis: () => conn.getGenesisHash(), tx: (s) => readConfirmedTxEx(conn, s) as any });
  v.checks[v.checks.findIndex((c) => c.id === "anchor")] = a;
}
for (const c of v.checks) console.log(`${c.status.toUpperCase().padEnd(11)} ${c.label} — ${c.detail}`);
console.log(v.valid ? "VALID research receipt (a signature attests bytes; it does not rate the strategy)" : "NOT VALID");
process.exit(v.valid ? 0 : 1);
