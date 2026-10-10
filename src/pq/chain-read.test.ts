// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, ExtensionType, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMintLen } from "@solana/spl-token";
import { decodeAnyMint, decodeUpgradeAuthority } from "./chain-read";

const UP = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const k = () => Keypair.generate().publicKey;
function programAcct(pd: PublicKey, owner = UP, executable = true) { const d = Buffer.alloc(36); d.writeUInt32LE(2, 0); pd.toBuffer().copy(d, 4); return { owner, executable, data: d }; }
function pdAcct(authority: PublicKey | null, tag = 3, flag?: number, len?: number) { const d = Buffer.alloc(len ?? 45); d.writeUInt32LE(tag, 0); d.writeBigUInt64LE(99n, 4); d[12] = flag ?? (authority ? 1 : 0); authority?.toBuffer().copy(d, 13); return { owner: UP, executable: false, data: d }; }
function mintData(o: { init?: boolean; auth?: PublicKey | null } = {}) { const d = Buffer.alloc(MINT_SIZE); MintLayout.encode({ mintAuthorityOption: o.auth ? 1 : 0, mintAuthority: o.auth ?? PublicKey.default, supply: 5n, decimals: 6, isInitialized: o.init ?? true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, d); return d; }

describe("upgrade authority decoding", () => {
  it("decodes upgradeable programs with and without authority", () => {
    const pd = k(), a = k();
    const r = decodeUpgradeAuthority(programAcct(pd), pdAcct(a), pd.toBase58());
    expect(r).toMatchObject({ status: "ok", authority: a.toBase58(), immutable: false, slot: 99 });
    expect(decodeUpgradeAuthority(programAcct(pd), pdAcct(null), pd.toBase58())).toMatchObject({ status: "ok", immutable: true, authority: null });
  });
  it("only calls known loaders immutable; unknown, non-executable and malformed are unavailable", () => {
    const pd = k();
    expect(decodeUpgradeAuthority({ owner: new PublicKey("BPFLoader2111111111111111111111111111111111"), executable: true, data: new Uint8Array() }, null).status).toBe("ok");
    expect(decodeUpgradeAuthority({ owner: new PublicKey("LoaderV411111111111111111111111111111111111"), executable: true, data: new Uint8Array(64) }, null).status).toBe("unavailable");
    expect(decodeUpgradeAuthority({ owner: TOKEN_PROGRAM_ID, executable: false, data: new Uint8Array(82) }, null).status).toBe("unavailable");
    expect(decodeUpgradeAuthority(programAcct(pd, UP, false), pdAcct(null)).status).toBe("unavailable");
    expect(decodeUpgradeAuthority(programAcct(pd), pdAcct(null, 1), pd.toBase58()).status).toBe("unavailable");
    expect(decodeUpgradeAuthority(programAcct(pd), pdAcct(null, 3, 7), pd.toBase58()).status).toBe("unavailable");
    expect(decodeUpgradeAuthority(programAcct(pd), pdAcct(k(), 3, 1, 30), pd.toBase58()).status).toBe("unavailable");
    expect(decodeUpgradeAuthority(programAcct(pd), { ...pdAcct(null), owner: k() }, pd.toBase58()).status).toBe("unavailable");
    expect(decodeUpgradeAuthority(programAcct(pd), pdAcct(null), k().toBase58()).status).toBe("unavailable");
  });
});

describe("strict mint decoding", () => {
  it("accepts an initialized SPL mint", () => {
    const a = k(); const r = decodeAnyMint(k().toBase58(), { owner: TOKEN_PROGRAM_ID, data: mintData({ auth: a }) });
    expect(r).toMatchObject({ program: "spl-token", decimals: 6, mintAuthority: a.toBase58(), freezeAuthority: null });
  });
  it("rejects token accounts, uninitialized, malformed and foreign-owned accounts", () => {
    const ta = Buffer.alloc(ACCOUNT_SIZE); AccountLayout.encode({ mint: k(), owner: k(), amount: 1n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, ta);
    expect(() => decodeAnyMint(k().toBase58(), { owner: TOKEN_PROGRAM_ID, data: ta })).toThrow();
    expect(() => decodeAnyMint(k().toBase58(), { owner: TOKEN_PROGRAM_ID, data: mintData({ init: false }) })).toThrow();
    expect(() => decodeAnyMint(k().toBase58(), { owner: TOKEN_PROGRAM_ID, data: new Uint8Array(40) })).toThrow();
    expect(() => decodeAnyMint(k().toBase58(), { owner: k(), data: mintData() })).toThrow(/not owned/);
  });
  it("names Token-2022 extensions", () => {
    const len = getMintLen([ExtensionType.MintCloseAuthority]); const d = Buffer.alloc(len); mintData().copy(d);
    d[165] = 1; d.writeUInt16LE(ExtensionType.MintCloseAuthority, 166); d.writeUInt16LE(32, 168);
    const r = decodeAnyMint(k().toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: d });
    expect(r.program).toBe("token-2022"); expect(r.extensions).toContain("MintCloseAuthority");
  });
});
