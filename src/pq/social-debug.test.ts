// @vitest-environment node
import { it } from "vitest";
import { generatePqKeypair } from "./mldsa";
import { parseManifest, Manifest } from "./passport";
import { manifestFixture } from "./fixtures";
it("debug", () => {
  const kp = generatePqKeypair();
  const f = manifestFixture(kp);
  const m = { ...f, token: { ...f.token, website: "https://fleuri.si", twitter: "https://x.com/fleuri" } };
  const r = Manifest.safeParse(m);
  console.log("direct:", r.success ? r.data.token.website : r.error.issues[0]);
  const p = parseManifest(m);
  console.log("via fn:", p.website, "keys:", Object.keys(p.token).join(","));
});
