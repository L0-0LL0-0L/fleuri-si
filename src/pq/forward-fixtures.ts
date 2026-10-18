// Deterministic evidence fixture; never used as live observations.
import { PublicKey } from '@solana/web3.js';
import { b64 } from './canonical';
import { DBC,DAMM,DBC_PROGRAM,DAMM_PROGRAM,TOKEN_PROGRAM,type Evidence } from './forward-source';
const pk=(n:number)=>new PublicKey(new Uint8Array(32).fill(n));
const seed=(s:string)=>new TextEncoder().encode(s);
const pda=(program:string,seeds:Uint8Array[])=>PublicKey.findProgramAddressSync(seeds,new PublicKey(program))[0];
const put=(d:Uint8Array,o:number,p:PublicKey)=>d.set(p.toBytes(),o);
const u64=(d:Uint8Array,o:number,n:bigint)=>new DataView(d.buffer).setBigUint64(o,n,true);
const u128=(d:Uint8Array,o:number,n:bigint)=>{u64(d,o,n&((1n<<64n)-1n));u64(d,o+8,n>>64n);};
export function sourceFixture(adapter:Evidence['adapter']=DAMM,index=0,sqrt=1n<<64n,orientation:Evidence['orientation']='a-as-token'):Evidence{
 const program=adapter===DBC?DBC_PROGRAM:DAMM_PROGRAM,a=pk(2),b=pk(3),config=pk(4),pool=adapter===DBC?pda(program,[seed('pool'),config.toBytes(),b.toBytes(),a.toBytes()]):pk(5),av=pda(program,[seed('token_vault'),a.toBytes(),pool.toBytes()]),bv=pda(program,[seed('token_vault'),b.toBytes(),pool.toBytes()]),authority=pda(program,[seed('pool_authority')]);
 const pd=new Uint8Array(adapter===DBC?424:1112);pd.set(adapter===DBC?[213,224,5,209,98,69,119,92]:[241,154,109,4,17,177,109,188]);
 if(adapter===DBC){put(pd,72,config);put(pd,136,a);put(pd,168,av);put(pd,200,bv);u128(pd,280,sqrt);}else{put(pd,168,a);put(pd,200,b);put(pd,232,av);put(pd,264,bv);u128(pd,360,1000n);u128(pd,424,1n);u128(pd,440,(1n<<128n)-1n);u128(pd,456,sqrt);}
 const mint=(p:PublicKey,decimals:number)=>{const d=new Uint8Array(82);d[44]=decimals;d[45]=1;return {address:p.toBase58(),owner:TOKEN_PROGRAM,data:b64(d)};};
 const vault=(p:PublicKey,m:PublicKey)=>{const d=new Uint8Array(165);put(d,0,m);put(d,32,authority);d[108]=1;return {address:p.toBase58(),owner:TOKEN_PROGRAM,data:b64(d)};};
 const accounts=[{address:pool.toBase58(),owner:program,data:b64(pd)},mint(a,6),mint(b,9),vault(av,a),vault(bv,b)];if(adapter===DBC){const d=new Uint8Array(1048);d.set([26,108,14,123,116,230,129,43]);put(d,8,b);d[235]=6;accounts.splice(1,0,{address:config.toBase58(),owner:program,data:b64(d)});}
 const start=Date.parse('2026-10-18T12:00:00.000Z')+index*60000;return {sourceVersion:'meteora-mark/1',adapter,pool:pool.toBase58(),orientation,commitment:'finalized',genesis:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',slot:1000+index,blockTime:Math.floor(start/1000),requestedAt:new Date(start).toISOString(),fetchedAt:new Date(start+1000).toISOString(),accounts};
}
