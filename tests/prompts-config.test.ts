import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolvePrompts, defaultPrompts } from "acp-kernel";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";
import { loadUserConfig, applyUserConfig } from "../src/user-config.js";
import type { AdapterConfig } from "../src/config.js";

const CONFIG_DIR_NAME = ".pi";

test("buildAcpSystemPrompt with defaults contains the philosophy and tier rules", () => {
  const prompt = buildAcpSystemPrompt(defaultPrompts);
  assert.ok(prompt.includes("ACP context management"), "has header");
  assert.ok(prompt.includes(defaultPrompts.compressPhilosophy.slice(0, 40)), "embeds compressPhilosophy");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules.slice(0, 40)), "embeds howToCompressRules");
  assert.ok(prompt.includes(defaultPrompts.tier2DistillRules.slice(0, 40)), "embeds tier2DistillRules");
  assert.ok(prompt.includes(defaultPrompts.tier3CondenseRules.slice(0, 40)), "embeds tier3CondenseRules");
});

test("buildAcpSystemPrompt reflects acknowledged custom prompts", () => {
  const custom = resolvePrompts(
    { compressPhilosophy: "CUSTOM-PHILOSOPHY-MARKER" },
    { acknowledgeRisk: true },
  );
  const prompt = buildAcpSystemPrompt(custom);
  assert.ok(prompt.includes("CUSTOM-PHILOSOPHY-MARKER"), "custom philosophy present");
  assert.ok(!prompt.includes(defaultPrompts.compressPhilosophy.slice(0, 40)), "default philosophy replaced");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules.slice(0, 40)), "unoverridden fields keep defaults");
});

test("resolvePrompts throws on override without acknowledgeRisk", () => {
  assert.throws(
    () => resolvePrompts({ compressPhilosophy: "x" }),
    /acknowledgeRisk/,
    "ungated override must throw",
  );
});

test("resolvePrompts with empty overrides is a no-op (no gate needed)", () => {
  const resolved = resolvePrompts({});
  assert.equal(resolved.compressPhilosophy, defaultPrompts.compressPhilosophy);
});

test("loadUserConfig picks up prompts and acknowledgePromptsRisk keys", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-prompts-${Date.now()}`);
  const cfgDir = path.join(tmpDir, CONFIG_DIR_NAME);
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, "acp.json"),
    JSON.stringify({ prompts: { compressPhilosophy: "X" }, acknowledgePromptsRisk: true }),
    "utf8",
  );
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.acknowledgePromptsRisk, true, "acknowledgePromptsRisk loaded");
    assert.deepEqual(config.prompts, { compressPhilosophy: "X" }, "prompts loaded");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("applyUserConfig flows prompts through to the adapter", () => {
  const adapter: AdapterConfig = { modelContextLimit: 200_000 };
  const user = { prompts: { tier3CondenseRules: "Y" }, acknowledgePromptsRisk: true };
  const result = applyUserConfig(adapter, user);
  assert.deepEqual(result.prompts, { tier3CondenseRules: "Y" }, "prompts merged");
  assert.equal(result.acknowledgePromptsRisk, true, "ack flag merged");
  assert.equal(result.modelContextLimit, 200_000, "other fields preserved");
});

test("buildAcpSystemPrompt default output is byte-stable (no trailing whitespace, full rules embedded)", () => {
  const prompt = buildAcpSystemPrompt(defaultPrompts);
  assert.ok(
    prompt.endsWith("Compressing becomes available again on the next user message.\n"),
    "ends exactly like the master const — const->function refactor must not add trailing whitespace",
  );
  assert.equal(
    /\s$/.test(prompt.replace(/\n$/, "")),
    false,
    "no trailing whitespace before the final newline",
  );
  assert.ok(prompt.includes("[ACP:compress-loop]"), "compress-loop guard sentinel is documented");
  assert.ok(prompt.includes(defaultPrompts.compressPhilosophy), "full compressPhilosophy embedded verbatim");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules), "full howToCompressRules embedded verbatim");
  assert.ok(prompt.includes(defaultPrompts.tier2DistillRules), "full tier2DistillRules embedded verbatim");
  assert.ok(prompt.includes(defaultPrompts.tier3CondenseRules), "full tier3CondenseRules embedded verbatim");
});
