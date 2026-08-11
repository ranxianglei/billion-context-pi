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
  process.env.HOME = tmpHome;
  try {
    await fn();
  } finally {
    process.env.HOME = savedHome;
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
