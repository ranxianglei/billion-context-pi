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
let anchorThink=0, anchorMsgs=0, recentThink=0, recentMsgs=0, otherThink=0;
const rows=[];
rebuilt.forEach((m,i)=>{
  if(!Array.isArray(m.content)) return;
  const th=m.content.filter(p=>p.type==='thinking');
  if(!th.length) return;
  const t=th.reduce((a,p)=>a+est(p.thinking||p.text||''),0);
  const hasCompress=m.content.some(p=>p.type==='toolCall'&&p.name==='compress');
  rows.push([i, m.role, hasCompress?'ANCHOR':'plain', t, th.length]);
  if(hasCompress){anchorThink+=t;anchorMsgs++;} else {recentThink+=t;recentMsgs++;}
});
console.log('带thinking的可见assistant消息:');
for(const r of rows) console.log(`  #${String(r[0]).padStart(2)} ${r[2].padEnd(6)} thinking=${String(r[3]).padStart(6)} tok (${r[4]}块)`);
console.log(`锚点(compress调用)消息: ${anchorMsgs}条, thinking ${anchorThink} tok`);
console.log(`非锚点消息: ${recentMsgs}条, thinking ${recentThink} tok`);
console.log('合计:', anchorThink+recentThink);
// 时间分布: 这些消息在会话里的位置
const poss=rows.map(r=>r[0]);
console.log('消息序号位置:', poss.join(','));
