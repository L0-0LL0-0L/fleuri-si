// @vitest-environment node
import { it } from "vitest";
import { generatePqKeypair } from "./mldsa";
import { Manifest, parseManifest } from "./passport";
import { canonicalize } from "./canonical";
import { manifestFixture } from "./fixtures";
it("debug", () => {
  const kp = generatePqKeypair();
  const f = manifestFixture(kp);
  const m = { ...f, token: { ...f.token, website: "https://fleuri.si", twitter: "https://x.com/fleuri" } } as any;
  const text = canonicalize(m);
  console.log("text includes:", text.includes("fleuri.si"));
  const r = Manifest.safeParse(m);
  console.log("after canonicalize direct:", r.success ? r.data.token.website : r.error.issues[0]);
  const p = parseManifest(m);
  console.log("via fn:", p.website, "twitter:", p.twitter);
  const r2 = Manifest.safeParse(m);
  console.log("direct again:", r2.success ? r2.data.token.website : r2.error.issues[0]);
});
