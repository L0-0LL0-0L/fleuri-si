// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generatePqKeypair } from "./mldsa";
import { manifestFixture } from "./fixtures";
import { assertConfigTerms, validateImage } from "@/lib/pq.server";
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
});
