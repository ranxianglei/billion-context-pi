import fs from 'node:fs';
import { createCore, defaultConfig } from 'acp-kernel';
import { entriesToCoreMessages } from '../src/messages.ts';
const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_01a07b3c-ab19-7b19-8290-f7967a8221a6.jsonl';
const raw = fs.readFileSync(jsonl,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const entries = raw.filter(r=>r.type==='message');
const state = JSON.parse(fs.readFileSync(jsonl+'.acp.json','utf8'));
const core = createCore({countTokens:null});
const turn = await core.processTurn({messages: entriesToCoreMessages(entries), state, config: defaultConfig(262144,{limit:212992}), tokenCount:180000});
const ms = turn.messages;
console.log('count', ms.length);
const shapes = {};
for (const m of ms) { const k = m.role+':'+Object.keys(m).join('+'); shapes[k]=(shapes[k]||0)+1; }
console.log(shapes);
for (const role of ['system','user','assistant']) {
  const m = ms.find(x=>x.role===role);
  if (m) console.log('SAMPLE', role, JSON.stringify(m).slice(0,400));
}
const sm = ms.filter(m=>String(m.id||'').startsWith('acp_summary'));
console.log('summaries in view:', sm.length, sm.slice(0,2).map(m=>JSON.stringify(m).slice(0,200)));
