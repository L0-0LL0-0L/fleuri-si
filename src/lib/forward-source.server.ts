import { PublicKey } from '@solana/web3.js';
import { connection,solEnv,assertGenesis } from './solana.server';
import { b64 } from '@/pq/canonical';
import { decodeEvidence,DBC,DBC_PROGRAM,DAMM_PROGRAM,evidenceSchema,type Evidence } from '@/pq/forward-source';
const pub=(b:Uint8Array,o:number)=>new PublicKey(b.subarray(o,o+32)).toBase58();
// Discovery is never a mark. Final pool, config, mints and vaults come from ONE finalized context.
export async function readForwardSource(pool:string,adapter:Evidence['adapter'],orientation:Evidence['orientation'],requestedAt:string):Promise<Evidence>{
 if(solEnv().cluster!=='mainnet-beta')throw new Error('Mainnet source unavailable');const conn=connection();const genesis=await assertGenesis(conn,'mainnet-beta');const p=new PublicKey(pool),program=adapter===DBC?DBC_PROGRAM:DAMM_PROGRAM;
 const first=await conn.getAccountInfo(p,'finalized');if(!first||first.owner.toBase58()!==program||first.data.length!==(adapter===DBC?424:1112))throw new Error('Unsupported pool');
 let addresses:string[];if(adapter===DBC){const config=pub(first.data,72),c=await conn.getAccountInfo(new PublicKey(config),'finalized');if(!c||c.owner.toBase58()!==program||c.data.length!==1048)throw new Error('Unsupported config');addresses=[pool,config,pub(first.data,136),pub(c.data,8),pub(first.data,168),pub(first.data,200)];}else addresses=[pool,pub(first.data,168),pub(first.data,200),pub(first.data,232),pub(first.data,264)];
 const r=await conn.getMultipleAccountsInfoAndContext(addresses.map(s=>new PublicKey(s)),{commitment:'finalized'});const blockTime=await conn.getBlockTime(r.context.slot);if(blockTime===null)throw new Error('Source time unavailable');
 const accounts=r.value.map((a,i)=>{if(!a)throw new Error('Missing source account');return {address:addresses[i],owner:a.owner.toBase58(),data:b64(a.data)};});
 const e=evidenceSchema.parse({sourceVersion:'meteora-mark/1',adapter,pool,orientation,commitment:'finalized',genesis,slot:r.context.slot,requestedAt,fetchedAt:new Date().toISOString(),blockTime,accounts});decodeEvidence(e);return e;
}
