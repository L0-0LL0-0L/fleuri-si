import { describe, expect, it } from "vitest";
import { isOnchainPath } from "./onchain-routes";

describe("isOnchainPath", () => {
  it("treats real-asset pages as on-chain", () => {
    for (const p of ["/identity", "/launchpad", "/verify", "/pollen", "/botanist", "/launch-config", "/staking", "/observatory", "/observatory/", "/watchtower", "/botanist/", "/passport/abc", "/t/Mint111"]) expect(isOnchainPath(p)).toBe(true);
  });
  it("keeps garden pages as sandbox", () => {
    for (const p of ["/", "/terminal", "/coins", "/agents", "/a/x", "/c/BLOOM", "/me", "/pollenx", "/observatoryx", "/t"]) expect(isOnchainPath(p)).toBe(false);
  });
});
