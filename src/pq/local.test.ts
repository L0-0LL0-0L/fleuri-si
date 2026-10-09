// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { acknowledgeBackup, backupBlob, createIdentity, forgetLocal, lock, restoreBackup, unlock, withSecret } from "./local";
// jsdom lacks SubtleCrypto; use the runtime's real WebCrypto, never a crypto stub.
Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
afterEach(()=>{forgetLocal();vi.useRealTimers();});
describe("browser key custody",()=>{
  it("stores only encrypted material, clears the in-memory secret on lock and recovers the original key",async()=>{
    const envelope=await createIdentity("a long disposable test password");const raw=localStorage.getItem("fleuri.pq.keyfile.v1")!;
    expect(JSON.parse(raw).ciphertext).toBe(envelope.ciphertext);expect(raw).not.toContain("secretKey");
    const key=withSecret(k=>k.secretKey);const before=new Uint8Array(key);acknowledgeBackup();expect(backupBlob().size).toBeGreaterThan(5000);
    lock();expect(key.every(b=>b===0)).toBe(true);expect(()=>withSecret(k=>k.publicKey)).toThrow("Unlock");
    await unlock("a long disposable test password");expect(withSecret(k=>k.secretKey)).toEqual(before);
    await expect(unlock("wrong disposable password")).rejects.toThrow();expect(withSecret(k=>k.secretKey)).toEqual(before);
    await restoreBackup(raw,"a long disposable test password");expect(withSecret(k=>k.secretKey)).toEqual(before);
  });
  it("auto-locks and wipes the private key after the idle timeout",async()=>{
    vi.useFakeTimers();await createIdentity("another disposable password");const key=withSecret(k=>k.secretKey);
    vi.advanceTimersByTime(15*60_000);expect(key.every(b=>b===0)).toBe(true);expect(()=>withSecret(k=>k.publicKey)).toThrow("Unlock");
  });
});
