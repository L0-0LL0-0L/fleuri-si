import { watch } from "./src/lib/watchtower.server";
const r = await watch(process.argv[2]);
const { input, summary } = r;
console.log(JSON.stringify({ slots: input.slots, stage: summary.stage, progress: summary.progressBps, damm: summary.damm, checks: summary.checks.map(c=>[c.id,c.status,c.detail]), configured: summary.configured, discovery: input.discovery, positions: summary.positions, posErr: input.positionErrors, routing: summary.routing, vaults: input.vaults.map(v=>v.address), dammFacts: input.damm.facts && {...input.damm.facts, baseFeeBytesHex: input.damm.facts.baseFeeBytesHex.slice(0,16)} }, null, 1));
