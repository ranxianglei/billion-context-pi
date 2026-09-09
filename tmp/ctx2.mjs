import fs from 'node:fs';
import { createCore, defaultConfig } from 'acp-kernel';
import { entriesToCoreMessages } from '../src/messages.ts';
const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_01a07b3c-ab19-7b19-8290-f7967a8221a6.jsonl';
const raw = fs.readFileSync(jsonl,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const entries = raw.filter(r=>r.type==='message');
const state = JSON.parse(fs.readFileSync(jsonl+'.acp.json','utf8'));
const core = createCore({countTokens:null});
const turn = await core.processTurn({messages: entriesToCoreMessages(entries), state, config: defaultConfig(262144,{limit:212992}), tokenCount:180000});
function est(t){ if(!t) return 0; let cjk=0,other=0; for(const ch of t){const c=ch.codePointAt(0); if((c>=0x4E00&&c<=0x9FFF)||(c>=0x3000&&c<=0x30FF)||(c>=0xFF00&&c<=0xFFEF)) cjk++; else other++;} return Math.round(cjk+other/4); }
const TAGRE=/^<acp tokens=[^>]*>/;
const cats={}; const tag=()=>{let t=0;return (x)=>{t+=x;return t;}}; let tagTotal=0;
const add=(k,tok,msg)=>{ if(!cats[k]) cats[k]=[0,0]; cats[k][0]+=tok; cats[k][1]+=msg; };
for (const m of turn.messages) {
  let text=m.text||'';
  let tagTok=0;
  const tm=text.match(TAGRE); if(tm){ tagTok=est(tm[0]); text=text.slice(tm[0].length); }
  tagTotal+=tagTok;
  const body=est(text);
  if(m.role==='system'){ add(String(m.id).startsWith('acp_summary')?'summary(压缩摘要)':'nudge(注入)', body,1); }
  else if(m.role==='user') add('userText', body,1);
  else if(m.role==='tool') add(m.toolName==='compress'?'anchorResult(compress结果)':'toolResult(工具输出)', body,1);
  else if(m.role==='assistant') add(m.contentType==='tool-call' ? (m.toolName==='compress'?'anchorCall(compress调用)':'toolCall(其他调用)') : 'asstText(助手文本)', body,1);
  else add('other',body,1);
}
console.log('view messages:', turn.messages.length);
let tot=tagTotal;
for(const [k,[t,n]] of Object.entries(cats)){ tot+=t; console.log(k.padEnd(24), String(t).padStart(6),'tok', String(n).padStart(3),'msgs'); }
console.log('acp标签(全部消息)', String(Math.round(tagTotal)).padStart(6),'tok');
console.log('VIEW TOTAL:', tot, 'tok (CJK-aware, 不含系统提示词)');
// per-message top10
const tops=turn.messages.map(m=>({id:m.id,n:m.toolName||m.role,t:est((m.text||'').replace(TAGRE,''))})).sort((a,b)=>b.t-a.t).slice(0,12);
console.log('TOP12:', tops.map(x=>`${x.id.slice(0,12)}(${x.n})=${x.t}`).join(' '));
