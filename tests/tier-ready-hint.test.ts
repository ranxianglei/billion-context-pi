import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, type CompressionBlock, type CompressionState } from "acp-kernel";
import { tierReadyHint } from "../src/compress-tool.js";

// acp-kernel#379 / billion-context#1249: block COUNT is not a need signal.
// Count-triggered tier distillation defaults OFF in the kernel
// (tier2Trigger 1000 / tier3Trigger 2000), so the rewrite-guard recovery
// hint must stay silent for hand-fulls of summary blocks — hinting otherwise
// sends the model into distillations that reclaim nothing while rewriting
// the wire from the fold anchor onward (prefix-cache loss).

function block(id: string, tier: 1 | 2): CompressionBlock {
    return {
        blockId: id, runId: 0, tier, generation: "young", active: true,
        summary: `summary ${id}`, directMessageIds: [], effectiveMessageIds: [],
        directBlockIds: [], compressedTokens: 100, createdAt: 0, survivedCount: 0,
    };
}

function stateWith(blocks: CompressionBlock[]): CompressionState {
    return {
        blocks, messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {},
        nudge: { lastPerMessageNudgeTokens: 0, lastNudgeShownTokens: 0, baselineTokens: 0, anchors: {}, lastShownByTier: {} },
        stats: { tokensCompressed: 0, compressionCount: 0 }, nextBlockId: blocks.length + 1, nextRunId: 1,
    } as CompressionState;
}

test("kernel defaults: count-triggered distillation is default-off (#379)", () => {
    const config = defaultConfig(200_000);
    assert.equal(config.tiers.tier2Trigger, 1000);
    assert.equal(config.tiers.tier3Trigger, 2000);
});

test("tierReadyHint stays silent for summary-block handfuls under default config (#379/#1249)", () => {
    const config = defaultConfig(200_000);
    const fiveT1 = ["b1", "b2", "b3", "b4", "b5"].map((id) => block(id, 1));
    assert.equal(tierReadyHint(stateWith(fiveT1), config), "", "5 tier-1 blocks must not read as actionable under default triggers");
    const nineT2 = Array.from({ length: 9 }, (_, i) => block(`b${i + 1}`, 2));
    assert.equal(tierReadyHint(stateWith(nineT2), config), "", "9 tier-2 blocks must not read as actionable under default triggers");
});

test("tierReadyHint still fires when triggers are explicitly configured low", () => {
    const config = defaultConfig(200_000, { tiers: { enabled: true, tier2Trigger: 3, tier3Trigger: 6 } });
    const t1 = ["b1", "b2", "b3", "b4"].map((id) => block(id, 1));
    assert.match(tierReadyHint(stateWith(t1), config), /distill tier-1 blocks b1\.\.b4/);
    const t2 = Array.from({ length: 6 }, (_, i) => block(`b${i + 1}`, 2));
    assert.match(tierReadyHint(stateWith(t2), config), /condense tier-2 blocks b1\.\.b6/);
});
