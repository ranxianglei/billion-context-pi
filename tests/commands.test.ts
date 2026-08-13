import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "../src/commands.js";

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const tmpHome = path.join(os.tmpdir(), `acp-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows: os.homedir() reads USERPROFILE, not HOME
  try {
    await fn();
  } finally {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

test("saveConfig merges patch, keeps existing keys, deletes on empty string", async () => {
  await withTempHome(async () => {
    const file = path.join(process.env.HOME!, CONFIG_DIR_NAME, "acp.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ compressModel: "qwen:qwen3-coder", debug: true }));

    await saveConfig({ autoUpdate: false, modelContextLimit: 128000, compressModel: "" });

    const saved = JSON.parse(await fs.readFile(file, "utf-8"));
    assert.deepEqual(saved, { debug: true, autoUpdate: false, modelContextLimit: 128000 });
  });
});

test("saveConfig creates the file when missing", async () => {
  await withTempHome(async () => {
    await saveConfig({ debug: true });
    const file = path.join(process.env.HOME!, CONFIG_DIR_NAME, "acp.json");
    const saved = JSON.parse(await fs.readFile(file, "utf-8"));
    assert.deepEqual(saved, { debug: true });
  });
});

test("saveConfig refuses to clobber corrupt existing config", async () => {
  await withTempHome(async () => {
    const file = path.join(process.env.HOME!, CONFIG_DIR_NAME, "acp.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");

    await assert.rejects(() => saveConfig({ debug: true }), SyntaxError);
    assert.equal(await fs.readFile(file, "utf-8"), "{not json");
  });
});

import { applySetting } from "../src/commands.js";

test("applySetting: usageTriggerPercent accepts 0-100, rejects out of range", () => {
  assert.deepEqual(applySetting("usageTriggerPercent", "50"), { ok: true, patch: { usageTriggerPercent: 50 } });
  assert.deepEqual(applySetting("usageTriggerPercent", "0"), { ok: true, patch: { usageTriggerPercent: 0 } });
  assert.deepEqual(applySetting("usageTriggerPercent", "100"), { ok: true, patch: { usageTriggerPercent: 100 } });
  assert.deepEqual(applySetting("usageTriggerPercent", "-1"), { ok: false });
  assert.deepEqual(applySetting("usageTriggerPercent", "101"), { ok: false });
  assert.deepEqual(applySetting("usageTriggerPercent", "abc"), { ok: false });
});

test("applySetting: toolOutputClean maps on/off to boolean", () => {
  assert.deepEqual(applySetting("toolOutputClean", "on"), { ok: true, patch: { toolOutputClean: true } });
  assert.deepEqual(applySetting("toolOutputClean", "off"), { ok: true, patch: { toolOutputClean: false } });
});

test("applySetting: numeric settings reject non-positive", () => {
  assert.deepEqual(applySetting("modelContextLimit", "128000"), { ok: true, patch: { modelContextLimit: 128000 } });
  assert.deepEqual(applySetting("modelContextLimit", "0"), { ok: false });
  assert.deepEqual(applySetting("toolOutputMaxBytes", "abc"), { ok: false });
});

test("applySetting: language accepts zh/en, clears otherwise", () => {
  assert.deepEqual(applySetting("language", "zh"), { ok: true, patch: { language: "zh" } });
  assert.deepEqual(applySetting("language", "en"), { ok: true, patch: { language: "en" } });
  assert.deepEqual(applySetting("language", "fr"), { ok: true, patch: { language: undefined } });
});

test("applySetting: unknown id rejected, compressModel passthrough", () => {
  assert.deepEqual(applySetting("nope", "x"), { ok: false });
  assert.deepEqual(applySetting("compressModel", "qwen:qwen3-coder"), { ok: true, patch: { compressModel: "qwen:qwen3-coder" } });
});
