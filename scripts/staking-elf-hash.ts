// Computes POLLEN_STAKING_PROGRAM_SHA256 for a local .so using the SAME normalization the server
// applies to on-chain ProgramData (src/pq/staking.ts programElf): SHA-256 over the ELF bytes with
// all trailing 0x00 bytes removed. Usage: bun scripts/staking-elf-hash.ts target/deploy/pollen_staking.so
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/staking-elf-hash.ts <program.so>");
const b = readFileSync(path);
let end = b.length; while (end > 0 && b[end - 1] === 0) end--;
console.log(createHash("sha256").update(b.subarray(0, end)).digest("hex"));
