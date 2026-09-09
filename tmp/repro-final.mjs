import fs from 'node:fs';
import { createCore, defaultConfig } from 'acp-kernel';
import { entriesToCoreMessages, coreOutToAgentMessages } from '../src/messages.ts';

const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_01a07b3c-ab19-7b19-8290-f7967a8221a6.jsonl';
const raw = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const entries = raw.filter(r => r.type === 'message');
const coreMessages = entriesToCoreMessages(entries);
const state = JSON.parse(fs.readFileSync(jsonl + '.acp.json', 'utf8'));
const core = createCore({ countTokens: null });
const config = defaultConfig(262144, { limit: 212992 });
const turn = await core.processTurn({ messages: coreMessages, state, config, tokenCount: 117661 });

// find all compress-related messages surviving in kernel output
const keep = turn.messages.filter(m => {
  const s = JSON.stringify(m);
  return s.includes('"compress"') || s.includes('Requested range') || s.includes('41.4K') || s.includes('PAUSED') || s.includes('REJECTED');
});
console.log('kernel-kept compress-related msgs:', keep.length, 'of', turn.messages.length);
for (const m of keep) console.log(' ', m.id, m.role, (m.text || '').slice(0, 100).replace(/\n/g, ' '));

const originals = new Map(); for (const e of entries) { if (e.message) originals.set(e.id, e.message); }
const rebuilt = coreOutToAgentMessages(turn.messages, originals);
const rk = rebuilt.filter(m => { const s = JSON.stringify(m); return s.includes('Requested range') || s.includes('41.4K') || s.includes('PAUSED') || s.includes('REJECTED'); });
console.log('rebuilt compress-related msgs:', rk.length, 'of', rebuilt.length);
for (const m of rk) console.log(' ', m.role, JSON.stringify(m.content?.[0]?.text || '').slice(0, 100));

// count assistant turns whose thinking mentions rejection keywords
let seen = 0;
for (const e of entries) {
  const th = e.message?.content?.find?.(b => b.type === 'thinking');
  if (th && /REJECTED|already compressed|Requested range/.test(th.thinking || '')) seen++;
}
console.log('assistant thinkings mentioning rejection feedback:', seen);
