import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRanges, type CompressArgs } from "../src/compress-tool.js";

// issue #568: every entry-malformation shape below used to collapse into one
// unactionable error; the message must now carry the kernel's per-entry reasons.

test("stringified array whose entries lack summaries: each dropped entry is named (#568)", () => {
  const content = JSON.stringify([
    { startId: "m24583", endId: "m24674" },
    { startId: "m24775", endId: "m24858" },
  ]);
  const out = normalizeRanges({ content });
  assert.equal(typeof out, "string");
  assert.match(out, /no-valid-ranges/);
  assert.match(out, /entry 0: missing summary/);
  assert.match(out, /entry 1: missing summary/);
});

test("stringified array of compact ref-pair strings: line-entry reason surfaced (#568)", () => {
  const content = JSON.stringify([
    "m24583-m24674: summary one",
    "m24775-m24858: summary two",
  ]);
  const out = normalizeRanges({ content });
  assert.equal(typeof out, "string");
  assert.match(out, /2 entries were dropped as invalid/);
  assert.match(out, /line entry: missing summary after the refs header line/);
});

test("wrong field names: bounds reason surfaced (#568)", () => {
  const content = JSON.stringify([{ start: "m00001", end: "m00010", summary: "s" }]);
  const out = normalizeRanges({ content });
  assert.equal(typeof out, "string");
  assert.match(out, /1 entry was dropped as invalid/);
  assert.match(out, /missing range bounds/);
});

test("non-string bounds: reason surfaced (#568)", () => {
  const content = JSON.stringify([{ startId: 24583, endId: 24674, summary: "s" }]);
  const out = normalizeRanges({ content });
  assert.equal(typeof out, "string");
  assert.match(out, /dropped as invalid/);
  assert.match(out, /missing range bounds/);
});

test("clean stringified array still parses (regression guard)", () => {
  const arr = [
    { startId: "m00001", endId: "m00010", summary: "a" },
    { startId: "m00011", endId: "m00020", summary: "b" },
  ];
  const out = normalizeRanges({ content: JSON.stringify(arr) });
  assert.notEqual(typeof out, "string");
  assert.deepEqual(
    out.map((r) => [r.startId, r.endId]),
    [["m00001", "m00010"], ["m00011", "m00020"]],
  );
});

test("non-string content shapes keep their wording (number)", () => {
  const out = normalizeRanges({ content: 42 } as unknown as CompressArgs);
  assert.equal(typeof out, "string");
  assert.match(out, /got a number/);
  assert.match(out, /ARRAY/);
});
