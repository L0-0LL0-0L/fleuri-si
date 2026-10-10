// @vitest-environment node
// Cross-checks Fleuri's DBC decoder against the pinned SDK's Anchor coder (createDbcProgram(conn).program.coder.instruction).
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createDbcProgram } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { decodeInitSpl, INIT_SPL_DISCRIMINATOR, INIT_SPL_ACCOUNTS } from "./dbc-ix";
import { deriveInitAccounts, derivePool } from "./chain-read";

const program = createDbcProgram(new Connection("http://127.0.0.1:1")).program as any;
const coder = program.coder.instruction;
const k = () => Keypair.generate().publicKey;

describe("DBC initialize decoder vs pinned SDK coder", () => {
  it("encodes initializeVirtualPoolWithSplToken with the expected discriminator and fields", async () => {
    const params = { name: "Bloom", symbol: "BLOOM", uri: "ipfs://bafyexample" };
    const data: Buffer = coder.encode("initializeVirtualPoolWithSplToken", { params });
    expect([...data.subarray(0, 8)]).toEqual(INIT_SPL_DISCRIMINATOR);
    const back = coder.decode(data);
    expect(back.name).toBe("initializeVirtualPoolWithSplToken");
    expect(back.data.params).toEqual(params);

    const config = k(), creator = k(), mint = k(); const pool = new PublicKey(derivePool(mint.toBase58(), config.toBase58()));
    const d = deriveInitAccounts(mint.toBase58(), pool.toBase58()); const P = (s: string) => new PublicKey(s);
    const ix = await program.methods.initializeVirtualPoolWithSplToken(params).accountsPartial({
      config, poolAuthority: P(d.poolAuthority), creator, baseMint: mint, quoteMint: P("So11111111111111111111111111111111111111112"), pool,
      baseVault: P(d.baseVault), quoteVault: P(d.quoteVault), mintMetadata: P(d.mintMetadata), metadataProgram: P("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
      payer: creator, tokenQuoteProgram: P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), tokenProgram: P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), systemProgram: P("11111111111111111111111111111111"),
    }).instruction();
    expect(ix.keys.length).toBe(INIT_SPL_ACCOUNTS.length);
    const dec = decodeInitSpl(new Uint8Array(ix.data), ix.keys.map((x: any) => x.pubkey.toBase58()));
    expect({ name: dec.name, symbol: dec.symbol, uri: dec.uri }).toEqual(params);
    expect(dec.accounts.config).toBe(ix.keys[0].pubkey.toBase58());
    expect(dec.accounts.creator).toBe(creator.toBase58()); expect(ix.keys[2].isSigner).toBe(true);
    expect(dec.accounts.base_mint).toBe(mint.toBase58()); expect(ix.keys[3].isSigner).toBe(true);
    expect(dec.accounts.quote_mint).toBe("So11111111111111111111111111111111111111112");
    expect(dec.accounts.pool).toBe(pool.toBase58());
  });
  it("rejects other DBC instructions encoded by the same coder", () => {
    const data = coder.encode("initializeVirtualPoolWithToken2022", { params: { name: "a", symbol: "b", uri: "c" } });
    expect(() => decodeInitSpl(new Uint8Array(data), Array(16).fill(k().toBase58()))).toThrow();
  });
});
