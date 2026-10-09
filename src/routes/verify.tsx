import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/bits";
import { CheckList, Panel } from "@/components/pq/ui";
import { pqVerify } from "@/lib/pq.functions";
import { verifyPassportOffline, type Check } from "@/pq/passport";

export const Route = createFileRoute("/verify")({
  head: () => ({
    meta: [
      { title: "Verify a launch passport — fleuri" },
      { name: "description", content: "Independently check a Fleuri ML-DSA-65 launch passport: signature, identity anchor, chain terms and pool state." },
      { property: "og:title", content: "Verify a launch passport — fleuri" },
      { property: "og:description", content: "Pass / Fail / Pending / Unavailable checks for post-quantum launch provenance." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VerifyPage,
});

function VerifyPage() {
  const [text, setText] = useState("");
  const [offline, setOffline] = useState<Check[] | null>(null);
  const [online, setOnline] = useState<Check[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setErr(null);
    setOnline(null);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setOffline(null);
      setErr("That is not valid JSON. Paste the full exported passport file.");
      return;
    }
    setOffline(verifyPassportOffline(raw).checks);
    setBusy(true);
    try {
      const r = await pqVerify({ data: { passport: raw } });
      if (r.ok) setOnline((r.data?.checks ?? []) as Check[]);
      else setErr(`Network checks unavailable: ${r.error}`);
    } catch (e) {
      setErr(`Network checks unavailable: ${e instanceof Error ? e.message : "request failed"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="verify" kicker="launch passports" />
      <p className="max-w-prose text-sm">
        Paste an exported passport. The signature check runs in your browser; identity anchor, chain terms and pool checks need the network and show <strong>unavailable</strong> rather than a pass when evidence is missing.
      </p>
      <Panel title="passport json">
        <label htmlFor="pp" className="sr-only">Passport JSON</label>
        <textarea id="pp" value={text} onChange={(e) => setText(e.target.value)} rows={8} className="hair w-full bg-paper p-2 font-mono text-xs" placeholder='{"manifest": …, "signature": …}' />
        <div className="flex gap-2">
          <button type="button" className="btn btn-red" disabled={!text.trim() || busy} onClick={() => void check()}>{busy ? "Checking…" : "Verify"}</button>
          <button type="button" className="btn btn-paper" onClick={() => { setText(""); setOffline(null); setOnline(null); setErr(null); }}>Clear</button>
        </div>
        {err && <p role="alert" className="text-sm text-poppy-deep">{err}</p>}
      </Panel>
      {offline && <CheckList label="Offline checks" checks={offline} />}
      {online && online.length > 0 && <CheckList label="Network checks" checks={online} />}
    </div>
  );
}
