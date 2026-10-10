// @vitest-environment node
import { it } from "vitest";
import { generatePqKeypair } from "./mldsa";
import { Manifest, parseManifest } from "./passport";
import { manifestFixture } from "./fixtures";
it("debug", () => {
  const kp = generatePqKeypair();
  const mk = () => { const f = manifestFixture(kp); return { ...f, token: { ...f.token, website: "https://fleuri.si", twitter: "https://x.com/fleuri" } } as any; };
  const p = parseManifest(mk());
  console.log("A via fn:", p.website, p.twitter, "token.website:", p.token.website);
  const r = Manifest.safeParse(mk());
  console.log("B direct:", r.success ? r.data.token.website : r.error.issues[0]);
  const p2 = parseManifest(mk());
  console.log("C via fn json token:", JSON.stringify(p2.token).slice(0, 300));
});
