import { FORMAT, bundleRoot, verifyBundle, type Bundle } from '@/domain/shadow';
// Browser-only export of the already authorized DTO; no additional private reads.
export function toDownloadBundle(d: any): Bundle {
 const s=d.season; if(s.status!=='completed'||!d.seed)throw new Error('Not completed');
 const b:Omit<Bundle,'root'>={format:FORMAT,id:s.id,frozen:s.frozen,committedAt:new Date(s.committed_at).toISOString(),commitment:s.commitment,seed:d.seed,tape:s.tape,result:s.result,resultHash:s.result_hash,events:d.events,exportedAt:new Date().toISOString()};
 const bundle={...b,root:bundleRoot(b)};if(!verifyBundle(JSON.stringify(bundle)).ok)throw new Error('Inconsistent evidence');return bundle;
}
