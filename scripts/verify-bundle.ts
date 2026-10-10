// Standalone CLI verifier for a fleuri evidence bundle. Does not contact fleuri at all.
// Usage: bun scripts/verify-bundle.ts bundle.json [--rpc https://api.mainnet-beta.solana.com] [--gateway https://ipfs.io/ipfs/]
import { readFileSync } from "node:fs";
import { verifyBundle } from "../src/pq/evidence";
import { connectionReader, rpcConnection } from "../src/pq/evidence-reader";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const file = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!file) { console.error("usage: bun scripts/verify-bundle.ts bundle.json [--rpc URL] [--gateway URL]"); process.exit(2); }
const bundle = JSON.parse(readFileSync(file, "utf8"));
const rpc = opt("--rpc", bundle.cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
const gateway = opt("--gateway", "https://ipfs.io/ipfs/");
const r = await verifyBundle(bundle, connectionReader(rpcConnection(rpc), gateway));
for (const c of r.checks) console.log(`${c.status.toUpperCase().padEnd(11)} ${c.label} — ${c.detail}`);
console.log(`observed ${r.observedAt} via ${new URL(rpc).host} / ${new URL(gateway).host}`);
process.exit(r.checks.some((c) => c.status === "fail") ? 1 : r.checks.every((c) => c.status === "pass") ? 0 : 3);
