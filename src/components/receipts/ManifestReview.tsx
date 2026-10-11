import type { ReceiptManifestT } from "@/pq/receipt";
const short = (h: string) => `${h.slice(0, 12)}…${h.slice(-6)}`;
/** Every signed field, shown before signing and on the receipt page. */
export function ManifestReview({ m, hash }: { m: ReceiptManifestT; hash: string }) {
  const Row = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2"><dt className="font-semibold">{k}</dt><dd className={mono ? "break-all font-mono" : "break-words"}>{v}</dd></div>;
  return <div className="space-y-2 text-xs">
    <dl className="space-y-1">
      <Row k="Receipt hash" v={hash} mono />
      <Row k="Receipt id" v={m.receiptId} mono />
      <Row k="Created" v={`${m.createdAt} · ${m.domain}`} />
      <Row k="Issuer wallet" v={m.issuer.wallet} mono />
      <Row k="ML-DSA key" v={m.issuer.keyHash} mono />
      <Row k="Registration" v={m.issuer.registrationHash} mono />
      <Row k="Network" v={`${m.cluster} · genesis ${short(m.genesisHash)}`} />
      <Row k="Source trial" v={`${m.source.runId} · saved ${m.source.runCreatedAt}${m.source.runFinishedAt ? ` · finished ${m.source.runFinishedAt}` : ""}`} />
      <Row k="Engine" v={`${m.source.engineVersion} · ${m.source.scenarioVersion} · ${m.source.bundleFormat}`} />
      <Row k="Input hash" v={m.source.inputHash} mono />
      <Row k="Output hash" v={m.source.outputHash} mono />
      <Row k="Content hash" v={m.source.contentHash} mono />
      <Row k="Experiment digest" v={m.source.experimentDigest} mono />
      <Row k="Settings" v={`seed ${m.trial.seed} · ${m.trial.repetitions} repetition(s) × ${m.trial.cycles} cycles · ${m.trial.scenarios.join(", ")}`} />
    </dl>
    <ul className="space-y-1">{m.trial.policies.map((p) => <li key={p.agentId} className="hair break-words bg-paper p-1.5"><strong>@{p.handle}</strong> · {p.archetype}, risk {p.risk} · frozen policy <span className="font-mono">{short(p.policyHash)}</span></li>)}</ul>
    <p className="hair bg-paper-deep p-2">{m.scope}</p>
    <p className="text-ink-soft">The experiment digest commits to the complete original trial bundle: frozen market and policy snapshots, every action and outcome trace, scorecards, shock tapes and the original stored checksums, with the exact numbers unrounded.</p>
  </div>;
}
