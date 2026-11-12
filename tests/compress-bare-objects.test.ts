import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRanges, arrayWrapRepair } from "../src/compress-tool.js";

// issue #480: small models in non-strict tool-call mode emit `content` as a
// string of bare range objects WITHOUT the wrapping array brackets — one
// object or several concatenated (`{...}{...}`). The kernel parser only
// salvages entries from a `[`-anchored array, so the call died with
// "content-not-array ... Unexpected non-whitespace character after JSON at
// position N". The adapter extracts the top-level objects and re-wraps them
// as a proper array before delegating.

// Build the exact #480 signature: first object EXACTLY 297 chars long, second
// concatenated directly after → strict JSON.parse fails with
// "after JSON at position 297".
function buildConcatenatedPayload(): { first: string; payload: string; second: string } {
  const probe = JSON.stringify({ startId: "m00001", endId: "m00040", summary: "pad" });
  const delta = 297 - probe.length;
  const first = JSON.stringify({ startId: "m00001", endId: "m00040", summary: "pad" + "x".repeat(delta) });
  assert.equal(first.length, 297, "precondition: first object spans positions 0..296");
  const second = JSON.stringify({ startId: "m00041", endId: "m00060", summary: "second range summary" });
  const payload = first + second;
  let strictErr: unknown;
  try {
    JSON.parse(payload);
  } catch (e) {
    strictErr = e;
  }
  assert.match(String(strictErr), /after JSON at position 297/, "precondition: mirrors the #480 parse error");
  return { first, second, payload };
}

// ─── unit: arrayWrapRepair (the deterministic repair) ────────────────────────

test("arrayWrapRepair re-wraps concatenated bare objects (the #480 payload)", () => {
  const { first, second, payload } = buildConcatenatedPayload();
  const repaired = arrayWrapRepair(payload);
  assert.ok(repaired !== undefined, "expected a re-wrapped array");
  assert.deepEqual(JSON.parse(repaired!), [JSON.parse(first), JSON.parse(second)]);
});

test("arrayWrapRepair wraps a single clean bare object", () => {
  const obj = { startId: "m00001", endId: "m00010", summary: "s" };
  const repaired = arrayWrapRepair(JSON.stringify(obj));
  assert.deepEqual(JSON.parse(repaired!), [obj]);
});

test("arrayWrapRepair skips trailing garbage after a complete object", () => {
  const obj = { startId: "m00001", endId: "m00010", summary: "s" };
  const repaired = arrayWrapRepair(JSON.stringify(obj) + '"}');
  assert.deepEqual(JSON.parse(repaired!), [obj]);
});

test("arrayWrapRepair skips leading garbage before the first object", () => {
  const obj = { startId: "m00001", endId: "m00010", summary: "s" };
  const repaired = arrayWrapRepair('garbage text ' + JSON.stringify(obj));
  assert.deepEqual(JSON.parse(repaired!), [obj]);
});

test("arrayWrapRepair preserves per-object topic and extra fields", () => {
  const obj = { topic: "Auth", startId: "m00001", endId: "m00010", summary: "s" };
  const repaired = arrayWrapRepair(JSON.stringify(obj));
  assert.deepEqual(JSON.parse(repaired!), [obj]);
});

test("arrayWrapRepair survives braces/quotes/escapes inside summaries", () => {
  const obj = { startId: "m00001", endId: "m00010", summary: 'brace { inside } and "quotes" plus \\ escape' };
  const repaired = arrayWrapRepair(JSON.stringify(obj) + JSON.stringify({ startId: "m00011", endId: "m00020", summary: "next" }));
  const parsed = JSON.parse(repaired!);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].summary, obj.summary);
});

test("arrayWrapRepair keeps valid ranges next to non-range objects", () => {
  const range = { startId: "m00001", endId: "m00010", summary: "s" };
  const wrapper = { content: [{ startId: "m1", endId: "m2", summary: "x" }] };
  const repaired = arrayWrapRepair(JSON.stringify(wrapper) + JSON.stringify(range));
  assert.deepEqual(JSON.parse(repaired!), [range]);
});

test("arrayWrapRepair has no false positives on well-formed / other inputs", () => {
  // Proper array string: `{` sit at depth ≥ 1 → no top-level candidates.
  assert.equal(arrayWrapRepair('[{"startId":"m1","endId":"m2","summary":"x"}]'), undefined);
  // Double-stringified array: one quoted string token, no top-level braces.
  assert.equal(arrayWrapRepair(JSON.stringify('[{"startId":"m1","endId":"m2","summary":"x"}]')), undefined);
  // Whole args nested inside content: top-level object is not range-shaped.
  assert.equal(arrayWrapRepair('{"topic":"X","content":[{"startId":"m1","endId":"m2","summary":"x"}]}'), undefined);
  // Line-form entries (no braces at all).
  assert.equal(arrayWrapRepair("m00001-m00010 topic\nsummary line"), undefined);
  // Pure garbage.
  assert.equal(arrayWrapRepair("not json { at all"), undefined);
  // Unbalanced object (no closing brace) → nothing extracted.
  assert.equal(arrayWrapRepair('{"startId":"m1","endId":"m2","summary":"x"'), undefined);
  // Range missing summary → not range-shaped.
  assert.equal(arrayWrapRepair('{"startId":"m1","endId":"m2"}'), undefined);
});

// ─── unit: normalizeRanges (repair wired in) ─────────────────────────────────

test("normalizeRanges accepts the #480 payload (concatenated objects, position-297 error gone)", () => {
  const { first, payload } = buildConcatenatedPayload();
  const out = normalizeRanges({ content: payload });
  assert.ok(Array.isArray(out), `expected ranges, got error: ${out}`);
  assert.equal(out.length, 2, "both concatenated ranges are recovered");
  assert.deepEqual(out[0], { startId: "m00001", endId: "m00040", summary: JSON.parse(first).summary, topic: undefined });
  assert.deepEqual(out.map((r) => `${r.startId}..${r.endId}`), ["m00001..m00040", "m00041..m00060"]);
});

test("normalizeRanges accepts a single clean bare object", () => {
  const out = normalizeRanges({ content: JSON.stringify({ startId: "m00001", endId: "m00010", summary: "s" }) });
  assert.ok(Array.isArray(out), `expected ranges, got error: ${out}`);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { startId: "m00001", endId: "m00010", summary: "s", topic: undefined });
});

test("normalizeRanges applies the top-level topic to re-wrapped ranges", () => {
  const out = normalizeRanges({ topic: "Auth", content: JSON.stringify({ startId: "m00001", endId: "m00005", summary: "s" }) });
  assert.ok(Array.isArray(out));
  assert.equal(out[0].topic, "Auth");
});

test("normalizeRanges still reports an error for pure garbage (unchanged path)", () => {
  const out = normalizeRanges({ content: "not json {" });
  assert.equal(typeof out, "string");
  assert.match(out, /must be an ARRAY/);
});

test("normalizeRanges still reports the parser diagnostic for array-shaped defects (regression)", () => {
  const broken = '[{"startId": "m1", "endId": "m2", "summary": "unterminated';
  const out = normalizeRanges({ content: broken });
  assert.equal(typeof out, "string");
  assert.match(out, /failed to parse/);
  assert.doesNotMatch(out, /must be an ARRAY/);
});
