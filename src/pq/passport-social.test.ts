// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { generatePqKeypair, type PqKeypair } from "./mldsa";
import { parseManifest, signPassport, verifyPassportOffline } from "./passport";
import { manifestFixture } from "./fixtures";

let kp: PqKeypair;
beforeAll(() => { kp = generatePqKeypair(); });

describe("passport social links", () => {
  it("accepts a manifest without website or twitter (older passports keep parsing)", () => {
    const m = manifestFixture(kp);
    expect(m.website).toBeUndefined();
    expect(m.twitter).toBeUndefined();
    expect(() => parseManifest(m)).not.toThrow();
  });

  it("accepts https website and x.com/twitter.com twitter links", () => {
    const m = { ...manifestFixture(kp), token: { ...manifestFixture(kp).token, website: "https://fleuri.si", twitter: "https://x.com/fleuri" } };
    const parsed = parseManifest(m);
    expect(parsed.token.website).toBe("https://fleuri.si");
    expect(parsed.token.twitter).toBe("https://x.com/fleuri");
    const signed = signPassport(parsed, kp);
    const verified = verifyPassportOffline(JSON.parse(JSON.stringify(signed)));
    expect(verified.checks.every(c => c.status === "pass")).toBe(true);
    expect(verified.passport?.manifest.token.website).toBe("https://fleuri.si");
  });

  it("rejects non-https websites", () => {
    const m = { ...manifestFixture(kp), token: { ...manifestFixture(kp).token, website: "http://insecure.example" } };
    expect(() => parseManifest(m)).toThrow(/Website must be an https URL/);
  });

  it("rejects twitter links off x.com and twitter.com", () => {
    const m = { ...manifestFixture(kp), token: { ...manifestFixture(kp).token, twitter: "https://github.com/fleuri" } };
    expect(() => parseManifest(m)).toThrow(/x\.com or https:\/\/twitter\.com/);
  });
});
