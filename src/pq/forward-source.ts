// Minimal IDL-checked read-only evidence decoder. No SDK/client RPC imports.
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { fromB64, b64, domainHash } from './canonical';
export const DBC = 'dbc-v1', DAMM = 'damm-v2-v1';
export const SOURCE_VERSION = 'meteora-mark/1';
export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const DAMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const addressSchema = z.string().refine(s => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }, 'Invalid Solana address');
const accountSchema = z.object({ address: addressSchema, owner: addressSchema, data: z.string().max(6000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export const evidenceSchema = z.object({ sourceVersion: z.literal(SOURCE_VERSION), adapter: z.enum([DBC,DAMM]), pool: addressSchema, orientation: z.enum(['a-as-token','b-as-token']), commitment: z.literal('finalized'), genesis: z.literal('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'), slot: z.number().int().positive().safe(), requestedAt: z.string().datetime(), fetchedAt: z.string().datetime(), blockTime: z.number().int().positive(), accounts: z.array(accountSchema).min(5).max(6) }).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
const view = (d: Uint8Array) => new DataView(d.buffer,d.byteOffset,d.length);
const u64 = (d: Uint8Array,o:number) => view(d).getBigUint64(o,true);
const u128 = (d: Uint8Array,o:number) => u64(d,o)+(u64(d,o+8)<<64n);
const key = (d: Uint8Array,o:number) => new PublicKey(d.subarray(o,o+32)).toBase58();
const pda = (program:string,seeds:Uint8Array[]) => PublicKey.findProgramAddressSync(seeds,new PublicKey(program))[0].toBase58();
const bytes = (s:string) => new PublicKey(s).toBytes();
const seed = (s:string) => new TextEncoder().encode(s);
const gcd = (a:bigint,b:bigint):bigint => b===0n?a:gcd(b,a%b);
export function rational(n:bigint,d:bigint) { if(n<=0n||d<=0n)throw new Error('Invalid mark');const g=gcd(n,d);return {n:(n/g).toString(),d:(d/g).toString()}; }
export function decodeEvidence(input: Evidence) {
 const e=evidenceSchema.parse(input); if(Date.parse(e.fetchedAt)<Date.parse(e.requestedAt))throw new Error('Capture time order');
 const map=new Map(e.accounts.map(a=>[a.address,a]));if(map.size!==e.accounts.length)throw new Error('Duplicate source account');
 const account=(address:string,owner:string,size:number)=>{const a=map.get(address);if(!a||a.owner!==owner)throw new Error('Source account identity');const d=fromB64(a.data);if(d.length!==size||b64(d)!==a.data)throw new Error('Unsupported source layout');return d;};
 const program=e.adapter===DBC?DBC_PROGRAM:DAMM_PROGRAM;
 const pool=account(e.pool,program,e.adapter===DBC?424:1112);const disc=e.adapter===DBC?[213,224,5,209,98,69,119,92]:[241,154,109,4,17,177,109,188];if(!disc.every((v,i)=>pool[i]===v))throw new Error('Pool discriminator');
 let a:string,b:string,av:string,bv:string,sqrt:bigint,config:string|null=null;
 if(e.adapter===DBC){
  config=key(pool,72);const c=account(config,program,1048);if(![26,108,14,123,116,230,129,43].every((v,i)=>c[i]===v))throw new Error('Config discriminator');
  a=key(pool,136);b=key(c,8);av=key(pool,168);bv=key(pool,200);sqrt=u128(pool,280);
  if(pool[304]!==0||pool[305]!==0||pool[308]!==0||u64(pool,344)!==0n||c[237]!==0||c[238]!==0)throw new Error('Unsupported or migrating DBC');
  const sorted=[bytes(a),bytes(b)].sort((x,y)=>{for(let i=0;i<32;i++)if(x[i]!==y[i])return y[i]-x[i];return 0;});
  if(pda(program,[seed('pool'),bytes(config),...sorted])!==e.pool)throw new Error('DBC pool PDA');
  if(c[234]>1||u64(pool,296)>BigInt(c[234]===0?e.slot:e.blockTime))throw new Error('Pool not activated');
 }else{
  a=key(pool,168);b=key(pool,200);av=key(pool,232);bv=key(pool,264);sqrt=u128(pool,456);
  // Compounding uses different accounting: intentionally unsupported, never infer reserves as price.
  if(pool[481]!==0||pool[482]!==0||pool[483]!==0||pool[484]>1||pool[480]>1||u128(pool,360)===0n||sqrt<u128(pool,424)||sqrt>u128(pool,440)||u64(pool,472)>BigInt(pool[480]===0?e.slot:e.blockTime))throw new Error('Unsupported or inactive DAMM v2');
 }
 if(a===b||sqrt===0n)throw new Error('Invalid pair or price');
 const mint=(m:string)=>{const d=account(m,TOKEN_PROGRAM,82);if(d[45]!==1||d[44]>12||![0,1].includes(view(d).getUint32(0,true))||![0,1].includes(view(d).getUint32(46,true)))throw new Error('Unsupported mint');return d[44];};
 const ad=mint(a),bd=mint(b);if(config&&account(config,program,1048)[235]!==ad)throw new Error('Mint decimal mismatch');
 for(const [v,m] of [[av,a],[bv,b]]){if(pda(program,[seed('token_vault'),bytes(m),bytes(e.pool)])!==v)throw new Error('Vault PDA');const d=account(v,TOKEN_PROGRAM,165);if(key(d,0)!==m||d[108]!==1||key(d,32)!==pda(program,[seed('pool_authority')]))throw new Error('Vault custody');}
 if(e.accounts.length!==(config?6:5))throw new Error('Extraneous source accounts');
 const inverted=e.orientation==='b-as-token';const mark=inverted?rational(1n<<128n,sqrt*sqrt):rational(sqrt*sqrt,1n<<128n);
 return {sourceVersion:SOURCE_VERSION,adapter:e.adapter,pool:e.pool,program,config,orientation:e.orientation,tokenMint:inverted?b:a,quoteMint:inverted?a:b,tokenDecimals:inverted?bd:ad,quoteDecimals:inverted?ad:bd,mark,formula:'sqrtPrice²/2^128 quote-atomic/token-atomic; inverted when B is token' as const};
}
export const evidenceHash=(e:Evidence)=>domainHash('forward.evidence/1',e);
export const manifestHash=(e:Evidence)=>{const {mark,...m}=decodeEvidence(e);return domainHash('forward.source/1',m);};