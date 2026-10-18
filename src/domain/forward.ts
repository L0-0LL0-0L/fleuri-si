// Prospective observations; hypothetical decision-mark execution. Existing Shadow v1 is unchanged.
import { z } from 'zod';
import { canonicalize, domainHash } from '@/pq/canonical';
import { parseStrictJson } from '@/pq/strict-json';
import { addressSchema, evidenceSchema, decodeEvidence, evidenceHash, manifestHash, DBC, DAMM, type Evidence } from '@/pq/forward-source';
import { versionSchema } from './shadow';
export const ENGINE='forward-inventory/1', FORMAT='fleuri.forward.bundle/1';
export const ASSUMPTIONS='manual-finalized-mainnet;atomic-rational;decision-mark-hypothetical;floor-costs;50%-target;zero-earned-fees;sampled-drawdown;no-interpolation;not-model-execution';
const hash=z.string().regex(/^[a-f0-9]{64}$/), date=z.string().datetime();
const amount=z.string().regex(/^(0|[1-9]\d{0,23})$/);
export const termsSchema=z.object({agentId:z.string().regex(/^[\w-]{1,40}$/),name:z.string().trim().min(1).max(80),pool:addressSchema,adapter:z.enum([DBC,DAMM]),orientation:z.enum(['a-as-token','b-as-token']),initialQuote:amount,initialTokens:amount,strategy:z.enum(['hold','range-rebalance']),lowerBps:z.number().int().min(1000).max(9999),upperBps:z.number().int().min(10001).max(30000),feeBps:z.number().int().min(0).max(100),slippageBps:z.number().int().min(0).max(200),cadenceSeconds:z.number().int().min(60).max(86400),windowSeconds:z.number().int().min(30).max(3600),maxSteps:z.number().int().min(2).max(48),expirySeconds:z.number().int().min(180).max(604800),maxStalenessSeconds:z.number().int().min(30).max(300),expectedExcessQuote:z.string().regex(/^-?(0|[1-9]\d{0,23})$/),expectedCoverageBps:z.number().int().min(0).max(10000),rationale:z.string().trim().min(1).max(280),evidenceRef:z.string().max(120)}).strict().refine(t=>BigInt(t.initialQuote)+BigInt(t.initialTokens)>0n,'Positive inventory required').refine(t=>t.windowSeconds<=t.cadenceSeconds&&t.expirySeconds>=t.cadenceSeconds*(t.maxSteps-1)+t.windowSeconds,'Expiry must cover all scheduled windows');
export type Terms=z.infer<typeof termsSchema>;
export const DEFAULT_TERMS:Terms={agentId:'',name:'First forward watch',pool:'',adapter:DAMM,orientation:'a-as-token',initialQuote:'100000000',initialTokens:'100000000',strategy:'range-rebalance',lowerBps:8500,upperBps:11500,feeBps:30,slippageBps:20,cadenceSeconds:60,windowSeconds:30,maxSteps:3,expirySeconds:600,maxStalenessSeconds:120,expectedExcessQuote:'0',expectedCoverageBps:7000,rationale:'Hypothetical equal-value rebalance outside fixed initial bounds.',evidenceRef:''};
export const frozenSchema=z.object({engine:z.literal(ENGINE),assumptions:z.literal(ASSUMPTIONS),terms:termsSchema,version:versionSchema,sourceHash:hash,versionHash:hash,tools:z.tuple([z.literal('verified-finalized-mark/1'),z.literal('deterministic-prefix-rule/1')])}).strict().superRefine((f,c)=>{if(f.terms.agentId!==f.version.agentId||f.version.policyHash!==domainHash('shadow.policy/1',f.version.db)||f.versionHash!==domainHash('forward.version/1',f.version))c.addIssue({code:'custom',message:'Inconsistent frozen policy/version'});});
export type Frozen=z.infer<typeof frozenSchema>;
export const draftHash=(f:Frozen)=>domainHash('forward.draft/1',f);
export function freeze(terms:Terms,version:z.infer<typeof versionSchema>,e:Evidence):Frozen{return frozenSchema.parse({engine:ENGINE,assumptions:ASSUMPTIONS,terms,version,sourceHash:manifestHash(e),versionHash:domainHash('forward.version/1',version),tools:['verified-finalized-mark/1','deterministic-prefix-rule/1']});}
export const commitmentHash=(f:Frozen,at:string,initial:Evidence)=>domainHash('forward.commit/1',{draftHash:draftHash(f),committedAt:at,initialHash:evidenceHash(initial)});
export const prefixHash=(observations:Evidence[])=>domainHash('forward.prefix/1',observations.map(evidenceHash));
export interface Proposal {index:number;prefixHash:string;decisionAt:string;mark:{n:string;d:string};action:'hold'|'buy'|'sell';tokens:string;gross:string;cost:string;quote:string;inventory:string;rationale:string;inRange:boolean}
export const proposalHash=(p:Proposal)=>domainHash('forward.proposal/1',p);
const value=(tokens:bigint,p:{n:string;d:string})=>tokens*BigInt(p.n)/BigInt(p.d);
export function proposal(f:Frozen,observations:Evidence[],previous:Proposal|null,at:string):Proposal{
 const last=observations.at(-1);if(!last)throw new Error('No prefix');const p=decodeEvidence(last).mark,t=f.terms,initial=decodeEvidence(observations[0]).mark;
 const inRange=BigInt(p.n)*BigInt(initial.d)*10000n>=BigInt(initial.n)*BigInt(p.d)*BigInt(t.lowerBps)&&BigInt(p.n)*BigInt(initial.d)*10000n<=BigInt(initial.n)*BigInt(p.d)*BigInt(t.upperBps);
 let q=BigInt(previous?.quote??t.initialQuote),tokens=BigInt(previous?.inventory??t.initialTokens),amount=0n,gross=0n,cost=0n,action:Proposal['action']='hold';
 if(observations.length>1&&t.strategy==='range-rebalance'&&!inRange){const tv=value(tokens,p),target=(q+tv)/2n,fee=BigInt(t.feeBps+t.slippageBps);
  if(tv>target){amount=(tv-target)*BigInt(p.d)/BigInt(p.n);if(amount>tokens)amount=tokens;gross=value(amount,p);cost=gross*fee/10000n;if(amount>0n&&gross>cost){action='sell';tokens-=amount;q+=gross-cost;}}
  else{const cap=q*10000n/(10000n+fee),wanted=target-tv;amount=(wanted<cap?wanted:cap)*BigInt(p.d)/BigInt(p.n);gross=value(amount,p);cost=gross*fee/10000n;if(amount>0n&&gross+cost<=q){action='buy';tokens+=amount;q-=gross+cost;}}
 }
 if(action==='hold'){amount=0n;gross=0n;cost=0n;}
 return {index:observations.length-1,prefixHash:prefixHash(observations),decisionAt:at,mark:p,action,tokens:amount.toString(),gross:gross.toString(),cost:cost.toString(),quote:q.toString(),inventory:tokens.toString(),rationale:t.rationale,inRange};
}
export function validateObservation(f:Frozen,e:Evidence,previous:Evidence|null,committedAt:string,decisionAt:string|null){
 const t=f.terms;if(e.pool!==t.pool||e.adapter!==t.adapter||e.orientation!==t.orientation||manifestHash(e)!==f.sourceHash)throw new Error('Source changed; end segment');
 const start=Date.parse(e.requestedAt),end=Date.parse(e.fetchedAt),base=Date.parse(committedAt);
 decodeEvidence(e);if(start<base||end>base+t.expirySeconds*1000)throw new Error('Expired observation');
 if(end-start>45000||end-e.blockTime*1000>t.maxStalenessSeconds*1000||e.blockTime*1000>end+5000)throw new Error('Stale or invalid source time');
 if(previous){if(e.slot<=previous.slot||start<=Date.parse(previous.fetchedAt)||end<=Date.parse(previous.fetchedAt)||e.blockTime<=previous.blockTime)throw new Error('Non-increasing observation');if(!decisionAt||start<=Date.parse(decisionAt))throw new Error('Decision must precede capture');if(start<Date.parse(previous.requestedAt)+t.cadenceSeconds*1000)throw new Error('Minimum spacing');if(start>base+t.expirySeconds*1000)throw new Error('Expired');}
 else if(start<base||end<base)throw new Error('Initial capture must follow commit reservation');
}
export function replay(f:Frozen,observations:Evidence[],proposals:Proposal[],committedAt:string){
 frozenSchema.parse(f);if(!observations.length||observations.length!==proposals.length||observations.length>f.terms.maxSteps)throw new Error('Invalid observation/proposal count');
 const t=f.terms,initial=decodeEvidence(observations[0]).mark,initialValue=BigInt(t.initialQuote)+value(BigInt(t.initialTokens),initial),benchTokens=initialValue*BigInt(initial.d)/BigInt(initial.n);
 let costs=0n,peak=initialValue,drawdown=0,onTime=0,inside=0;const steps=[];
 for(let i=0;i<observations.length;i++){const e=observations[i],p=proposals[i],prior=i?proposals[i-1]:null;validateObservation(f,e,i?observations[i-1]:null,committedAt,prior?.decisionAt??null);
 if(Date.parse(p.decisionAt)<Date.parse(e.fetchedAt)||Date.parse(p.decisionAt)-Date.parse(e.fetchedAt)>60000)throw new Error('Decision time');const expected=proposal(f,observations.slice(0,i+1),prior,p.decisionAt);if(canonicalize(expected)!==canonicalize(p))throw new Error('Proposal/prefix mismatch');
 // Only the preceding frozen decision is evaluated at this new observation.
 const mark=decodeEvidence(e).mark,equity=BigInt(prior?.quote??t.initialQuote)+value(BigInt(prior?.inventory??t.initialTokens),mark),hold=BigInt(t.initialQuote)+value(BigInt(t.initialTokens),mark),benchmark=value(benchTokens,mark);costs+=BigInt(prior?.cost??0);if(equity>peak)peak=equity;if(peak>0n)drawdown=Math.max(drawdown,Number((peak-equity)*10000n/peak));
 const scheduledAt=Date.parse(committedAt)+i*t.cadenceSeconds*1000,lateSeconds=Math.max(0,Math.floor((Date.parse(e.requestedAt)-scheduledAt-t.windowSeconds*1000)/1000));if(Date.parse(e.requestedAt)<=scheduledAt+t.windowSeconds*1000)onTime++;if(p.inRange)inside++;
 steps.push({index:i,equity:equity.toString(),hold:hold.toString(),benchmark:benchmark.toString(),cost:prior?.cost??'0',lateSeconds,scheduledAt:new Date(scheduledAt).toISOString(),gapSeconds:i?Math.floor((Date.parse(e.fetchedAt)-Date.parse(observations[i-1].fetchedAt))/1000):0});
 }
 const last=steps.at(-1);if(!last)throw new Error('No steps');const lastMark=decodeEvidence(observations.at(-1) as Evidence).mark;
 const contribution=proposals.slice(0,-1).reduce((sum,p)=>sum+(p.action==='buy'?1n:p.action==='sell'?-1n:0n)*(value(BigInt(p.tokens),lastMark)-BigInt(p.gross)),0n),excess=BigInt(last.equity)-BigInt(last.hold),coverageBps=Math.floor(onTime*10000/t.maxSteps);
 const tags=[];if(inside<observations.length)tags.push('sampled-range-breach');if(costs>0n&&excess<0n)tags.push('cost-drag');if(contribution<0n)tags.push('inventory-timing-loss');if(excess<BigInt(t.expectedExcessQuote))tags.push('excess-expectation-missed');if(coverageBps<t.expectedCoverageBps)tags.push('coverage-expectation-missed');if(steps.some(s=>s.lateSeconds))tags.push('late-captures');
 return {steps,finalValue:last.equity,holdValue:last.hold,benchmarkValue:last.benchmark,excess:excess.toString(),costs:costs.toString(),tradingContribution:contribution.toString(),roundingResidual:(excess+costs-contribution).toString(),maxDrawdownBps:drawdown,coverageBps,sampledInRangeBps:Math.floor(inside*10000/observations.length),earnedFees:'0',complete:observations.length===t.maxSteps&&onTime===t.maxSteps,tags,limits:'Accounting attribution only. Decision-mark hypothetical trades are not available fills. Sampled marks cannot prove continuous coverage, RPC authenticity, finality, historical timestamps or AI performance.'};
}
const proposalSchema=z.object({index:z.number().int().min(0).max(47),prefixHash:hash,decisionAt:date,mark:z.object({n:z.string().regex(/^[1-9]\d{0,100}$/),d:z.string().regex(/^[1-9]\d{0,100}$/)}).strict(),action:z.enum(['hold','buy','sell']),tokens:z.string().regex(/^(0|[1-9]\d{0,99})$/),gross:z.string().regex(/^\d{1,100}$/),cost:z.string().regex(/^\d{1,100}$/),quote:z.string().regex(/^\d{1,100}$/),inventory:z.string().regex(/^\d{1,100}$/),rationale:z.string().max(280),inRange:z.boolean()}).strict();
const eventBodies={created:z.object({draftHash:hash}).strict(),edited:z.object({draftHash:hash}).strict(),reserved:z.object({generation:z.number().int().positive(),prefixHash:hash}).strict(),committed:z.object({evidenceHash:hash,proposalHash:hash,commitment:hash}).strict(),capture:z.object({evidenceHash:hash,proposalHash:hash,commitment:hash}).strict(),failure:z.object({reason:z.enum(['source_changed','stale_source','source_unavailable']),requestedAt:date,generation:z.number().int().positive()}).strict(),ended:z.object({reason:z.enum(['expired','owner ended'])}).strict(),shared:z.object({shared:z.boolean()}).strict(),annotation:z.object({text:z.string().min(1).max(500)}).strict()};
export const eventSchema=z.object({seq:z.number().int().min(1).max(256),kind:z.enum(['created','edited','reserved','committed','capture','failure','ended','shared','annotation']),at:date,body:z.record(z.string(),z.unknown()),previous:hash,hash}).strict();
export type Event=z.infer<typeof eventSchema>;
export const eventHash=(e:Omit<Event,'hash'>)=>domainHash('forward.event/1',e);
const bundleSchema=z.object({format:z.literal(FORMAT),id:z.string().uuid(),frozen:frozenSchema,committedAt:date,commitment:hash,observations:z.array(evidenceSchema).min(1).max(48),proposals:z.array(proposalSchema).min(1).max(48),events:z.array(eventSchema).min(3).max(256),result:z.unknown(),status:z.enum(['watching','complete','partial','ended','expired','incomplete']),root:hash}).strict();
export type Bundle=z.infer<typeof bundleSchema>;
export const bundleRoot=(b:Omit<Bundle,'root'>)=>domainHash('forward.bundle/1',b);
export function verifyBundle(text:string){try{
 const b=bundleSchema.parse(parseStrictJson(text,{maxBytes:1500000,maxDepth:24}));
 if(b.commitment!==commitmentHash(b.frozen,b.committedAt,b.observations[0]))throw new Error('Commitment mismatch');
 const r=replay(b.frozen,b.observations,b.proposals,b.committedAt);
 if(canonicalize(r)!==canonicalize(b.result))throw new Error('Result mismatch');
 let previous='0'.repeat(64),time=0,observed=0,generation=0,reservation:string|null=null,currentDraft:string|null=null;
 let state:Bundle['status']='watching',committed=false,everReserved=false,lastReservationTime=0;
 const terminal=()=>state!=='watching';
 for(const [i,e] of b.events.entries()){
  eventBodies[e.kind].parse(e.body);const {hash:h,...body}=e;
  if(e.seq!==i+1||e.previous!==previous||eventHash(body)!==h||Date.parse(e.at)<time)throw new Error('History mismatch');
  time=Date.parse(e.at);previous=h;
  if(i===0&&e.kind!=='created')throw new Error('Missing creation');
  if(e.kind==='created'||e.kind==='edited'){
   if(everReserved||observed||terminal()||(e.kind==='created'&&i!==0))throw new Error('Draft ordering');
   currentDraft=e.body.draftHash as string;
  }
  if(e.kind==='reserved'){
   if(terminal()||(everReserved&&Date.parse(e.at)-lastReservationTime<60000)||Number(e.body.generation)!==generation+1||e.body.prefixHash!==prefixHash(b.observations.slice(0,observed))||(observed&&Date.parse(e.at)<=Date.parse(b.proposals[observed-1].decisionAt)))throw new Error('Reservation ordering');
   if(!everReserved&&e.at!==b.committedAt)throw new Error('Initial reservation time');
   if(Date.parse(e.at)>Date.parse(b.committedAt)+b.frozen.terms.expirySeconds*1000)throw new Error('Expired reservation');
   generation++;reservation=e.at;everReserved=true;lastReservationTime=Date.parse(e.at);
  }
  if(e.kind==='failure'){
   if(terminal()||!reservation||e.body.requestedAt!==reservation||e.body.generation!==generation||Date.parse(e.at)-Date.parse(reservation)>=60000)throw new Error('Failure ordering');
   reservation=null;if(!committed||e.body.reason==='source_changed')state='incomplete';
  }
  if(e.kind==='ended'){
   if(terminal())throw new Error('Duplicate or inconsistent terminal event');
   if(e.body.reason==='expired'){
    if(!everReserved||Date.parse(e.at)<=Date.parse(b.committedAt)+b.frozen.terms.expirySeconds*1000)throw new Error('Premature expiry');
    state='expired';
   }else state='ended';
   reservation=null;
  }
  if(e.kind==='committed'||e.kind==='capture'){
   if((e.kind==='committed'&&committed)||(e.kind==='capture'&&!committed))throw new Error('First observation must be committed');
   const n=observed;
   if(terminal()||!reservation||n>=b.observations.length||b.observations[n].requestedAt!==reservation||Date.parse(e.at)-Date.parse(reservation)>=60000||e.body.commitment!==b.commitment||(n===0&&(reservation!==b.committedAt||currentDraft!==draftHash(b.frozen)))||e.body.evidenceHash!==evidenceHash(b.observations[n])||e.body.proposalHash!==proposalHash(b.proposals[n])||e.at!==b.proposals[n].decisionAt)throw new Error('Observation/history binding');
   observed++;committed=true;reservation=null;
   if(observed===b.frozen.terms.maxSteps)state=r.complete?'complete':'partial';
  }
  if(e.kind==='shared'&&e.body.shared===true&&!committed)throw new Error('Share before commitment');
 }
 if(observed!==b.observations.length||!committed)throw new Error('Missing history');
 if(state!==b.status)throw new Error('Terminal history mismatch');
 const {root,...body}=b;if(bundleRoot(body)!==root)throw new Error('Root mismatch');
 return {ok:true,message:'PASS · source decoding and hypothetical prefix replay consistent; not RPC authenticity, timestamp or finality proof.'};
 }catch(e){return {ok:false,message:e instanceof Error?e.message:'Invalid evidence'};}}

export function toBundle(d:{id:string;frozen:Frozen;committedAt:string;commitment:string;observations:Evidence[];proposals:Proposal[];events:Event[];status:Bundle['status']}):Bundle{const b:Omit<Bundle,'root'>={format:FORMAT,...d,result:replay(d.frozen,d.observations,d.proposals,d.committedAt)};return {...b,root:bundleRoot(b)};}
