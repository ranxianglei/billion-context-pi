import { test } from "node:test";
import assert from "node:assert/strict";
import { sentViewMeterMatches, type SentViewMeterRecord } from "../src/tokens.js";
import type { CompressionState } from "acp-kernel";
import { defaultConfig } from "acp-kernel";

function stateOf(blocks: { active: boolean }[]): CompressionState {
  // Minimal structural stand-in: sentViewMeterMatches only reads blocks[].active.
  return { blocks } as unknown as CompressionState;
}

function meter(over: Partial<SentViewMeterRecord>): SentViewMeterRecord {
  return { viewTokens: 100_000, blocksLen: 2, activeBlocks: 1, limit: 868_928, usable: true, ...over };
}

const config = { ...defaultConfig(), modelContextLimit: 868_928 };

test("no meter, or unusable meter, never matches", () => {
  assert.equal(sentViewMeterMatches(undefined, stateOf([{ active: true }, { active: false }]), config), false);
  assert.equal(sentViewMeterMatches(meter({ usable: false }), stateOf([{ active: true }, { active: false }]), config), false);
});

test("matching signature adopts the previous view", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ active: true }, { active: false }]), config), true);
});

test("window re-centering (limit change) forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ active: true }, { active: false }]), { ...config, modelContextLimit: 150_000 }), false);
});

test("block count change (compress/decompress) forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ active: true }]), config), false);
  assert.equal(sentViewMeterMatches(meter({}), stateOf([{ active: true }, { active: false }, { active: true }]), config), false);
});

test("active-count change (sync/absorb) forces a resync", () => {
  assert.equal(sentViewMeterMatches(meter({ activeBlocks: 2 }), stateOf([{ active: true }, { active: true }]), config), true);
  assert.equal(sentViewMeterMatches(meter({ activeBlocks: 1 }), stateOf([{ active: true }, { active: true }]), config), false);
});
