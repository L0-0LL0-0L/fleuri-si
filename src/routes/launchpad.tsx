import { createFileRoute, Link } from "@tanstack/react-router";
import { Keypair } from "@solana/web3.js";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/bits";
import { FlowerTiles } from "@/components/PixelFlower";
import { CheckList, Panel, PassportTerms, PendingTransactions, RealBadge, WalletButtons, downloadPassport, explorerTx, lifecycleLabel, signSubmitConfirm, useWallets, type PqMine } from "@/components/pq/ui";
import { getPqReadiness, pqLaunchProposals, pqMine, pqPinImage, pqPrepareLaunch, pqPrepareMigration, pqPublicLaunches, pqRefreshLifecycle, pqSetProposalStatus, pqStartLaunch } from "@/lib/pq.functions";
import { b64 } from "@/pq/canonical";
import { loadLocal, usePqLocal, withSecret } from "@/pq/local";
import { parseManifest, signPassport, type PassportManifest, type SignedPassportT } from "@/pq/passport";
import { useGarden } from "@/store/garden";
import { AttachEvidence, EvidenceList, FrozenEvidence, freezeReview, originAgentId, type EvidenceRow, type FrozenReview } from "@/components/greenhouse/ProposalEvidence";
import { ghEvidence, ghMyRuns } from "@/lib/greenhouse.functions";
import { rrForRuns } from "@/lib/research.functions";
import { createFence } from "@/lib/greenhouse-session";
import type { WalletKind } from "@/services/wallet";

export const Route = createFileRoute("/launchpad")({
  head: () => ({meta:[{title:"Launchpad — fleuri"},{name:"description",content:"Grow a token on Meteora with an independent post-quantum identity and a signed launch passport."}]}),
  component: Launchpad,
});

