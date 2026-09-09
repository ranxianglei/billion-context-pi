import fs from 'node:fs';
import { createCore, createInitialState } from 'acp-kernel';
import { entriesToCoreMessages, coreOutToAgentMessages } from '../src/messages.ts';
import { resolveConfig } from '../src/config.ts';
const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_01a07b3c-ab19-7b19-8290-f7967a8221a6.jsonl';
const raw = fs.readFileSync(jsonl,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const entries = raw.filter(r=>r.type==='message');
const state = JSON.parse(fs.readFileSync(jsonl+'.acp.json','utf8'));
function est(t){ if(!t) return 0; let cjk=0,other=0; for(const ch of t){const c=ch.codePointAt(0); if((c>=0x4E00&&c<=0x9FFF)||(c>=0x3000&&c<=0x30FF)||(c>=0xFF00&&c<=0xFFEF)) cjk++; else other++;} return Math.round(cjk+other/4); }
const config = resolveConfig({}, 212992);
for (const policy of ['always','open-round']) {
  const core = createCore({ countTokens: (t)=>Math.ceil(t.length/4) });
  const cfg = { ...config, reasoningReplay: policy };
  const turn = await core.processTurn({ messages: entriesToCoreMessages(entries), state, config: cfg, tokenCount: 167969 });
  const byId = new Map(entries.map(e=>[e.id, e.message]));
  const rebuilt = coreOutToAgentMessages(turn.messages, byId);
  let thinkTok=0, otherTok=0, anchorStub=0;
  for (const m of rebuilt) {
    const c = m.content;
    if (Array.isArray(c)) for (const p of c) {
      if (p.type === 'thinking') thinkTok += est(p.thinking||p.text||'');
      else if (p.type === 'text') otherTok += est(p.text||'');
      else if (p.type === 'toolCall') { const t=est(typeof p.arguments==='string'?p.arguments:JSON.stringify(p.arguments??'')); otherTok+=t; if(m.role==='assistant'&&(p.name==='compress')) anchorStub+=t; }
    } else if (typeof c === 'string') otherTok += est(c);
  }
  // summaries
  let sumTok=0; for (const m of turn.messages) if (String(m.id).startsWith('acp_summary')) sumTok += est(m.text||'');
  console.log(`policy=${policy.padEnd(10)} rebuilt=${rebuilt.length}条 thinking=${thinkTok} 非thinking=${otherTok}(其中compress调用args=${anchorStub}) 摘要=${sumTok} 视图合计≈${thinkTok+otherTok+sumTok}`);
}
