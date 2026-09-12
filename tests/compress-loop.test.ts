import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPRESS_LOOP_SENTINEL, COMPRESS_LOOP_CORRECT_THRESHOLD, buildCompressLoopText } from "../src/compress-loop.js";

test("COMPRESS_LOOP_SENTINEL matches the sentinel documented in the system prompt — issue #330", () => {
  assert.equal(COMPRESS_LOOP_SENTINEL, "[ACP:compress-loop]");
});

test("correction threshold fires on 2 failed compress calls within one turn — issue #330", () => {
  assert.equal(COMPRESS_LOOP_CORRECT_THRESHOLD, 2);
});

test("buildCompressLoopText carries the sentinel, the count, and an explicit stop instruction", () => {
  const text = buildCompressLoopText(2);
  assert.ok(text.startsWith(COMPRESS_LOOP_SENTINEL), "sentinel first so system-prompt rules can key off it");
  assert.ok(text.includes("2"), "embeds the failure count");
  assert.match(text, /STOP calling compress/, "explicit stop instruction");
  assert.match(text, /paused until your next user request/, "states when it self-clears");
});