function Launchpad() {
  const local=usePqLocal(); const {userId,store,state:garden}=useGarden(); const wallets=useWallets();
  const mint=useRef<Keypair|null>(null);
  const [readiness,setReadiness]=useState<any>(null); const [readError,setReadError]=useState("");
  const [mine,setMine]=useState<PqMine|null>(null); const [launches,setLaunches]=useState<any[]>([]);
  const [busy,setBusy]=useState<string|null>(null); const [error,setError]=useState("");
  const [name,setName]=useState(""); const [symbol,setSymbol]=useState("");
  const [imageUri,setImageUri]=useState(""); const [imageHash,setImageHash]=useState<string|null>(null); const [file,setFile]=useState<File|null>(null);
  const [website,setWebsite]=useState(""); const [twitter,setTwitter]=useState("");
  const [manifest,setManifest]=useState<PassportManifest|null>(null); const [signed,setSigned]=useState<SignedPassportT|null>(null);
  const [reviewAck,setReviewAck]=useState(false); const [done,setDone]=useState<{signature:string;hash:string}|null>(null);
  const [proposals,setProposals]=useState<any[]>([]); const [usedProposal,setUsedProposal]=useState<string|null>(null);
  const [evidence,setEvidence]=useState<EvidenceRow[]>([]); const [ghRuns,setGhRuns]=useState<any[]>([]); const [frozenEvidence,setFrozenEvidence]=useState<FrozenReview|null>(null);
  const fence=useRef(createFence()).current;
  const identity=mine?.identities.find(i=>i.key_hash===local.envelope?.keyHash && i.cluster===readiness?.cluster && i.status==="anchored");
  async function refresh() {
    const g=fence.current();
    if(store.get().userId) {const r=await pqMine(); if(!fence.guard(g)) return; if(r.ok) setMine(r.data); else setError(r.error);}
    const r=await pqPublicLaunches(); if(r.ok) setLaunches(r.data); else setReadError(r.error);
    const pr=await pqLaunchProposals(); if(pr.ok) setProposals(pr.data);
    if(store.get().userId && pr.ok && fence.guard(g)) await loadEvidence(pr.data,g);
  }
  async function loadEvidence(list:any[]=proposals,g=fence.current()) {
    const [ev,rs]=await Promise.all([ghEvidence({data:{proposalIds:list.map(p=>p.id)}}),ghMyRuns()]);
    if(!fence.guard(g)) return; // a previous workspace's late response
    let rows=(ev.ok?ev.data:[]) as EvidenceRow[];
    const runIds=[...new Set(rows.map(e=>e.run_id))].slice(0,50);
    if(runIds.length) {const rc=await rrForRuns({data:{runIds}}); if(!fence.guard(g)) return; if(rc.ok) rows=rows.map(e=>({...e,receipts:rc.data.filter((r:any)=>r.run_id===e.run_id)}));}
    if(ev.ok) setEvidence(rows); if(rs.ok) setGhRuns(rs.data);
  }
  function useProposal(p:any) {
    setDone(null); setManifest(null); setSigned(null); setReviewAck(false);
    setFrozenEvidence(freezeReview(p,evidence,garden?.agents??{},new Date()));
    setName(p.name); setSymbol(p.symbol); setWebsite(""); setTwitter("");
    setFile(null); setImageUri(""); setImageHash(null); setUsedProposal(p.id);
    window.scrollTo({top:0,behavior:"smooth"});
  }
  async function checkReadiness() {
    setReadError("");
    try {const r=await getPqReadiness(); if(r.ok) setReadiness(r.data); else setReadError(r.error);}
    catch(e) {setReadError((e as Error).message);}
  }
  useEffect(()=>{loadLocal(); void checkReadiness();},[]);
  useEffect(()=>{ // workspace change: drop owner-scoped data and the frozen review, fence old responses
    fence.bump(); setMine(null); setEvidence([]); setGhRuns([]); setFrozenEvidence(null); setUsedProposal(null);
    setManifest(null); setSigned(null); setReviewAck(false); mint.current=null;
    void refresh().catch(e=>setReadError(e.message));
  },[userId]);
  async function run(label:string,fn:()=>Promise<void>) {
    setBusy(label); setError("");
    try {await fn();} catch(e) {setError((e as Error).message); await refresh().catch(()=>{});} finally {setBusy(null);}
  }
  async function review() {
    if(!identity || !local.unlocked || !local.backupAck || !readiness?.ready) throw new Error("Back up, unlock and anchor your identity, then resolve the readiness checks.");
    let uri=imageUri, hash=imageHash;
    if(file) {
      if(file.size>1_000_000) throw new Error("Token image must be 1 MB or smaller.");
      setBusy("Pinning your image…"); const r=await pqPinImage({data:{data:b64(new Uint8Array(await file.arrayBuffer())),mime:file.type}});
      if(!r.ok) throw new Error(r.error); uri=r.data.imageUri; hash=r.data.imageSha256; setImageUri(uri); setImageHash(hash);
    }
    mint.current ??= Keypair.generate();
    const r=await pqStartLaunch({data:{identityId:identity.id,baseMint:mint.current.publicKey.toBase58()}});
    if(!r.ok) throw new Error(r.error);
    const token:PassportManifest["token"]={...r.data.template.token,name:name.trim(),symbol:symbol.trim().toUpperCase(),imageUri:uri.trim(),imageSha256:hash};
    if(website.trim()) token.website=website.trim();
    if(twitter.trim()) token.twitter=twitter.trim();
    const m=parseManifest({...r.data.template,token});
    setManifest(m); setReviewAck(false);
  }
  async function launch(kind:WalletKind) {
    if(!signed || !mint.current) throw new Error("Sign this draft before launching.");
    setBusy("Preparing immutable metadata and the Meteora transaction…");
    const p=await pqPrepareLaunch({data:{passport:signed}}); if(!p.ok) throw new Error(p.error);
    const r=await signSubmitConfirm(kind,p.data,{coSign:[mint.current],onStatus:setBusy});
    setDone({signature:r.signature,hash:signed.manifestHash}); mint.current=null;
    if(usedProposal) {await pqSetProposalStatus({data:{id:usedProposal,status:"launched"}}); setUsedProposal(null);}
    toast.success(r.detail); await refresh();
  }
  async function migrate(kind:WalletKind,id:string) {
    const p=await pqPrepareMigration({data:{launchId:id}}); if(!p.ok) throw new Error(p.error);
    if(p.data.stage==="locker") toast.info("This config requires vesting escrow first. Confirm this setup, then select Migrate again for the DAMM v2 pool.");
    const r=await signSubmitConfirm(kind,p.data,{onStatus:setBusy}); toast.success(r.detail); await refresh();
  }
  async function rebuildDraft() {
    const r=await pqMine(); if(!r.ok) throw new Error(r.error);
    setMine(r.data);
    if(r.data.preparations.some((p:any)=>p.kind==="launch"&&p.subject===manifest?.token.baseMint)) throw new Error("This draft has a submitted transaction. Check its confirmation in Pending transactions first.");
    mint.current=null; setManifest(null); setSigned(null); setReviewAck(false);
  }
  const canReview=!!identity && local.unlocked && local.backupAck && !!readiness?.ready;
  return <div className="space-y-5">
    <PageHeader title="plant. prove. bloom." kicker="fleuri · meteora launchpad"><RealBadge cluster={readiness?.cluster}/></PageHeader>
    <div className="hair grid overflow-hidden bg-paper-light sm:grid-cols-[minmax(0,1fr)_200px]">
      <div className="space-y-3 p-4 sm:p-6"><p className="display text-2xl sm:text-3xl">a little chaos.<br/>a permanent paper trail.</p><p className="max-w-prose text-sm">Launch a token on Meteora’s bonding curve. Sign its exact terms with an independent ML-DSA-65 key. Let anyone verify the passport as it grows into a DAMM v2 pool.</p><div className="flex flex-wrap gap-3 text-sm font-semibold"><Link to="/identity" className="underline">Your PQ identity ↗</Link><Link to="/verify" className="underline">Verify a passport ↗</Link></div><p className="text-xs text-ink-soft">Post-quantum provenance. Solana wallets and funds still use Ed25519. Launches use real SOL on the network shown above; the garden’s vSOL balances do not fund these launches.</p></div>
      <div className="hidden self-center p-4 sm:block"><FlowerTiles count={9} cols={3}/></div>
    </div>
    <div className="grid gap-2 sm:grid-cols-4">{["01 · back up your key","02 · anchor your identity","03 · sign exact terms","04 · launch on Meteora"].map((s,i)=><div key={s} className={`hair p-3 font-mono text-xs ${i===2?"bg-poppy text-paper-light":"bg-paper-light"}`}>{s}</div>)}</div>
    <Panel title="Network readiness">
      {readiness?<CheckList label="Launch network readiness" checks={readiness.checks}/>:<p className="text-sm">{readError||"Reading network configuration…"}</p>}
      {readError && readiness && <p role="alert" className="break-words text-sm text-poppy-deep">{readError}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-paper" onClick={()=>void checkReadiness()}>Recheck readiness</button>{readiness && !readiness.dbcConfig && <Link to="/launch-config" className="btn btn-red">Create the pool config</Link>}</div>
    </Panel>
    {!userId && <Panel title="Your workspace"><p className="text-sm">Use your existing workspace session to register an identity and view your launches.</p><button type="button" className="btn btn-ink" disabled={!!busy} onClick={()=>void run("Opening workspace…",async()=>{await store.startSandbox();await refresh();})}>{busy??"Open workspace"}</button></Panel>}
    {!canReview && !manifest && <p className="hair bg-paper-light p-3 text-sm">Before launching: <Link to="/identity" className="font-semibold underline">create or restore your key, download its backup, unlock it and anchor it</Link>. Launching also requires every network readiness check to pass.</p>}
    {done?<Panel title="Your bloom is on chain"><p className="display text-2xl">planted. signed. yours.</p><a className="block break-all text-xs underline" href={explorerTx(done.signature,readiness.cluster)} target="_blank" rel="noreferrer">View confirmed launch transaction</a><Link to="/passport/$hash" params={{hash:done.hash}} className="btn btn-red">Open the public passport</Link><button type="button" className="btn btn-paper" onClick={()=>{setDone(null);setManifest(null);setSigned(null);setName("");setSymbol("");setFile(null);setImageUri("");setImageHash(null);setWebsite("");setTwitter("");setUsedProposal(null);setFrozenEvidence(null);}}>Plant another token</button></Panel>
    :!manifest?<>
    {!!proposals.length && <Panel title="Agent proposals · drafted in the garden, launched by you">
      <p className="text-xs text-ink-soft">Your agents draft these during their cycles. Nothing here is on chain — a draft only becomes real when you review it, sign the passport and approve the launch in your wallet.</p>
      {proposals.map(p=><div key={p.id} className={`hair space-y-2 p-3 ${usedProposal===p.id?"bg-paper-deep":""}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{p.name} <span className="text-poppy">${p.symbol}</span></p><p className="font-mono text-xs">drafted by @{p.agent_handle}</p></div>
        {p.tagline && <p className="text-sm">{p.tagline}</p>}
        {p.reason && <p className="text-xs text-ink-soft">why: {p.reason}</p>}
        <div className="space-y-1"><p className="font-mono text-[0.65rem] uppercase tracking-widest">Greenhouse evidence · drafted with policy {p.origin_policy_hash?`${p.origin_policy_hash.slice(0,8)}… (${p.origin_mode??"unknown"} mode)`:"unknown (legacy draft)"}</p>
          {userId?<><EvidenceList rows={evidence.filter(e=>e.proposal_id===p.id)} agents={garden?.agents??{}}/><AttachEvidence proposalId={p.id} originId={garden?originAgentId(p,garden.agents):p.origin_agent_id??null} runs={ghRuns} onDone={()=>loadEvidence()}/></>:<p className="text-xs text-ink-soft">Open your workspace to attach your own trial evidence.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-red" disabled={!!busy} onClick={()=>useProposal(p)}>{usedProposal===p.id?"Draft loaded below ↓":"Use this draft"}</button>
          <button type="button" className="btn btn-paper" disabled={!!busy} onClick={()=>void run("Dismissing draft…",async()=>{const r=await pqSetProposalStatus({data:{id:p.id,status:"dismissed"}});if(!r.ok)throw new Error(r.error);await refresh();})}>Dismiss</button>
        </div>
      </div>)}
    </Panel>}
    {frozenEvidence && <Panel title="Greenhouse evidence for this review"><FrozenEvidence review={frozenEvidence}/><button type="button" className="btn btn-paper" disabled={!!busy} onClick={()=>{setFrozenEvidence(null);setUsedProposal(null);setName("");setSymbol("");mint.current=null;}}>Start a fresh token instead</button></Panel>}
    <Panel title="Your next bloom">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void run("Reading exact chain terms…",review);}}>
        <label className="text-sm font-semibold">Token name<input required maxLength={32} value={name} onChange={e=>setName(e.target.value)} className="hair mt-1 h-11 w-full bg-paper-light px-3" placeholder="a strange little bloom"/></label>
        <label className="text-sm font-semibold">Ticker<input required pattern="[A-Z0-9]{1,10}" maxLength={10} value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} className="hair mt-1 h-11 w-full bg-paper-light px-3" placeholder="BLOOM"/></label>
        <label className="text-sm font-semibold">Website · optional<input maxLength={200} value={website} onChange={e=>setWebsite(e.target.value)} className="hair mt-1 h-11 w-full bg-paper-light px-3" placeholder="https://your-token.site"/></label>
        <label className="text-sm font-semibold">Twitter / X · optional<input maxLength={200} value={twitter} onChange={e=>setTwitter(e.target.value)} className="hair mt-1 h-11 w-full bg-paper-light px-3" placeholder="https://x.com/yourhandle"/></label>
        <label className="text-sm font-semibold sm:col-span-2">Token image · PNG, JPEG, GIF or WebP, up to 1 MB<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="mt-2 block w-full text-xs" onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
        <label className="text-sm sm:col-span-2">Or an existing immutable image CID<input value={imageUri} disabled={!!file} onChange={e=>{setImageUri(e.target.value);setImageHash(null);}} className="hair mt-1 h-11 w-full bg-paper-light px-3 font-mono text-xs" placeholder="ipfs://bafy…"/></label>
        <p className="text-xs text-ink-soft sm:col-span-2">Supply, fees, LP shares and graduation are read from the configured Meteora pool config. The mint key is generated on your device; its private key stays here.</p>
        <button type="submit" className="btn btn-red sm:col-span-2" disabled={!!busy||!canReview}>{busy??"Review exact launch terms"}</button>
      </form>
    </Panel></>:<Panel title={signed?"Signed passport · ready for your wallet":"Review before signing"}>
      <PassportTerms manifest={manifest}/>
      {frozenEvidence && <div className="hair bg-paper-light p-2"><p className="text-xs font-semibold">Greenhouse evidence you reviewed (advisory, not signed)</p><FrozenEvidence review={frozenEvidence}/></div>}
      {!signed?<><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewAck} onChange={e=>setReviewAck(e.target.checked)}/><span>I have reviewed the exact fees, LP shares, authority policy and graduation terms above.</span></label><button type="button" className="btn btn-red" disabled={!reviewAck||!local.unlocked||!!busy} onClick={()=>void run("Signing with ML-DSA-65…",async()=>{setSigned(withSecret(kp=>signPassport(manifest,kp)));})}>Sign launch passport</button><button type="button" className="btn btn-paper" disabled={!!busy} onClick={()=>setManifest(null)}>Edit draft</button></>
      :<><p className="break-all font-mono text-xs">{signed.manifestHash}</p><button type="button" className="btn btn-paper" onClick={()=>downloadPassport(signed)}>Download signed passport</button><p className="text-xs text-ink-soft">Your wallet pays the signed pool creation fee, account rent and network fees. It must match the creator address above. Nothing is sent until you approve the transaction in your wallet.</p><WalletButtons avail={wallets} busy={busy} action="Launch with" onPick={k=>void run("Preparing launch…",()=>launch(k))}/><button type="button" className="btn btn-paper" disabled={!!busy} onClick={()=>void run("Checking for submitted transactions…",rebuildDraft)}>Rebuild an expired unsigned draft</button></>}
    </Panel>}
    {error && <div role="alert" className="hair space-y-2 bg-paper-light p-3"><p className="break-words text-sm text-poppy-deep">{error}</p><p className="text-xs">If you signed a transaction, check pending transactions below before starting a new launch.</p><button className="btn btn-paper" type="button" onClick={()=>void refresh().catch(e=>setError(e.message))}>Refresh my transactions</button></div>}
    {mine && <PendingTransactions rows={mine.preparations} onRefresh={refresh}/>}
    {!!mine?.launches.length && <Panel title="Your blooms · owner controls">{mine.launches.map(l=><div key={l.id} className="hair space-y-2 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{l.passports?.manifest?.token?.name??l.base_mint.slice(0,12)} · {lifecycleLabel[l.lifecycle]??l.lifecycle}</p><RealBadge cluster={l.cluster}/></div><Link to="/passport/$hash" params={{hash:l.passports.manifest_hash}} className="text-sm underline">Open passport ↗</Link> <Link to="/t/$mint" params={{mint:l.base_mint}} className="text-sm underline">Token page ↗</Link><button type="button" className="btn btn-paper" disabled={!!busy} onClick={()=>void run("Reading pool lifecycle…",async()=>{const r=await pqRefreshLifecycle({data:{launchId:l.id}});if(!r.ok)throw new Error(r.error);await refresh();})}>Refresh graduation</button>{l.lifecycle!=="curve_active"&&l.lifecycle!=="damm_v2_live"&&<WalletButtons avail={wallets} busy={busy} action="Migrate with" onPick={k=>void run("Preparing DAMM v2 migration…",()=>migrate(k,l.id))}/>}</div>)}</Panel>}
    <Panel title="The passport garden · confirmed launches">
      {launches.length?<div className="grid gap-3 sm:grid-cols-2">{launches.map(l=><Link key={l.id} to="/passport/$hash" params={{hash:l.passports.manifest_hash}} className="hair space-y-2 bg-paper p-3 hover:bg-paper-deep"><RealBadge cluster={l.cluster}/><p className="display text-xl">{l.passports.manifest.token.name} <span className="text-poppy">${l.passports.manifest.token.symbol}</span></p><p className="text-xs">{lifecycleLabel[l.lifecycle]??l.lifecycle} · last recorded state</p><span className="font-mono text-xs underline">inspect the passport ↗</span></Link>)}</div>:<p className="text-sm">{readError?"Could not read the launch registry. Recheck readiness or refresh.":"No confirmed launches yet. The first bloom starts here."}</p>}
    </Panel>
  </div>;
}
