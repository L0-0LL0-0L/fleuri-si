import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CopyLink, PageHeader } from "@/components/bits";
import { Panel, explorerAddr, explorerTx, lifecycleLabel } from "@/components/pq/ui";
import { pqRefreshLifecycle, pqVerify } from "@/lib/pq.functions";
import { VerificationView } from "./verify";

export const Route=createFileRoute("/passport/$hash")({head:()=>({meta:[{title:"Launch passport — fleuri"},{name:"description",content:"Inspect a signed Fleuri launch passport and independently verify its Meteora launch and graduation."}]}),component:PassportPage});
function PassportPage() {
  const {hash}=Route.useParams();const [result,setResult]=useState<any>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  async function load(refresh=false) {
    setBusy(true);setError("");
    try {if(!/^[0-9a-f]{64}$/.test(hash))throw new Error("Invalid passport hash.");if(refresh&&result?.launch){const r=await pqRefreshLifecycle({data:{launchId:result.launch.id}});if(!r.ok)throw new Error(r.error);}const r=await pqVerify({data:{hash}});if(!r.ok)throw new Error(r.error);setResult(r.data);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  useEffect(()=>{setResult(null);void load();},[hash]);
  const l=result?.launch;const m=result?.passport?.manifest;
  return <div className="space-y-4"><PageHeader title={m?`${m.token.name}. in writing.`:"the launch passport."} kicker="permanent provenance"><CopyLink path={`/passport/${hash}`}/></PageHeader><p className="break-all font-mono text-xs">{hash}</p><p className="text-sm">Every fee, share and authority policy is signed. Every chain claim is checked separately.</p>
    {busy&&<p role="status" className="hair bg-paper-light p-3 text-sm">Reading identity, chain state and pinned metadata…</p>}{error&&<p role="alert" className="hair break-words bg-paper-light p-3 text-sm text-poppy-deep">{error}</p>}
    {result&&<VerificationView result={result}/>}
    {l&&<Panel title="On-chain records"><p className="font-semibold">{lifecycleLabel[l.lifecycle]??l.lifecycle} · last recorded state</p><div className="flex flex-wrap gap-3 text-sm underline"><a href={explorerTx(l.signature,l.cluster)} target="_blank" rel="noreferrer">Launch transaction ↗</a><a href={explorerAddr(l.pool,l.cluster)} target="_blank" rel="noreferrer">DBC pool ↗</a><a href={explorerAddr(l.base_mint,l.cluster)} target="_blank" rel="noreferrer">Token mint ↗</a>{l.damm_v2_pool&&<a href={explorerAddr(l.damm_v2_pool,l.cluster)} target="_blank" rel="noreferrer">DAMM v2 pool ↗</a>}{result.metadataUri&&<a href={result.metadataUri} target="_blank" rel="noreferrer">Immutable metadata ↗</a>}</div></Panel>}
    <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-paper" disabled={busy} onClick={()=>void load(true)}>Recheck full proof</button><Link to="/verify" className="btn btn-paper">Verify another passport</Link><Link to="/launchpad" className="btn btn-red">Open launchpad</Link></div></div>;
}
