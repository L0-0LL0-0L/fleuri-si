// Some Solana packages (spl-token-metadata) reference a global Buffer at import time.
import { Buffer } from "buffer";
const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
export {};
