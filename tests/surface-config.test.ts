import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPrompts } from "acp-kernel";
import { buildAcpSystemPrompt, ACP_DELEGATE_PROMPT, sanitizePromptSections } from "../src/system-prompt.js";
import { sanitizeToolPrompts, sanitizeNudgeSections, applyToolPromptOverrides, readToolSurfaceSync, sanitizeSurfaceConfig } from "../src/surface.js";
import { loadUserConfig } from "../src/user-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("default system prompt is byte-identical to the recorded fixture", async () => {
  const fixture = await import("node:fs/promises").then((fs) => fs.readFile(path.join(here, "fixtures/pi-system-prompt-default.txt"), "utf8"));
  assert.equal(buildAcpSystemPrompt(defaultPrompts), fixture);
});

test("default delegate appendix is byte-identical to the recorded fixture", async () => {
  const fixture = await import("node:fs/promises").then((fs) => fs.readFile(path.join(here, "fixtures/pi-delegate-prompt-default.txt"), "utf8"));
  assert.equal(ACP_DELEGATE_PROMPT, fixture);
});

test("promptSections: string replaces, null removes, unknown keys ignored", () => {
  const base = buildAcpSystemPrompt(defaultPrompts);
  const replaced = buildAcpSystemPrompt(defaultPrompts, { acpTags: "CUSTOM TAGS HEADER" });
  assert.ok(replaced.includes("CUSTOM TAGS HEADER"));
  assert.ok(!replaced.includes("ACP TAGS"));
  const removed = buildAcpSystemPrompt(defaultPrompts, { acpTags: null });
  assert.ok(!removed.includes("ACP TAGS"));
  assert.ok(removed.includes("WHEN TO COMPRESS"));
  const ignored = buildAcpSystemPrompt(defaultPrompts, { bogusKey: "x", acpTags: 42 as unknown as null });
  assert.equal(ignored, base);
});

test("promptSections: null on a contract-locked rule slot is dropped cleanly", () => {
  const withNullRule = sanitizePromptSections({ compressPhilosophy: null });
  assert.deepEqual(withNullRule, {});
});

test("sanitizeNudgeSections keeps 4 known keys with string|null, drops the rest", () => {
  assert.deepEqual(sanitizeNudgeSections({ efficiencyNote: "hi", emergencyHeader: null, t2Guidance: 7, bogus: "x" }), { efficiencyNote: "hi", emergencyHeader: null });
  assert.deepEqual(sanitizeNudgeSections("junk"), {});
});

test("sanitizeToolPrompts filters unknown tools and malformed fields", () => {
  const out = sanitizeToolPrompts({
    compress: { description: "d", promptGuidelines: "single", paramDescriptions: { startId: "s", endId: 3 }, promptSnippet: 9 },
    bash: { description: "nope" },
    decompress: { promptGuidelines: ["ok", 5] },
    search_context: {},
    acp_status: { promptSnippet: "snip" },
  });
  assert.deepEqual(out, {
    compress: { description: "d", promptGuidelines: "single", paramDescriptions: { startId: "s" } },
    acp_status: { promptSnippet: "snip" },
  });
});

test("applyToolPromptOverrides rewrites tool text and param descriptions, leaves the rest", () => {
  const params = { type: "object", properties: { startId: { type: "string", description: "old" }, endId: { type: "string" } }, required: ["startId"] } as never;
  const def = { name: "compress", label: "Compress", description: "d", promptSnippet: "ps", promptGuidelines: ["g"], parameters: params, execute: (async () => ({})) as never };
  const out = applyToolPromptOverrides(def, { description: "nd", promptGuidelines: ["a", "b"], paramDescriptions: { endId: "new-end" } });
  assert.equal(out.name, "compress");
  assert.equal(out.description, "nd");
  assert.deepEqual(out.promptGuidelines, ["a", "b"]);
  assert.equal(out.parameters.properties.startId.description, "old");
  assert.equal(out.parameters.properties.endId.description, "new-end");
  const untouched = applyToolPromptOverrides(def);
  assert.equal(untouched.parameters, params);
});

test("readToolSurfaceSync picks up project .pi/acp.json (global ignored when absent there)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-surface-"));
  try {
    await mkdir(path.join(dir, ".pi"), { recursive: true });
    await writeFile(path.join(dir, ".pi/acp.json"), JSON.stringify({ toolPrompts: { compress: { promptSnippet: "local-snip" } } }), "utf8");
    const out = readToolSurfaceSync(dir);
    assert.deepEqual(out, { compress: { promptSnippet: "local-snip" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sanitizeSurfaceConfig sanitizes all four surface fields", () => {
  const out = sanitizeSurfaceConfig({
    promptSections: { acpTags: "ok", bogus: "drop" },
    nudgeSections: { efficiencyNote: null, t2Guidance: "t", bogus: 1 },
    toolPrompts: { compress: { description: "d" }, bogus: {} },
    delegatePrompt: 42,
  });
  assert.deepEqual(out.promptSections, { acpTags: "ok" });
  assert.deepEqual(out.nudgeSections, { efficiencyNote: null, t2Guidance: "t" });
  assert.deepEqual(out.toolPrompts, { compress: { description: "d" } });
  assert.equal(out.delegatePrompt, undefined);
});

test("loadUserConfig picks up the four new keys from project acp.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-usercfg-"));
  try {
    await mkdir(path.join(dir, ".pi"), { recursive: true });
    await writeFile(
      path.join(dir, ".pi/acp.json"),
      JSON.stringify({ promptSections: { acpTags: "P" }, nudgeSections: { emergencyHeader: null }, toolPrompts: { acp_status: { promptSnippet: "S" } }, delegatePrompt: "D" }),
      "utf8",
    );
    const cfg = await loadUserConfig(dir);
    assert.deepEqual(cfg.promptSections, { acpTags: "P" });
    assert.deepEqual(cfg.nudgeSections, { emergencyHeader: null });
    assert.deepEqual(cfg.toolPrompts, { acp_status: { promptSnippet: "S" } });
    assert.equal(cfg.delegatePrompt, "D");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
