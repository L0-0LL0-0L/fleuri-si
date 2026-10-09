import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/bits";
import { CheckList, Panel, PassportTerms, RealBadge, downloadPassport } from "@/components/pq/ui";
import { verifyPassportOffline } from "@/pq/passport";
import { pqVerify } from "@/lib/pq.functions";

export const Route=createFileRoute("/verify")({head:()=>({meta:[{title:"Verify a passport — fleuri"},{name:"description",content:"Independently check a signed Fleuri launch passport, its identity anchor and its Meteora on-chain terms."}]}),component:VerifyPage});

export function VerificationView({result}:{result:any}) {
  const required=["canonical","signature","registration","anchor","terms","record","transaction","onchain","metadata","lifecycle"];
  const failed=result.checks.some((c:any)=>c.status==="fail");
  const full=required.every(id=>result.checks.some((c:any)=>c.id===id&&c.status==="pass"));
  return <div className="space-y-4">
    <p className={`hair p-3 font-semibold ${failed?"bg-poppy text-paper-light":full?"bg-sprout text-paper-light":"bg-paper-light"}`} role="status">{failed?"Verification failed — inspect the checks below.":full?"Passport and on-chain launch verified.":"Partial verification — chain proof is pending or unavailable."}</p>
    <CheckList label="Independent passport verification" checks={result.checks}/>
    {result.passport && <Panel title="Signed launch terms"><div className="flex flex-wrap gap-2"><RealBadge cluster={result.passport.manifest.cluster}/><button type="button" className="btn btn-paper" onClick={()=>downloadPassport(result.passport)}>Download passport JSON</button></div><p className="break-all font-mono text-xs">{result.passport.manifestHash}</p><PassportTerms manifest={result.passport.manifest}/></Panel>}
  </div>;
}

function VerifyPage() {
  const [text,setText]=useState(""); const [hash,setHash]=useState(""); const [result,setResult]=useState<any>(null); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  function parse() {if(new TextEncoder().encode(text).length>40_000)throw new Error("Passport must be 40 KB or smaller.");return JSON.parse(text);}
  function offline() {setError("");try{setResult(verifyPassportOffline(parse()));}catch(e){setError((e as Error).message);}}
  async function chain(byHash=false) {
    setBusy(true);setError("");
    try {const r=await pqVerify({data:byHash?{hash:hash.trim().toLowerCase()}:{passport:parse()}});if(!r.ok)throw new Error(r.error);setResult(r.data);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="space-y-4"><PageHeader title="trust the proof." kicker="public passport verifier"/><p className="max-w-prose text-sm">No wallet or sign-in required. Check the ML-DSA-65 signature on this device, then independently read the registration, chain anchor, launch transaction and token terms. A valid signature alone does not prove an on-chain launch.</p>
    <Panel title="Paste or upload a signed passport"><label className="block text-sm" htmlFor="passport-json">Signed passport JSON</label><textarea id="passport-json" rows={9} maxLength={40_000} value={text} onChange={e=>{setText(e.target.value);setResult(null);}} className="hair w-full bg-paper-light p-3 font-mono text-xs" placeholder='{"format":"fleuri.signed-passport/v1",…}'/><label className="block text-sm">Upload JSON · up to 40 KB<input type="file" accept=".json,application/json" className="mt-2 block w-full text-xs" onChange={async e=>{setError("");const f=e.target.files?.[0];if(!f)return;if(f.size>40_000){setError("Passport must be 40 KB or smaller.");return;}setText(await f.text());setResult(null);}}/></label><div className="flex flex-wrap gap-2"><button type="button" className="btn btn-paper" disabled={!text||busy} onClick={offline}>Check signature offline</button><button type="button" className="btn btn-red" disabled={!text||busy} onClick={()=>void chain()}>{busy?"Reading proof…":"Verify full chain proof"}</button></div></Panel>
    <Panel title="Or look up a confirmed passport"><form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void chain(true);}}><label className="sr-only" htmlFor="passport-hash">64-character manifest hash</label><input id="passport-hash" required pattern="[0-9a-fA-F]{64}" maxLength={64} value={hash} onChange={e=>setHash(e.target.value)} className="hair min-w-0 flex-1 bg-paper-light px-2 py-3 font-mono text-xs" placeholder="64-character manifest hash"/><button type="submit" className="btn btn-ink" disabled={busy}>Look up proof</button></form></Panel>
    {error&&<p role="alert" className="hair break-words bg-paper-light p-3 text-sm text-poppy-deep">{error}</p>}{result&&<VerificationView result={result}/>}<p className="text-xs text-ink-soft">ML-DSA-65 protects launch provenance. Wallet custody still uses Solana’s Ed25519. <Link to="/launchpad" className="underline">Back to the launchpad ↗</Link></p></div>;
}
