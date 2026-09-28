import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadUserConfig, applyUserConfig } from "../src/user-config.js";
import type { AdapterConfig } from "../src/config.js";

const CONFIG_DIR_NAME = ".pi";

async function writeConfig(dir: string, data: object): Promise<string> {
  const dirPath = path.join(dir, CONFIG_DIR_NAME);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, "acp.json");
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  return filePath;
}

/** Write to the new canonical (agent-dir) location: <base>/.pi/agent/acp.json. */
async function writeFreshConfig(base: string, data: object): Promise<string> {
  const dirPath = path.join(base, CONFIG_DIR_NAME, "agent");
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, "acp.json");
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  return filePath;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

type HomeEnv = { HOME: string | undefined; USERPROFILE: string | undefined; PI_CODING_AGENT_DIR: string | undefined };

function snapshotHome(): HomeEnv {
  return { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
}

function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // getAgentDir() honors this override; a stale value would redirect fresh-path resolution out of the faked home.
  delete process.env.PI_CODING_AGENT_DIR;
}

function restoreHome(env: HomeEnv): void {
  process.env.HOME = env.HOME;
  process.env.USERPROFILE = env.USERPROFILE;
  if (env.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
}

let savedHome: HomeEnv;
let hookHome: string;

before(async () => {
  savedHome = snapshotHome();
  hookHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-home-"));
  setHome(hookHome);
});

after(async () => {
  restoreHome(savedHome);
  await fs.rm(hookHome, { recursive: true, force: true });
});

test("loadUserConfig returns empty object when no config files exist", async () => {
  const cwd = path.join(os.tmpdir(), `acp-test-${Date.now()}`);
  await fs.mkdir(cwd, { recursive: true });
  const config = await loadUserConfig(cwd);
  assert.deepEqual(config, {});
  await fs.rm(cwd, { recursive: true, force: true });
});

test("loadUserConfig reads global config from home directory", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeConfig(tmpHome, { debug: true, autoUpdate: false });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, true);
    assert.equal(config.autoUpdate, false);
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig reads project config from cwd", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-project-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { modelContextLimit: 100_000, delegate: false });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.modelContextLimit, 100_000);
    assert.equal(config.delegate, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig project config overrides global config", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-override-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-override-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeConfig(tmpHome, { debug: true, modelContextLimit: 200_000 });
    await writeConfig(tmpCwd, { debug: false });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, false, "project debug overrides global");
    assert.equal(config.modelContextLimit, 200_000, "global modelContextLimit preserved");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig reads outputHeadroomMaxPct (ratio and percent string)", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-headroom-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { outputHeadroomMaxPct: "15%" });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.outputHeadroomMaxPct, "15%", "percent string kept verbatim for parsePercent");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig reads hostSession (object form survives pickKnown)", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-hostsession-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { hostSession: { countCustomMessages: true }, unknownKey: "nope" });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.deepEqual(config.hostSession, { countCustomMessages: true }, "hostSession is a known key");
    assert.equal((config as Record<string, unknown>).unknownKey, undefined, "unknown keys still filtered");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig reads rules (boolean survives pickKnown)", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-rules-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { rules: true, unknownKey: "nope" });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.rules, true, "rules is a known key");
    assert.equal((config as Record<string, unknown>).unknownKey, undefined, "unknown keys still filtered");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig ignores unknown keys", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-unknown-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await writeConfig(tmpDir, { debug: true, unknownKey: "should be ignored", anotherUnknown: 123 });
  try {
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.debug, true);
    assert.equal((config as Record<string, unknown>).unknownKey, undefined, "unknown keys filtered");
    assert.equal((config as Record<string, unknown>).anotherUnknown, undefined, "unknown keys filtered");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig handles bad JSON gracefully", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-badjson-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const cfgDir = path.join(tmpDir, CONFIG_DIR_NAME);
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(path.join(cfgDir, "acp.json"), "{ bad json }", "utf8");
  try {
    const config = await loadUserConfig(tmpDir);
    assert.deepEqual(config, {}, "bad JSON returns empty config");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig reads global config from agent dir (new location)", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-agentdir-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-agentdir-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeFreshConfig(tmpHome, { debug: true });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, true, "global config read from ~/.pi/agent/acp.json");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig reads project config from .pi/agent (new location)", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-project-agent-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await writeFreshConfig(tmpDir, { modelContextLimit: 12345 });
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.modelContextLimit, 12345, "project config read from <cwd>/.pi/agent/acp.json");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig reads legacy global config (backward compatibility)", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-legacy-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-legacy-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeConfig(tmpHome, { debug: true, autoUpdate: false });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, true, "legacy global config still read");
    assert.equal(config.autoUpdate, false);
    // No files are written: the legacy file is left in place and no new file is
    // auto-created (moving to the new location is a manual step).
    const legacy = path.join(tmpHome, CONFIG_DIR_NAME, "acp.json");
    assert.ok(await fileExists(legacy), "legacy file untouched");
    const fresh = path.join(tmpHome, CONFIG_DIR_NAME, "agent", "acp.json");
    assert.ok(!(await fileExists(fresh)), "no file auto-created at the new location");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig prefers new location over legacy when both exist", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-prec-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-prec-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeConfig(tmpHome, { debug: true });
    await writeFreshConfig(tmpHome, { debug: false });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, false, "new global location wins over legacy");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig project (new) overrides global (new) per-field", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-prec2-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-prec2-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    await writeFreshConfig(tmpHome, { debug: true, modelContextLimit: 200_000 });
    await writeFreshConfig(tmpCwd, { debug: false });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, false, "project (new) debug overrides global (new)");
    assert.equal(config.modelContextLimit, 200_000, "global (new) modelContextLimit preserved");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig falls back to legacy when fresh global is corrupt", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-corrupt-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-corrupt-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    const freshDir = path.join(tmpHome, CONFIG_DIR_NAME, "agent");
    await fs.mkdir(freshDir, { recursive: true });
    await fs.writeFile(path.join(freshDir, "acp.json"), "{ bad json cut off mid-edit", "utf8");
    await writeConfig(tmpHome, { debug: true });
    const config = await loadUserConfig(tmpCwd);
    assert.equal(config.debug, true, "corrupt fresh copy must not shadow the working legacy file");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("loadUserConfig falls back to legacy when fresh project is corrupt", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-corrupt-proj-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const freshDir = path.join(tmpDir, CONFIG_DIR_NAME, "agent");
    await fs.mkdir(freshDir, { recursive: true });
    await fs.writeFile(path.join(freshDir, "acp.json"), "{ bad json cut off mid-edit", "utf8");
    await writeConfig(tmpDir, { modelContextLimit: 42 });
    const config = await loadUserConfig(tmpDir);
    assert.equal(config.modelContextLimit, 42, "corrupt fresh project copy falls back to legacy project file");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadUserConfig handles invalid legacy global JSON gracefully", async () => {
  const tmpCwd = path.join(os.tmpdir(), `acp-test-global-badjson-cwd-${Date.now()}`);
  const tmpHome = path.join(os.tmpdir(), `acp-test-global-badjson-home-${Date.now()}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpHome, { recursive: true });
  const savedHome = snapshotHome();
  setHome(tmpHome);
  try {
    const piDir = path.join(tmpHome, CONFIG_DIR_NAME);
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(path.join(piDir, "acp.json"), "{ bad json }", "utf8");
    const config = await loadUserConfig(tmpCwd);
    assert.deepEqual(config, {}, "invalid legacy global JSON yields empty config");
  } finally {
    restoreHome(savedHome);
    await fs.rm(tmpCwd, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("applyUserConfig merges user config onto adapter config", () => {
  const adapter: AdapterConfig = {
    modelContextLimit: 200_000,
    delegate: true,
    autoUpdate: true,
    preserveRecentMessages: 5000,
  };
  const user = { debug: true, autoUpdate: false, toolOutputMaxBytes: 50000 };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.debug, true, "user debug applied");
  assert.equal(result.autoUpdate, false, "user autoUpdate overrides adapter");
  assert.equal(result.toolOutputMaxBytes, 50000, "user toolOutputMaxBytes added");
  assert.equal(result.modelContextLimit, 200_000, "adapter modelContextLimit preserved");
  assert.equal(result.delegate, true, "adapter delegate preserved");
});

test("applyUserConfig preserves protected adapter fields", () => {
  const adapter: AdapterConfig = {
    modelContextLimit: 200_000,
    delegate: true,
    preserveRecentMessages: 5000,
    coreOverrides: { someKey: "someValue" },
    protectedTools: ["read", "write"],
  };
  const user = { modelContextLimit: 100_000 };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.modelContextLimit, 100_000, "user modelContextLimit overrides");
  assert.deepEqual(result.coreOverrides, { someKey: "someValue" }, "coreOverrides preserved");
  assert.deepEqual(result.protectedTools, ["read", "write"], "protectedTools preserved");
  assert.equal(result.preserveRecentMessages, 5000, "preserveRecentMessages preserved");
});

test("applyUserConfig with empty user config returns adapter unchanged", () => {
  const adapter: AdapterConfig = {
    modelContextLimit: 200_000,
    delegate: true,
    preserveRecentMessages: 5000,
  };
  const result = applyUserConfig(adapter, {});
  assert.equal(result.modelContextLimit, 200_000);
  assert.equal(result.delegate, true);
  assert.equal(result.preserveRecentMessages, 5000);
});

test("applyUserConfig supports all user config keys", () => {
  const adapter: AdapterConfig = { modelContextLimit: 200_000 };
  const user = {
    debug: true,
    autoUpdate: false,
    modelContextLimit: 50_000,
    delegate: false,
    toolBashDefaultTimeout: 120,
    toolOutputMaxBytes: 100_000,
    outputHeadroomMaxPct: 0.1,
    rules: true,
  };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.debug, true);
  assert.equal(result.autoUpdate, false);
  assert.equal(result.modelContextLimit, 50_000);
  assert.equal(result.delegate, false);
  assert.equal(result.toolBashDefaultTimeout, 120);
  assert.equal(result.toolOutputMaxBytes, 100_000);
  assert.equal(result.outputHeadroomMaxPct, 0.1);
  assert.equal(result.rules, true);
});

test("loadUserConfig picks up protection keys from acp.json", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-protect-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await writeConfig(tmpDir, { protectedTools: ["skill"], protectedLatestTools: ["read_*"] });
    const config = await loadUserConfig(tmpDir);
    assert.deepEqual(config.protectedTools, ["skill"]);
    assert.deepEqual(config.protectedLatestTools, ["read_*"]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("applyUserConfig lets user protection keys override adapter values", () => {
  const adapter: AdapterConfig = { protectedTools: ["read"], protectedLatestTools: ["write"] };
  const user = { protectedTools: ["skill"], protectedLatestTools: ["grep_*"] };
  const result = applyUserConfig(adapter, user);
  assert.deepEqual(result.protectedTools, ["skill"], "user protectedTools wins");
  assert.deepEqual(result.protectedLatestTools, ["grep_*"], "user protectedLatestTools wins");
});

test("applyUserConfig keeps adapter protection values when user does not set them", () => {
  const adapter: AdapterConfig = { protectedTools: ["read"], protectedLatestTools: ["write"] };
  const result = applyUserConfig(adapter, {});
  assert.deepEqual(result.protectedTools, ["read"]);
  assert.deepEqual(result.protectedLatestTools, ["write"]);
});

test("applyUserConfig trims protection entries", () => {
  const result = applyUserConfig({}, { protectedTools: [" skill ", "skill_*"] });
  assert.deepEqual(result.protectedTools, ["skill", "skill_*"]);
});

test("malformed protection values in acp.json warn and fall back instead of failing", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-badprotect-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    for (const body of [
      '{ "protectedTools": "skill" }',
      '{ "protectedTools": [] }',
      '{ "protectedTools": [42] }',
      '{ "protectedTools": [" "] }',
      '{ "protectedTools": null }',
      '{ "protectedLatestTools": "read" }',
    ]) {
      const cfgDir = path.join(tmpDir, CONFIG_DIR_NAME);
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(path.join(cfgDir, "acp.json"), body, "utf8");
      const user = await loadUserConfig(tmpDir);
      const result = applyUserConfig({ protectedTools: ["fallback"], protectedLatestTools: ["fallback*"] }, user);
      assert.deepEqual(result.protectedTools, ["fallback"], `malformed ${body} falls back to adapter value`);
      assert.deepEqual(result.protectedLatestTools, ["fallback*"], `malformed ${body} leaves other key untouched`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- neverPreserveRecentTools (empty array is a VALID escape hatch) ---------

test("loadUserConfig picks up neverPreserveRecentTools from acp.json", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-test-npr-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await writeConfig(tmpDir, { neverPreserveRecentTools: ["decompress", "search_context", "bash"] });
    const config = await loadUserConfig(tmpDir);
    assert.deepEqual(config.neverPreserveRecentTools, ["decompress", "search_context", "bash"]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("applyUserConfig accepts an EMPTY neverPreserveRecentTools array (unlike the protection keys)", () => {
  const result = applyUserConfig({}, { neverPreserveRecentTools: [] });
  assert.deepEqual(result.neverPreserveRecentTools, [], "[] is the max-protection escape hatch, not a malformed value");
});

test("applyUserConfig trims neverPreserveRecentTools and lets the user override the adapter", () => {
  const result = applyUserConfig(
    { neverPreserveRecentTools: ["read", "bash"] },
    { neverPreserveRecentTools: [" decompress ", "search_context", "bash"] },
  );
  assert.deepEqual(result.neverPreserveRecentTools, ["decompress", "search_context", "bash"]);
});

test("applyUserConfig keeps the adapter neverPreserveRecentTools when the user value is malformed", () => {
  const result = applyUserConfig({ neverPreserveRecentTools: ["read"] }, { neverPreserveRecentTools: [42] });
  assert.deepEqual(result.neverPreserveRecentTools, ["read"], "malformed user value falls back to adapter value");
});

test("applyUserConfig drops malformed neverPreserveRecentTools when no adapter value exists", () => {
  const result = applyUserConfig({}, { neverPreserveRecentTools: "read" });
  assert.equal(result.neverPreserveRecentTools, undefined);
});

// --- preserveRecentTools (positive knob; EMPTY array is INVALID here) -------

test("applyUserConfig trims preserveRecentTools and lets the user override the adapter", () => {
  const result = applyUserConfig(
    { preserveRecentTools: ["bash"] },
    { preserveRecentTools: [" read "] },
  );
  assert.deepEqual(result.preserveRecentTools, ["read"]);
});

test("applyUserConfig REJECTS an EMPTY preserveRecentTools array (no-op, unlike the never-list)", () => {
  const result = applyUserConfig({ preserveRecentTools: ["read"] }, { preserveRecentTools: [] });
  assert.deepEqual(result.preserveRecentTools, ["read"], "[] is a pure no-op — falls back to adapter, not accepted");
});

test("applyUserConfig keeps the adapter preserveRecentTools when the user value is malformed", () => {
  const result = applyUserConfig({ preserveRecentTools: ["read"] }, { preserveRecentTools: [42] });
  assert.deepEqual(result.preserveRecentTools, ["read"]);
  assert.equal(applyUserConfig({}, { preserveRecentTools: "read" }).preserveRecentTools, undefined);
});
