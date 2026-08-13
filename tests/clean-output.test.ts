import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanToolText, cleanToolContent } from "../src/clean-output.js";

test("dedupes globally repeated non-code lines (npm allow-scripts alternating block)", () => {
  const input = [
    "npm warn allow-scripts   @google/genai@1.52.0 (preinstall: echo 'preinstall: no-op')",
    "npm warn allow-scripts   protobufjs@7.6.5 (postinstall: node scripts/postinstall)",
    "npm warn allow-scripts   @google/genai@1.52.0 (preinstall: echo 'preinstall: no-op')",
    "npm warn allow-scripts   protobufjs@7.6.5 (postinstall: node scripts/postinstall)",
  ].join("\n");
  const out = cleanToolText(input);
  assert.equal(
    out,
    [
      "npm warn allow-scripts   @google/genai@1.52.0 (preinstall: echo 'preinstall: no-op') (×2)",
      "npm warn allow-scripts   protobufjs@7.6.5 (postinstall: node scripts/postinstall) (×2)",
    ].join("\n"),
  );
});

test("dedupes three+ consecutive identical lines into one tagged line", () => {
  const out = cleanToolText("=== checkpoint ===\n=== checkpoint ===\n=== checkpoint ===\n=== checkpoint ===\n");
  assert.equal(out, "=== checkpoint === (×4)\n");
});

test("never touches indented lines (source code reads are immune)", () => {
  const input = [
    "function a() {",
    "  return 1;",
    "  return 1;",
    "  return 1;",
    "}",
    "function b() {",
    "  return 1;",
    "}",
  ].join("\n");
  const out = cleanToolText(input);
  assert.equal(out, input, "indented code lines must pass through untouched");
});

test("never touches code-anchor lines (closing braces, statements)", () => {
  const input = "}\n}\n}\nimport x from \"y\";\n";
  assert.equal(cleanToolText(input), "}\n}\n}\nimport x from \"y\";\n");
});

test("dedupes top-level non-code lines even when separated by code-shaped lines", () => {
  const input = [
    "Processing file A",
    "  const x = 1;",
    "Processing file A",
    "Processing file A",
  ].join("\n");
  const out = cleanToolText(input);
  assert.equal(out, "Processing file A (×3)\n  const x = 1;");
});

test("collapses \r progress-bar frames to the final frame", () => {
  const input = "Downloading 10%\rDownloading 50%\rDownloading 100%\nDone";
  const out = cleanToolText(input);
  assert.equal(out, "Downloading 100%\nDone");
});

test("collapses runs of ≥2 blank lines into one", () => {
  const input = "a\n\n\n\nb";
  assert.equal(cleanToolText(input), "a\n\nb");
});

test("handles empty and single-line input unchanged", () => {
  assert.equal(cleanToolText(""), "");
  assert.equal(cleanToolText("just one line"), "just one line");
});

test("keeps order of remaining lines", () => {
  const input = "first\nsecond\nfirst\nthird\nsecond\n";
  const out = cleanToolText(input);
  assert.equal(out, "first (×2)\nsecond (×2)\nthird\n");
});

test("cleanToolContent returns undefined when nothing changed", () => {
  const content = [{ type: "text", text: "unique line\nindented  x\n}" }];
  assert.equal(cleanToolContent(content), undefined);
});

test("cleanToolContent rewrites text parts and preserves non-text parts", () => {
  const content = [
    { type: "image", source: { media_type: "image/png", data: "AAAA" } },
    { type: "text", text: "same\nsame\nother" },
  ];
  const out = cleanToolContent(content);
  assert.ok(out, "should return cleaned content");
  assert.equal(out![0].type, "image", "image part survives");
  assert.equal((out![1] as { text: string }).text, "same (×2)\nother");
});