// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generatePqKeypair } from "./mldsa";
import { manifestFixture } from "./fixtures";
import { assertConfigTerms, validateImage } from "@/lib/pq.server";
import { readDbcConfig } from "@/lib/solana.server";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { StateService } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { DBC_PROGRAM_ID } from "./passport";
import { vi } from "vitest";
describe("public verification term binding",()=>{
  it("rejects signed displayed fees and permissions that differ even when the snapshot hash is unchanged",()=>{
    const kp=generatePqKeypair();const m=manifestFixture(kp);
    const config:any={problems:[],snapshot:m.config.snapshot,snapshotHash:m.config.snapshotHash,terms:{fees:m.fees,lp:m.lp,migration:m.migration,authority:m.authority,decimals:m.token.decimals,totalSupply:m.token.totalSupply}};
    expect(()=>assertConfigTerms(config,m)).not.toThrow();
    const altered=structuredClone(m);altered.fees.baseFeeBps++;
    expect(()=>assertConfigTerms(config,altered)).toThrow("economics");
    const changed=structuredClone(m);changed.authority.leftoverReceiver=m.creatorWallet;
    expect(()=>assertConfigTerms(config,changed)).toThrow("authority");kp.secretKey.fill(0);
  });
  it("checks image content and size before a paid pinning request",()=>{
    expect(()=>validateImage(new Uint8Array([137,80,78,71,13,10,26,10]),"image/png")).not.toThrow();
    expect(()=>validateImage(new TextEncoder().encode("<script>not an image</script>"),"image/png")).toThrow("contents");
    expect(()=>validateImage(new Uint8Array(1_000_001),"image/png")).toThrow("1 MB");
  });
  it("reads the actual graduated fee preset instead of the unused zero custom-fee field and rejects unsupported LP allocation",async()=>{
    const conn=new Connection("https://api.devnet.solana.com","confirmed");
    conn.getAccountInfo=async()=>({owner:new PublicKey(DBC_PROGRAM_ID),data:Buffer.alloc(8),lamports:1,executable:false});
    const cfg:any={quoteMint:NATIVE_MINT,migrationOption:1,tokenUpdateAuthority:1,fixedTokenSupplyFlag:1,tokenType:0,tokenDecimal:9,preMigrationTokenSupply:"1000000000",postMigrationTokenSupply:"1000000000",migrationFeeOption:0,migratedPoolFeeBps:0,creatorLiquidityPercentage:0,creatorPermanentLockedLiquidityPercentage:50,partnerLiquidityPercentage:0,partnerPermanentLockedLiquidityPercentage:50,poolFees:{baseFee:{baseFeeMode:0}}};
    const spy=vi.spyOn(StateService.prototype,"getPoolConfig").mockImplementation(async()=>cfg);
    try {
      const address=Keypair.generate().publicKey.toBase58();
      const fixed=await readDbcConfig(conn,address);expect(fixed.problems).toEqual([]);expect(fixed.terms.migration.migratedPoolFeeBps).toBe(25);expect(fixed.snapshot.migratedPoolFeeBps).toBe(0);
      cfg.migrationFeeOption=6;cfg.migratedPoolFeeBps=37;
      expect((await readDbcConfig(conn,address)).terms.migration.migratedPoolFeeBps).toBe(37);
      cfg.partnerPermanentLockedLiquidityPercentage=40;cfg.partnerLiquidityVestingInfo={vestingPercentage:10};
      expect((await readDbcConfig(conn,address)).problems.join(" ")).toContain("LP vesting configs are not eligible");
    } finally {spy.mockRestore();}
  });
});
