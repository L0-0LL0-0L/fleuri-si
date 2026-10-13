// Standalone Blind Bloom bundle verifier. Recomputes commitments, scenarios, comparisons and scores offline.
// Usage: bun scripts/verify-bloom.ts bundle.json   (exit 0 verified, 1 mismatch, 2 usage, 3 invalid/unsupported)
import { readFileSync, statSync } from "node:fs";
import { BLOOM_LIMITS, verifyBloomBundle } from "../src/domain/bloom";

const file = process.argv[2];
if (!file) { console.error("usage: bun scripts/verify-bloom.ts bundle.json"); process.exit(2); }
if (statSync(file).size > BLOOM_LIMITS.bundleBytes) { console.error("INVALID bundle larger than the size limit"); process.exit(3); }
const r = verifyBloomBundle(readFileSync(file, "utf8"));
for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.id.padEnd(12)} ${c.detail}`);
console.log(`${r.status.toUpperCase()}: ${r.detail}`);
process.exit(r.status === "verified" ? 0 : r.status === "mismatch" ? 1 : 3);
