import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionBlock } from "acp-kernel";
import { usageAnchorPredatesCompression, compressionAnchorStaleness } from "../src/floor-stale.js";

// The issue #257 floor must be skipped while the host's provider-usage anchor
// (the usage on the last valid assistant message) predates the last
// successful compress toolResult — right after a compress the anchor still
// reflects the pre-compress (larger) request.

const USAGE = { input: 175_000, cacheRead: 0, cacheWrite: 0 };
const PANEL_OK = "▣ ACP | 42.3K → 18.9K tokens (~23.4K reclaimed, 3 blocks)";
const PANEL_NOOP = "▣ ACP | 42.3K → 42.3K tokens (~0 reclaimed, 0 blocks)";

const msg = (id: string, message: Record<string, unknown>) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { timestamp: Date.now(), ...message },
});

const assistantUsage = (id: string, over: Record<string, unknown> = {}) =>
  msg(id, { role: "assistant", content: "ok", usage: USAGE, ...over });

const compressResult = (id: string, text: string, over: Record<string, unknown> = {}) =>
  msg(id, { role: "toolResult", toolName: "compress", toolCallId: "c1", content: [{ type: "text", text }], ...over });

test("fresh anchor: usage after the compress is not stale", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK),
    assistantUsage("e3"), // post-compress assistant carries fresh usage
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("stale anchor: successful compress after the last usage", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK),
    msg("e3", { role: "assistant", content: "continuing" }), // no usage field
  ];
  assert.equal(usageAnchorPredatesCompression(entries), true);
});

test("no compress at all is never stale", () => {
  const entries = [msg("e0", { role: "user", content: "go" }), assistantUsage("e1")];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("failed compress does not invalidate the anchor", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", "Error: Range not found", { isError: true }),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("noop compress (0-block panel) does not invalidate the anchor", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_NOOP),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("error / aborted / zero-usage assistants are not anchors", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1", { stopReason: "error" }),
    assistantUsage("e2", { stopReason: "aborted" }),
    assistantUsage("e3", { usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
    compressResult("e4", PANEL_OK),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), true);
});

test("usage via totalTokens alone counts as an anchor", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    msg("e1", { role: "assistant", content: "ok", usage: { totalTokens: 90_000 } }),
    compressResult("e2", PANEL_OK),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), true);
});

test("non-compress toolResults are ignored", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    msg("e2", { role: "toolResult", toolName: "read", toolCallId: "c9", content: [{ type: "text", text: PANEL_OK }] }),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

// issue #325: compressionAnchorStaleness attributes reclamation to blocks whose
// creating compress toolResult lands after the last valid usage anchor, so the
// caller can floor at (anchor − netReclaimed) instead of skipping the floor.
const ct = (t: string): number => t.length;
const blk = (over: Partial<CompressionBlock> = {}): CompressionBlock => ({
  blockId: "b0", runId: "r", tier: 1, summary: "abcde", directMessageIds: [], effectiveMessageIds: [],
  directBlockIds: [], compressedTokens: 1000, createdAt: Date.now(), survivedCount: 0, generation: "young", active: true, ...over,
});

test("staleness: fresh anchor → not predates, nothing reclaimed", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK),
    assistantUsage("e3"),
  ];
  const r = compressionAnchorStaleness(entries, [blk()], ct);
  assert.equal(r.predates, false);
  assert.equal(r.netReclaimed, 0);
});

test("staleness: stale anchor reclaims a post-anchor block", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK), // toolCallId c1
  ];
  const r = compressionAnchorStaleness(entries, [blk({ compressCallId: "c1" })], ct);
  assert.equal(r.predates, true);
  assert.equal(r.netReclaimed, 995); // 1000 − len("abcde")
});

test("staleness: pre-anchor block is not counted as reclaimed", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    compressResult("e1", PANEL_OK), // c1 before any usage anchor
    assistantUsage("e2"),
  ];
  const r = compressionAnchorStaleness(entries, [blk({ compressCallId: "c1" })], ct);
  assert.equal(r.predates, false);
  assert.equal(r.netReclaimed, 0);
});

test("staleness: inactive and unattributable blocks are skipped", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK), // c1
  ];
  const r = compressionAnchorStaleness(entries, [
    blk({ compressCallId: "c1", active: false }),
    blk({ blockId: "b1", compressCallId: undefined }),
  ], ct);
  assert.equal(r.predates, true);
  assert.equal(r.netReclaimed, 0);
});

test("staleness: negative savings clamp to zero", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK), // c1
  ];
  const r = compressionAnchorStaleness(entries, [blk({ compressCallId: "c1", compressedTokens: 3 })], ct);
  assert.equal(r.predates, true);
  assert.equal(r.netReclaimed, 0); // 3 − 5 < 0 → clamped
});

test("staleness: sums multiple post-anchor blocks", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK), // c1
    msg("e3", { role: "toolResult", toolName: "compress", toolCallId: "c2", content: [{ type: "text", text: PANEL_OK }] }),
  ];
  const r = compressionAnchorStaleness(entries, [
    blk({ compressCallId: "c1", compressedTokens: 1000 }), // 995
    blk({ blockId: "b1", compressCallId: "c2", compressedTokens: 2000 }), // 1995
  ], ct);
  assert.equal(r.predates, true);
  assert.equal(r.netReclaimed, 2990);
});
