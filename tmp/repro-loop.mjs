import fs from 'node:fs';
import { createCore } from 'acp-kernel';
import { entriesToCoreMessages, coreOutToAgentMessages } from '../src/messages.ts';

const sid = '01a07b3c-ab19-7b19-8290-f7967a8221a6';
const jsonl = '/home/dog/.pi/agent/sessions/--home-dog-projects-billion-context-paper--/2026-09-07T09-39-28-665Z_' + sid + '.jsonl';
const sidecar = jsonl + '.acp.json';

const raw = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// Simulate the 01:25:38 turn: everything up to and including the failed retry #1 (lines 1..582)
const entries = raw.slice(0, 582).filter(r => r.type === 'message');
console.log('total entries:', entries.length, 'raw records kept:', 582);

const coreMessages = entriesToCoreMessages(entries);
console.log('coreMessages:', coreMessages.length);

const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
const state = parsed;
console.log('blocks:', state.blocks.length, 'active:', state.blocks.filter(b => b.active).length);

import { defaultConfig } from 'acp-kernel'; const config = defaultConfig(262144, { limit: 212992 });
const core = createCore({ countTokens: null }); const turn = await core.processTurn({ messages: coreMessages, state, config, tokenCount: 117661 });
console.log('turn.outMessages:', turn.messages.length);

// entry ids of interest: find compress tool calls + results in the tail
const tail = entries.slice(-10);
for (const e of tail) {
  const s = JSON.stringify(e.message?.content ?? '').slice(0, 120).replace(/"/g, "'");
  console.log('TAIL', e.id, e.message.role, s);
}

// which of the last 6 entries survive kernel output?
const coreIds = new Set(turn.messages.map(m => m.id));
for (const e of tail.slice(-6)) {
  const base = e.id;
  const hitUser = coreIds.has(base);
  const parts = turn.messages.filter(m => m.id && m.id.startsWith(base + '#')).map(m => m.id.split('#')[1]);
  console.log('SURVIVES-KERNEL', base, e.message.role, hitUser || (parts.length ? parts.join(',') : 'NO'));
}

// adapter reconstruction
const originals = new Map(); for (const e of entries) { if (e.message) originals.set(e.id, e.message); }
const rebuilt = coreOutToAgentMessages(turn.messages, originals);
const rebuiltIds = new Set(rebuilt.map(m => m.id));
for (const e of tail.slice(-6)) {
  console.log('SURVIVES-ADAPTER', e.id, rebuiltIds.has(e.id) ? 'YES' : 'NO');
}

// WHY did adapter drop them? Inspect the core ids the kernel emitted for these entries
console.log('\n--- core ids around tail ---');
for (const m of turn.messages.slice(-12)) {
  console.log(JSON.stringify({ id: m.id, role: m.role, toolCallId: m.toolCallId, text: (m.text || '').slice(0, 60) }));
}
console.log('\noriginals has keys?', originals.has('38662d11'), originals.has('261939c7'), originals.has('408ada78'));

console.log('\n--- rebuilt content scan ---');
let foundCallA = 0, foundResultA = 0, foundCallB = 0;
for (const m of rebuilt) {
  const s = JSON.stringify(m);
  if (s.includes('call_7447fa18e4ad4597bd93359e')) {
    if (m.role === 'assistant') foundCallA++;
    if (m.role === 'user' || m.role === 'tool') foundResultA++;
  }
  if (s.includes('call_719565ce69a24e208c058a3a')) foundCallB++;
}
console.log({ foundCallA, foundResultA, foundCallB, rebuiltTotal: rebuilt.length });
const idx = rebuilt.findIndex(m => JSON.stringify(m).includes('call_7447fa18e4ad4597bd93359e'));
console.log('first compress-call msg idx in rebuilt:', idx, '/', rebuilt.length);
if (idx >= 0) console.log('content blocks:', JSON.stringify(rebuilt[idx].content).slice(0, 400));

console.log('\n--- result scan by text ---');
for (const m of rebuilt) {
  const s = JSON.stringify(m);
  if (s.includes('41.4K') || s.includes('Requested range')) {
    console.log('RESULT-FOUND role=', m.role, 'content preview:', s.slice(0, 300));
  }
}
console.log('rebuilt tail roles:', rebuilt.slice(-6).map(m => m.role + ':' + JSON.stringify(m.content?.[0]?.text || m.content?.[0]?.thinking || m.content?.[0]?.type || '').slice(0, 50)));
