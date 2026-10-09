import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/bits";
import { CheckList, Panel, downloadBlob } from "@/components/pq/ui";
import { pqVerify } from "@/lib/pq.functions";
import type { Check } from "@/pq/passport";

export const Route = createFileRoute("/passport/$hash")({
  head: ({ params }) => ({
    meta: [
      { title: `Passport ${params.hash.slice(0, 10)}… — fleuri` },
      { name: "description", content: "Launch passport detail with independent verification checks." },
      { property: "og:title", content: "Launch passport — fleuri" },
      { property: "og:description", content: "Signed ML-DSA-65 launch terms and verification status." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PassportPage,
});

function PassportPage() {
  const { hash } = Route.useParams();
  const valid = /^[0-9a-f]{64}$/.test(hash);
  const [res, setRes] = useState<{ ok: true; data: any } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    if (!valid) return;
    pqVerify({ data: { hash } }).then(setRes, (e) => setRes({ ok: false, error: String(e?.message ?? e) }));
  }, [hash, valid]);

  const passport = res?.ok ? res.data?.passport : null;
  return (
    <div className="space-y-4">
      <PageHeader title="passport" kicker="launch provenance" />
      <p className="break-all font-mono text-xs">{hash}</p>
      {!valid ? <p role="alert" className="text-sm text-poppy-deep">That is not a valid passport hash.</p> : !res ? <p className="text-sm">Checking…</p> : !res.ok ? (
        <p role="alert" className="text-sm text-poppy-deep">{res.error}</p>
      ) : (
        <>
          <CheckList label="Verification checks" checks={(res.data?.checks ?? []) as Check[]} />
          {passport && (
            <Panel title="signed terms">
              <pre className="max-h-96 overflow-auto bg-paper p-2 font-mono text-xs">{JSON.stringify(passport.manifest ?? passport, null, 2)}</pre>
              <button type="button" className="btn btn-paper" onClick={() => downloadBlob(new Blob([JSON.stringify(passport, null, 2)], { type: "application/json" }), `passport-${hash.slice(0, 12)}.json`)}>Export passport</button>
            </Panel>
          )}
        </>
      )}
      <p className="text-sm"><Link to="/verify" className="underline">Verify another</Link> · <Link to="/launchpad" className="underline">launchpad</Link></p>
    </div>
  );
}
