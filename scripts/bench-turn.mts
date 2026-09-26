// Issue #561: per-turn cost benchmark — replays the context-event phases against
// a real (or synthetic) session and measures OLD (current master behavior: full
// re-projection + exact probe every turn) vs NEW (cached projection + incremental
// sent-view meter). Deterministic: no network; selftest fixture written under
// $TMPDIR only.
//
// Usage:
//   node --import tsx scripts/bench-turn.mts --selftest [--limit N] [--rounds N]
//   node --import tsx scripts/bench-turn.mts --session <file.jsonl> [--sidecar <file.acp.json>] [--limit N] [--rounds N]

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig, defaultCountTokens, createInitialState, allocateBlockId, allocateRunId, type CompressionState, type CoreMessage } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { entriesToCoreMessages } from "../src/messages.js";
import { collectCoveredMessageIds, estimateTokens, sentViewTokenCount, truncateCap } from "../src/tokens.js";
import { SentViewMeter, viewMeterFingerprint } from "../src/view-meter.js";
import { EntryProjectionCache } from "../src/projection-cache.js";

interface Args {
  selftest: boolean;
  session?: string;
  sidecar?: string;
  limit: number;
  rounds: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { selftest: false, limit: 200_000, rounds: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") args.selftest = true;
    else if (a === "--session") args.session = argv[++i];
    else if (a === "--sidecar") args.sidecar = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--rounds") args.rounds = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.selftest && !args.session) throw new Error("need --selftest or --session <file.jsonl>");
  return args;
}

function pad(base: string, n: number): string {
  let s = base;
  while (s.length < n) s += `${s}\n`;
  return s.slice(0, Math.min(s.length, n));
}

function makeFixture(): { entries: SessionEntry[]; state: CompressionState } {
  const N = 4000;
  const raw: unknown[] = [];
  for (let k = 0; k * 4 + 3 < N; k++) {
    const toolCallId = `tc-${k}`;
    const prev = (k > 0 ? `e${k * 4 - 1}` : null);
    raw.push({ type: "message", id: `e${k * 4}`, parentId: prev, timestamp: 1700000000000 + k * 4000, message: { role: "user", content: [{ type: "text", text: pad(`User request ${k}: implement and verify feature ${k % 97}.`, 250) }] } });
    raw.push({ type: "message", id: `e${k * 4 + 1}`, parentId: prev, timestamp: 1700000001000 + k * 4000, message: { role: "assistant", content: [{ type: "thinking", thinking: pad(`Thinking about step ${k}: weigh options A/B/C deterministically.`, 300) }, { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `run-step-${k}` } }] } });
    raw.push({ type: "message", id: `e${k * 4 + 2}`, parentId: prev, timestamp: 1700000002000 + k * 4000, message: { role: "toolResult", toolName: "bash", toolCallId, isError: false, content: [{ type: "text", text: pad(`step ${k} output line`, 2000 + (k % 5) * 1200) }] } });
    raw.push({ type: "message", id: `e${k * 4 + 3}`, parentId: prev, timestamp: 1700000003000 + k * 4000, message: { role: "assistant", content: [{ type: "text", text: pad(`Step ${k} done: result recorded and verified.`, 200) }] } });
  }
  const entries = raw as SessionEntry[];
  const state = createInitialState();
  const runId = allocateRunId(state);
  const mkBlock = (from: number, to: number): CompressionState["blocks"][number] => {
    const ids: string[] = [];
    for (let i = from; i <= to; i++) ids.push(`e${i}`);
    return {
      blockId: allocateBlockId(state),
      runId,
      tier: 1,
      topic: `fixture range ${from}-${to}`,
      summary: pad(`Summary of steps ${Math.floor(from / 4)}..${Math.floor(to / 4)}: decisions, verified results, open threads captured.`, 1500),
      directMessageIds: ids,
      effectiveMessageIds: ids,
      directBlockIds: [],
      compressedTokens: Math.round(ids.length * 550),
      createdAt: 1700000000000,
      survivedCount: 0,
      generation: "young",
      active: true,
    };
  };
  state.blocks = [mkBlock(20, 1999), mkBlock(2000, 3999)];
  return { entries, state };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

// Same adoption rule as src/index.ts: adopt the view reading when it diverges
// beyond noise, otherwise keep the prelim.
function adopt(prelim: number, view: number): number {
  return Math.abs(view - prelim) > Math.max(1000, 0.1 * prelim) ? view : prelim;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let entries: SessionEntry[];
  let state: CompressionState;
  if (args.selftest) {
    const fx = makeFixture();
    entries = fx.entries;
    state = fx.state;
    const dir = mkdtempSync(join(tmpdir(), "bench-turn-"));
    writeFileSync(join(dir, "fixture.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(join(dir, "fixture.acp.json"), JSON.stringify(state));
    console.log(`# selftest fixture: ${entries.length} entries, ${state.blocks.length} active blocks → ${dir}`);
  } else {
    entries = readFileSync(args.session!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEntry);
    state = args.sidecar
      ? JSON.parse(readFileSync(args.sidecar, "utf8")) as CompressionState
      : createInitialState();
    console.log(`# session: ${entries.length} entries, ${state.blocks.filter((b) => b.active).length} active blocks`);
  }

  const core = createCore({ countTokens: defaultCountTokens });
  const config = defaultConfig(args.limit);
  const systemPromptTokens = defaultCountTokens(pad("You are a coding agent with context-management tools. Compress consumed conversation ranges.", 4000));

  // Simulated growth: each round appends one user entry (append-only session).
  const appended: SessionEntry[] = [];
  for (let r = 0; r < args.rounds; r++) {
    appended.push({ type: "message", id: `app-${r}`, parentId: r === 0 ? (entries[entries.length - 1]?.id ?? null) : `app-${r - 1}`, timestamp: 1800000000000 + r, message: { role: "user", content: [{ type: "text", text: pad(`Follow-up question ${r}.`, 300) }] } } as SessionEntry);
  }

  const oldT: Record<string, number[]> = {};
  const newT: Record<string, number[]> = {};
  const record = (acc: Record<string, number[]>, phase: string, ms: number): void => {
    (acc[phase] ??= []).push(ms);
  };
  const timed = (fn: () => void): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  const projCache = new EntryProjectionCache();
  const meter = new SentViewMeter();
  const meterSources: string[] = [];

  // ---- one-time costs (first fire / session resume) ----
  const oneTimeMs = timed(() => {
    entriesToCoreMessages(entries); // full projection (cold cache does the same)
    projCache.project(entries); // warm the cache (miss)
    const cm = entriesToCoreMessages(entries);
    const prelim = estimateTokens(cm, collectCoveredMessageIds(state)) + systemPromptTokens;
    const view = sentViewTokenCount(core, cm, state, config, prelim, undefined, systemPromptTokens); // exact seed probe
    meter.resync(view.viewTokens, entries, viewMeterFingerprint(state, systemPromptTokens));
  });

  // ---- rounds ----
  for (let r = 0; r < args.rounds; r++) {
    const session = [...entries, ...appended.slice(0, r + 1)];

    // OLD: current master path (full re-projection + exact probe every turn)
    let oldCm: CoreMessage[] = [];
    record(oldT, "projection-full", timed(() => { oldCm = entriesToCoreMessages(session); }));
    let oldCovered: Set<string> = new Set();
    record(oldT, "coveredIds-x2", timed(() => { collectCoveredMessageIds(state); oldCovered = collectCoveredMessageIds(state); }));
    let oldPrelim = 0;
    record(oldT, "estimateTokens-raw", timed(() => { oldPrelim = estimateTokens(oldCm, oldCovered) + systemPromptTokens; }));
    let oldView = oldPrelim;
    record(oldT, "probe-exact", timed(() => { oldView = sentViewTokenCount(core, oldCm, state, config, oldPrelim, undefined, systemPromptTokens).viewTokens; }));
    let oldPass: ReturnType<typeof core.processTurn> | null = null;
    record(oldT, "processTurn-real", timed(() => { oldPass = core.processTurn({ messages: oldCm, state: structuredClone(state), config, tokenCount: adopt(oldPrelim, oldView) }); }));
    record(oldT, "save-stringify", timed(() => { JSON.stringify(oldPass!.state); }));

    // NEW: cached projection + incremental sent-view meter
    let newRes: { coreMessages: CoreMessage[]; hit: boolean } | null = null;
    record(newT, "projection-cached", timed(() => { newRes = projCache.project(session); }));
    let newCovered: Set<string> = new Set();
    record(newT, "coveredIds-x2", timed(() => { collectCoveredMessageIds(state); newCovered = collectCoveredMessageIds(state); }));
    let newPrelim = 0;
    record(newT, "estimateTokens-raw", timed(() => { newPrelim = estimateTokens(newRes!.coreMessages, newCovered) + systemPromptTokens; }));
    let fp = "";
    record(newT, "fingerprint", timed(() => { fp = viewMeterFingerprint(state, systemPromptTokens); }));
    const reason = meter.resyncReason({ entries: session, fingerprint: fp, prelim: newPrelim, config });
    meterSources.push(reason ?? "meter");
    let newView = newPrelim;
    if (reason === null) {
      record(newT, "meter-extrapolate", timed(() => { newView = meter.extrapolate(session); }));
    } else {
      record(newT, "probe-fallback", timed(() => {
        const v = sentViewTokenCount(core, newRes!.coreMessages, state, config, newPrelim, undefined, systemPromptTokens);
        meter.resync(v.viewTokens, session, fp);
        newView = v.viewTokens;
      }));
    }
    let newPass: ReturnType<typeof core.processTurn> | null = null;
    record(newT, "processTurn-real", timed(() => { newPass = core.processTurn({ messages: newRes!.coreMessages, state: structuredClone(state), config, tokenCount: adopt(newPrelim, newView) }); }));
    record(newT, "save-stringify", timed(() => { JSON.stringify(newPass!.state); }));
    record(newT, "pass-refresh", timed(() => {
      const passView = estimateTokens(newPass!.messages, collectCoveredMessageIds(newPass!.state)) + systemPromptTokens;
      meter.resync(passView, session, viewMeterFingerprint(newPass!.state, systemPromptTokens));
    }));
  }

  const fmt = (ms: number): string => ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
  const table = (title: string, acc: Record<string, number[]>): void => {
    console.log(`\n## ${title}`);
    console.log("| phase | cost/turn (median) |");
    console.log("|---|---|");
    let total = 0;
    for (const [phase, xs] of Object.entries(acc)) {
      if (xs.every((x) => x === 0)) continue;
      total += median(xs);
      console.log(`| ${phase} | ${fmt(median(xs))} |`);
    }
    console.log(`| **total** | **${fmt(total)}** |`);
  };
  table("OLD (master)", oldT);
  table("NEW (#561)", newT);
  console.log(`\n| one-time (full projection + seed probe) | ${fmt(oneTimeMs)} |`);
  console.log(`# meter path per round: [${meterSources.join(", ")}]`);
  console.log(`# truncateCap(config) = ${truncateCap(config)}, session entries = ${entries.length}`);
}

main();
