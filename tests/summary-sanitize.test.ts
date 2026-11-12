import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countUnicodeEscapes,
  decodeUnicodeEscapes,
  findUnverifiableUserQuote,
  sanitizeSummary,
  UNESCAPE_THRESHOLD,
} from "../src/summary-sanitize.js";

// issue #309: small models emit summaries whose CJK text arrives as literal
// \uXXXX runs (double-escaped on the wire). The kernel stores/renders summaries
// verbatim, so the adapter normalizes at ingest. Also detects unverifiable
// user-quote claims (hallucinated phrases stored as fact — the loop amplifier).

test("decodeUnicodeEscapes decodes basic CJK escapes", () => {
  assert.equal(decodeUnicodeEscapes("\\u5408\\u5e76"), "合并");
});

test("decodeUnicodeEscapes decodes surrogate pairs to a single code point", () => {
  assert.equal(decodeUnicodeEscapes("\\ud83d\\ude00"), "\u{1F600}");
});

test("decodeUnicodeEscapes keeps a lone high surrogate as one char (no crash)", () => {
  const out = decodeUnicodeEscapes("\\ud800");
  assert.equal(out.length, 1);
  assert.equal(out.charCodeAt(0), 0xd800);
});

test("decodeUnicodeEscapes leaves non-unicode escapes and invalid hex untouched", () => {
  assert.equal(decodeUnicodeEscapes("a\\nb"), "a\\nb");
  assert.equal(decodeUnicodeEscapes("\\\\x"), "\\\\x");
  assert.equal(decodeUnicodeEscapes("\\uZZZZ"), "\\uZZZZ");
  assert.equal(decodeUnicodeEscapes("\\u12"), "\\u12");
});

test("decodeUnicodeEscapes mixes decoded runs with surrounding text", () => {
  assert.equal(decodeUnicodeEscapes("line1 \\u4f60\\u597d tail"), "line1 你好 tail");
});

test("countUnicodeEscapes counts all literal escape runs", () => {
  assert.equal(countUnicodeEscapes("\\u5408\\u5e76\\u7ee7"), 3);
  assert.equal(countUnicodeEscapes("plain text \\uZZZZ"), 0);
});

test("sanitizeSummary leaves clean summaries untouched", () => {
  const s = sanitizeSummary("合并了 295 继续下一个 rebase (m00012)");
  assert.equal(s.unescaped, false);
  assert.equal(s.text, "合并了 295 继续下一个 rebase (m00012)");
});

test("sanitizeSummary does NOT decode at or below the threshold (legit examples survive)", () => {
  const s = "\\u5408".repeat(UNESCAPE_THRESHOLD);
  const out = sanitizeSummary(s);
  assert.equal(out.unescaped, false);
  assert.equal(out.text, s);
});

test("sanitizeSummary decodes above the threshold (double-escape failure mode)", () => {
  const s = "摘要: " + "\\u5408".repeat(UNESCAPE_THRESHOLD + 1) + " 结束";
  const out = sanitizeSummary(s);
  assert.equal(out.unescaped, true);
  assert.equal(out.text, "摘要: " + "合".repeat(UNESCAPE_THRESHOLD + 1) + " 结束");
  assert.ok(!out.text.includes("\\u5408"));
});

test("findUnverifiableUserQuote flags the incident shape: user quote without ref", () => {
  const flagged = findUnverifiableUserQuote("CURRENT TASK: user '合并了 下一个' = proceed to NEXT open issue");
  assert.ok(flagged !== null);
});

test("findUnverifiableUserQuote flags 'user verbatim' claims without ref", () => {
  const flagged = findUnverifiableUserQuote("user verbatim 'go ahead' captured above");
  assert.ok(flagged !== null);
});

test("findUnverifiableUserQuote passes when a message ref is present", () => {
  assert.equal(findUnverifiableUserQuote("user verbatim 'go ahead' (m00012)"), null);
  assert.equal(findUnverifiableUserQuote("CURRENT TASK: user '合并了' per m00045"), null);
});

test("findUnverifiableUserQuote ignores summaries with no user-quote claim", () => {
  assert.equal(findUnverifiableUserQuote('error "ENOENT: no such file" while reading /tmp/x'), null);
  assert.equal(findUnverifiableUserQuote("merged PR #299, next: #299 open issues remain"), null);
});

test("findUnverifiableUserQuote flags Chinese 原话 claims without ref", () => {
  assert.ok(findUnverifiableUserQuote("用户原话\"合并了\"表示继续") !== null);
});
