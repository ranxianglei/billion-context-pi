import fs from 'node:fs';
import { createCore, defaultConfig } from 'acp-kernel';
import { entriesToCoreMessages } from '../src/messages.ts';

const sid = '01a07b3c-ab19-7b19-8290-f7967a8221a6';
const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_' + sid + '.jsonl';
const sidecar = jsonl + '.acp.json';

const raw = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const entries = raw.filter(r => r.type === 'message');
const state = JSON.parse(fs.readFileSync(sidecar, 'utf8'));

// CJK-aware estimate: CJK chars ~1 token each, others ~chars/4
function est(text) {
  if (!text) return 0;
  let cjk = 0, other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x30FF) || (c >= 0xFF00 && c <= 0xFFEF)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 4);
}
const S = (x) => JSON.stringify(x);

const core = createCore({ countTokens: null });
const config = defaultConfig(262144, { limit: 212992 });
const turn = await core.processTurn({ messages: entriesToCoreMessages(entries), state, config, tokenCount: 180000 });

const byId = new Map(entries.map(e => [e.id, e]));
const cats = { summary: 0, sysNudge: 0, anchorCall: 0, anchorResult: 0, toolResult: 0, userText: 0, asstText: 0, toolCall: 0, thinking: 0, other: 0 };
const catMsgs = { ...cats };
let n = 0;
for (const m of turn.messages) {
  n++;
  if (m.role === 'system') { const t = est(S(m.content)); cats.sysNudge += t; catMsgs.sysNudge++; continue; }
  if (String(m.id || '').startsWith('acp_summary')) { const t = est(typeof m.content === 'string' ? m.content : S(m.content)); cats.summary += t; catMsgs.summary++; continue; }
  const base = String(m.id || '').split('#')[0];
  const e = byId.get(base);
  const body = e ? e.message : m;
  let text = '';
  if (body.role === 'user') {
    const c = body.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.map(p => p.type === 'tool_result' ? (typeof p.content === 'string' ? p.content : S(p.content)) : (p.text || '')).join(' ');
    if (Array.isArray(body.content) && body.content.some(p => p.type === 'tool_result')) {
      const isCompress = S(body.content).includes('ACP') || S(body.content).includes('compress');
      if (isCompress) { cats.anchorResult += est(text); catMsgs.anchorResult++; }
      else { cats.toolResult += est(text); catMsgs.toolResult++; }
      continue;
    }
    cats.userText += est(text); catMsgs.userText++; continue;
  } else if (body.role === 'assistant') {
    const c = body.content;
    if (Array.isArray(c)) {
      let callText = '', textText = '', thinkText = '';
      for (const p of c) {
        if (p.type === 'tool_call') callText += S(p.args ?? p.input ?? '') + p.name;
        else if (p.type === 'thinking') thinkText += p.text || '';
        else if (p.type === 'text') textText += p.text || '';
      }
      if (callText.includes('"compress"') || callText.includes("'compress'") || /compress/.test(callText.slice(0, 200))) { cats.anchorCall += est(callText + textText); catMsgs.anchorCall++; }
      else { cats.toolCall += est(callText); cats.asstText += est(textText); cats.thinking += est(thinkText); catMsgs.toolCall++; }
    } else { cats.asstText += est(S(c)); catMsgs.asstText++; }
    continue;
  }
  cats.other += est(S(body.content)); catMsgs.other++;
}

console.log('view messages:', n);
let total = 0;
for (const k of Object.keys(cats)) {
  total += cats[k];
  console.log(String(k).padEnd(12), String(cats[k]).padStart(7), 'tok,', String(catMsgs[k]).padStart(3), 'msgs');
}
console.log('VIEW TOTAL (excl. system prompt):', total);

// active blocks summary mass detail
const active = state.blocks.filter(b => b.active);
const sumTok = active.map(b => est(b.summary || '')).sort((a, b) => b - a);
console.log('active blocks:', active.length, 'summary est (CJK-aware):', sumTok.reduce((a, b) => a + b, 0), 'per-block:', sumTok.join(','));
