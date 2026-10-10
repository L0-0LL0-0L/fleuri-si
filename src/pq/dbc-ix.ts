// Decoder for Meteora DBC initialize_virtual_pool_with_spl_token, per the pinned SDK IDL.
// Pure (no RPC); used by the portable verifier. Unknown discriminators are rejected.
export const INIT_SPL_DISCRIMINATOR = [140, 85, 215, 176, 102, 54, 104, 79];
export const INIT_SPL_ACCOUNTS = ["config", "pool_authority", "creator", "base_mint", "quote_mint", "pool", "base_vault", "quote_vault", "mint_metadata", "metadata_program", "payer", "token_quote_program", "token_program", "system_program", "event_authority", "program"] as const;
export type InitSpl = { name: string; symbol: string; uri: string; accounts: Record<(typeof INIT_SPL_ACCOUNTS)[number], string> };

function readStr(d: Uint8Array, o: number, max: number): [string, number] {
  if (o + 4 > d.length) throw new Error("Truncated string length.");
  const len = new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
  if (len > max || o + 4 + len > d.length) throw new Error("String length out of range.");
  return [new TextDecoder("utf-8", { fatal: true }).decode(d.subarray(o + 4, o + 4 + len)), o + 4 + len];
}

export function decodeInitSpl(data: Uint8Array, accounts: string[]): InitSpl {
  if (data.length < 8 || INIT_SPL_DISCRIMINATOR.some((b, i) => data[i] !== b)) throw new Error("Not an initialize_virtual_pool_with_spl_token instruction.");
  let o = 8; let name: string, symbol: string, uri: string;
  [name, o] = readStr(data, o, 64); [symbol, o] = readStr(data, o, 32); [uri, o] = readStr(data, o, 400);
  if (o !== data.length) throw new Error("Unexpected trailing instruction data.");
  if (accounts.length < INIT_SPL_ACCOUNTS.length) throw new Error("Instruction has too few accounts.");
  const acc = Object.fromEntries(INIT_SPL_ACCOUNTS.map((k, i) => [k, accounts[i]])) as InitSpl["accounts"];
  return { name, symbol, uri, accounts: acc };
}
