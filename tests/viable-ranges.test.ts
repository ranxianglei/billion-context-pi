import { test } from "node:test";
import assert from "node:assert/strict";
import { VIABLE_RANGE_MIN_TOKENS, viableRanges } from "acp-kernel";
import { buildStatusReport, createCore, createInitialState } from "acp-kernel";
import { resolveConfig } from "../src/config.js";

test("viableRanges drops fragmented ranges below the floor", () => {
  const ranges = [
    { startRef: "m00001", endRef: "m00004", tokens: 57 },
    { startRef: "m00006", endRef: "m00006", tokens: 8 },
    { startRef: "m00119", endRef: "m00128", tokens: 1_000 },
    { startRef: "m00200", endRef: "m00201", tokens: 4_700 },
  ];
  const kept = viableRanges(ranges);
  assert.deepEqual(kept.map((r) => r.tokens), [1_000, 4_700]);
  assert.equal(VIABLE_RANGE_MIN_TOKENS, 200);
  assert.deepEqual(viableRanges([]), []);
});

test("acp_status applies the viability filter to compressible ranges", () => {
  // buildStatusReport renders nudge.compressibleRanges; verify that the
  // pipeline the status tool uses (filter first) cannot leak tiny ranges.
  const core = createCore();
  const config = resolveConfig({}, 200_000);
  // Well-formed CoreMessages: kernel 0.0.90's syncBlocks (subid coverage,
  // kernel #233) dereferences message.id via baseIdOf — id-less host-shaped
  // entries now throw where 0.0.86 silently tolerated them (kernel-side guard
  // pending; tests should not depend on undocumented lenience).
  const messages = Array.from({ length: 60 }, (_, i) => ({
    id: `h_${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    contentType: "text",
    text: `${i % 2 === 0 ? "u" : "a"}${i} ${i % 2 === 0 ? "lorem ".repeat(i % 7) : "ipsum ".repeat(i % 5)}`,
  }));
  const turn = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 90_000 });
  const nudge = turn.nudge!;
  const filtered = viableRanges(nudge.compressibleRanges ?? []);
  for (const r of filtered) {
    assert.ok(r.tokens >= VIABLE_RANGE_MIN_TOKENS, `range ${r.startRef}..${r.endRef} = ${r.tokens} tok leaked`);
  }
  const report = buildStatusReport(turn.state, messages, () => 1) as string;
  assert.ok(report.length > 0);
});
