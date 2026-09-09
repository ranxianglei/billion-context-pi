import fs from 'node:fs';
import { createCore, defaultConfig } from 'acp-kernel';
import { entriesToCoreMessages, coreOutToAgentMessages } from '../src/messages.ts';
const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_01a07b3c-ab19-7b19-8290-f7967a8221a6.jsonl';
const raw = fs.readFileSync(jsonl,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const entries = raw.filter(r=>r.type==='message');
const state = JSON.parse(fs.readFileSync(jsonl+'.acp.json','utf8'));
const core = createCore({countTokens:null});
const turn = await core.processTurn({messages: entriesToCoreMessages(entries), state, config: defaultConfig(262144,{limit:212992}), tokenCount:167969});
const byId = new Map(entries.map(e=>[e.id, e.message]));
const rebuilt = coreOutToAgentMessages(turn.messages, byId);
function est(t){ if(!t) return 0; let cjk=0,other=0; for(const ch of t){const c=ch.codePointAt(0); if((c>=0x4E00&&c<=0x9FFF)||(c>=0x3000&&c<=0x30FF)||(c>=0xFF00&&c<=0xFFEF)) cjk++; else other++;} return Math.round(cjk+other/4); }
let thinkTok=0, thinkMsgs=0, otherTok=0, otherDetail={};
for (const m of rebuilt) {
  const c = m.content;
  if (Array.isArray(c)) for (const p of c) {
    if (p.type === 'thinking') { thinkTok += est(p.thinking||p.text||''); thinkMsgs++; }
    else if (p.type === 'text') { otherTok += est(p.text||''); otherDetail['text-'+m.role]=(otherDetail['text-'+m.role]||0)+est(p.text||''); }
    else if (p.type === 'toolCall') { const t=est(JSON.stringify(p.args??'')+p.name); otherTok+=t; otherDetail['call-'+(p.name==='compress'?'COMPRESS':p.name)]=(otherDetail['call-'+(p.name==='compress'?'COMPRESS':p.name)]||0)+t; }
    else { const t=est(JSON.stringify(p)); otherTok+=t; otherDetail['other-block']=(otherDetail['other-block']||0)+t; }
  } else if (typeof c === 'string') { otherTok += est(c); otherDetail['str-'+m.role]=(otherDetail['str-'+m.role]||0)+est(c); }
  else if (c) { const t=est(JSON.stringify(c)); otherTok+=t; otherDetail['json-'+m.role]=(otherDetail['json-'+m.role]||0)+t; }
}
console.log('rebuilt:', rebuilt.length, 'msgs');
console.log('THINKING:', thinkMsgs, 'parts =', thinkTok, 'tok  <<< pi 会原样发给模型');
console.log('non-thinking:', otherTok, 'tok; detail:', JSON.stringify(otherDetail));
const t2=[];
for (const m of rebuilt) { const c=m.content; if(Array.isArray(c)) for(const p of c) if(p.type==='thinking') t2.push([est(p.thinking||p.text||''), (m.role||'?')+'#'+rebuilt.indexOf(m)]); }
t2.sort((a,b)=>b[0]-a[0]);
console.log('top thinking:', t2.slice(0,10).map(x=>x[1]+'='+x[0]).join(' '));
