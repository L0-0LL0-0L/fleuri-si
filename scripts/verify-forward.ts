// Local-only CLI; never imported by the app.
import { readFileSync } from 'node:fs';
import { verifyBundle } from '../src/domain/forward';
const path=process.argv[2];
if(!path){console.error('Usage: bun scripts/verify-forward.ts evidence.json');process.exit(2);}
const result=verifyBundle(readFileSync(path,'utf8'));
console.log(result.message);
process.exitCode=result.ok?0:1;
