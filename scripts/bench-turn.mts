// Offline per-turn cost benchmark for billion-context-pi, using the real
// 10-day session (24.5k messages, 23.5k folded). Read-only: never writes state.
// Models the context-event hot path BEFORE (probe every turn) and AFTER
// (issue #561: incremental projection + prev-turn sent-view meter) the fix.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { createCore, defaultCountTokens, defaultConfig } from "acp-kernel";
import { entriesToCoreMessages, EntryProjectionCache } from "../src/messages.js";
import { estimateTokens, collectCoveredMessageIds, sentViewTokenCount, sentViewMeterMatches } from "../src/tokens.js";

const jsonl = process.argv[2];
const sidecar = process.argv[3];

const t = (name, fn) => {
  const t0 = performance.now();
  const out = fn();
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`${ms.padStart(8)} ms  ${name}`);
  return out;
};

const raw = readFileSync(jsonl, "utf8");
const entries = t("parseSessionEntries (host, per resume)", () => parseSessionEntries(raw));
console.log(`            entries=${entries.length} msgs=${entries.filter((e) => e.type === "message" || e.type === "custom_message").length}`);
const state = t("JSON.parse sidecar acp.json (8.4MB)", () => JSON.parse(readFileSync(sidecar, "utf8")));
console.log(`            blocks=${state.blocks.length} active=${state.blocks.filter((b) => b.active).length}`);
const config = defaultConfig();
config.modelContextLimit = 868928;
const core = createCore({ countTokens: defaultCountTokens });

// --- BEFORE: every turn re-projects and runs the probe
const cmFull = t("entriesToCoreMessages [stateFor]", () => entriesToCoreMessages(entries));
const coveredIds = t("collectCoveredMessageIds", () => collectCoveredMessageIds(state));
const est = t("estimateTokens (ext, raw view)", () => estimateTokens(cmFull, coveredIds));
console.log(`            estimateTokens=${est}`);
const probe = t("sentViewTokenCount (clone+processTurn#1+est)", () => sentViewTokenCount(core, cmFull, state, config, est));
console.log(`            viewTokens=${probe.viewTokens} drifted=${probe.drifted}`);
const turnOld = t("processTurn REAL [index.ts]", () => core.processTurn({ messages: cmFull, state, config, tokenCount: est }));
console.log(`            outMsgs=${turnOld.messages.length}`);
t("runtime.save payload (JSON.stringify state)", () => JSON.stringify(state).length);

// --- AFTER (issue #561): steady-state turn = incremental projection + meter
console.log("\n--- issue #561 steady-state turn ---");
const cache = new EntryProjectionCache();
let meterRecord; // runtime.peekSentViewCount() stand-in
const turns = 3;
for (let i = 0; i < turns; i++) {
  const t0 = performance.now();
  const cm = t("  project (EntryProjectionCache)", () => cache.project(entries));
  const cov = collectCoveredMessageIds(state);
  const prelim = estimateTokens(cm, cov);
  let tokenCount = prelim;
  let guardTokens = prelim;
  let usedProbe = false;
  if (state.blocks.some((b) => b.active && b.effectiveMessageIds.length > 0)) {
    const meter = meterRecord;
    if (meter && sentViewMeterMatches(meter, state, config)) {
      if (Math.abs(meter.viewTokens - prelim) > Math.max(1000, 0.1 * prelim)) {
        tokenCount = meter.viewTokens;
        guardTokens = meter.viewTokens;
      }
    } else {
      const view = sentViewTokenCount(core, cm, state, config, tokenCount);
      if (view.drifted) tokenCount = view.viewTokens;
      usedProbe = i === 0; // first turn probes; steady state must not
    }
  }
  const turn = core.processTurn({ messages: cm, state, config, tokenCount });
  const truncateBand = config.modelContextLimit > 0 ? Math.floor(config.truncate.threshold * config.modelContextLimit) : Number.MAX_SAFE_INTEGER;
  meterRecord = {
    viewTokens: estimateTokens(turn.messages, collectCoveredMessageIds(turn.state)) ,
    blocksLen: turn.state.blocks.length,
    activeBlocks: turn.state.blocks.filter((b) => b.active).length,
    limit: config.modelContextLimit,
    usable: tokenCount < truncateBand,
  };
  JSON.stringify(state);
  const total = (performance.now() - t0).toFixed(0);
  console.log(`  turn ${i + 1}: total=${total} ms (outMsgs=${turn.messages.length}, probe=${usedProbe}, meterView=${meterRecord.viewTokens})`);
}
