import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { termsSchema } from '@/domain/forward';
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const admin=async()=>(await import('@/integrations/supabase/client.server')).supabaseAdmin as any;
const server=()=>import('./forward.server');
async function safe<T>(f:()=>Promise<T>){try{return {ok:true as const,data:await f()};}catch(e){const m=e instanceof Error?e.message:'';const known=['not_owner','request_mismatch','changed_version','daily_quota','daily_capture_quota','draft_conflict','frozen','lease_lost','inflight_quota','minimum_spacing','busy','ended','source_changed','stale_source','capture_reserved_retry_after_lease','history_quota'];const k=known.find(k=>m.includes(k));return {ok:false as const,error:k?k.replaceAll('_',' '):'Verified source unavailable. No observation was invented; retry safely or end this watch.'};}}
export const forwardMine=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).handler(({context})=>safe(async()=>(await server()).mine(await admin(),context.userId)));
export const forwardDetail=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((d:unknown)=>z.object({id}).strict().parse(d)).handler(({data,context})=>safe(async()=>(await server()).detail(await admin(),data.id,context.userId)));
export const forwardShared=createServerFn({method:'GET'}).inputValidator((d:unknown)=>z.object({id}).strict().parse(d)).handler(({data})=>safe(async()=>{
 const url=process.env['SUPABASE_URL'],key=process.env['SUPABASE_PUBLISHABLE_KEY'];
 if(!url||!key)throw new Error('source_unavailable');
 const publicRead=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const h=new Headers(init?.headers);if(key.startsWith('sb_')&&h.get('Authorization')===`Bearer ${key}`)h.delete('Authorization');h.set('apikey',key);return fetch(input,{...init,headers:h});}}});
 return (await server()).detail(publicRead,data.id,null);
}));
export const forwardSave=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((d:unknown)=>z.object({requestId:id,id:id.nullable(),reviewedHash:hash.nullable(),terms:termsSchema}).strict().refine(v=>!v.id||v.reviewedHash!==null).parse(d)).handler(({data,context})=>safe(async()=>(await server()).save(await admin(),context.userId,data.requestId,data.terms,data.id,data.reviewedHash)));
export const forwardCapture=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((d:unknown)=>z.object({id,requestId:id,reviewedHash:hash.nullable()}).strict().parse(d)).handler(({data,context})=>safe(async()=>(await server()).capture(await admin(),context.userId,data.requestId,data.id,data.reviewedHash)));
export const forwardAction=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((d:unknown)=>z.discriminatedUnion('action',[z.object({id,requestId:id,action:z.literal('share'),shared:z.boolean()}).strict(),z.object({id,requestId:id,action:z.literal('annotate'),text:z.string().trim().min(1).max(500)}).strict(),z.object({id,requestId:id,action:z.literal('end')}).strict()]).parse(d)).handler(({data,context})=>safe(async()=>{const {id,requestId,action,...payload}=data;return (await server()).action(await admin(),context.userId,requestId,id,action,payload);}));
