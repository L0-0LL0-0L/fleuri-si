import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/bits';
import { AgentAvatar } from '@/components/PixelFlower';
import { SeasonForm, TrustNote, LocalVerifier } from '@/components/shadow/SeasonUI';
import { useGarden } from '@/store/garden';
import { shadowMine } from '@/lib/shadow.functions';
import { DEFAULT_TERMS } from '@/domain/shadow';
export const Route = createFileRoute('/shadow-season/')({
 validateSearch: z.object({ agent: z.string().optional(), evidence: z.string().max(120).optional() }),
 head: () => ({ meta: [{ title: 'Shadow Season — fleuri' }, { name: 'description', content: 'Freeze a private synthetic inventory strategy before outcomes, compare with identical hold inventory and replay Decision Autopsy evidence.' }, { property: 'og:title', content: 'Shadow Season — fleuri' }, { property: 'og:description', content: 'Committed simulation research with explicit assumptions, no wallet actions and reproducible autopsies.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary' }] }), component: Hub,
});
function Hub() {
 const { state, userId, store } = useGarden(); const [rows,setRows]=useState<any[]|null>(null); const [error,setError]=useState(''); const mine=useServerFn(shadowMine); const navigate=useNavigate(); const search=Route.useSearch();
 useEffect(()=>{let live=true;setRows(null);setError('');if(userId)mine().then(r=>{if(live){if(r.ok)setRows(r.data);else setError(r.error);}}).catch(()=>live&&setError('Could not load your seasons.'));return()=>{live=false;};},[userId,mine]);
 const agent=Object.values(state?.agents??{}).find(a=>a.handle===search.agent&&a.ownerId===userId);
 return <div className="space-y-6"><PageHeader title="Shadow Season" kicker="Freeze · compare · learn"><AgentAvatar variant={0} size={54}/></PageHeader><TrustNote/>
 <div className="flex flex-wrap gap-3 text-sm"><Link to="/greenhouse" className="underline">Greenhouse ↗</Link><Link to="/graft" className="underline">Graft read-only research ↗</Link></div>
 {!userId?<section className="space-y-3"><h2 className="display text-xl">Your private research notebook</h2><Button onClick={()=>void store.startSandbox().catch(e=>toast.error(e.message))}>Open a workspace</Button></section>:<><SeasonForm initial={{...DEFAULT_TERMS,agentId:agent?.id??'',evidenceRef:search.evidence??''}} onSaved={id=>void navigate({to:'/shadow-season/$id',params:{id}})}/><section className="space-y-3"><h2 className="display text-2xl">Your seasons</h2>{error?<p role="alert">{error}</p>:rows===null?<p>Loading…</p>:rows.length===0?<p className="text-sm">No frozen proposals yet.</p>:<ul className="divide-y divide-ink">{rows.map(s=><li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><div><strong>{s.frozen.terms.name}</strong><p className="num text-xs">{s.status} · {s.frozen.terms.rounds} synthetic hours · {s.shared?'shared':'private'}</p></div><Link className="underline text-sm" to="/shadow-season/$id" params={{id:s.id}}>Review season ↗</Link></li>)}</ul>}</section></>}
 <LocalVerifier/></div>;
}
