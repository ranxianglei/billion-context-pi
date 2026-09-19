import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadUserConfig, applyUserConfig, diagnoseJsonFailure, readAcpFiles, resolveAcpDisabled, enabledTypeHint, type AcpFileResult } from "../src/user-config.js";
import type { AdapterConfig } from "../src/config.js";

const CONFIG_DIR_NAME = ".pi";

async function writeConfig(dir: string, data: object): Promise<string> {
  const dirPath = path.join(dir, CONFIG_DIR_NAME);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, "acp.json");
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  return filePath;
}

type HomeEnv = { HOME: string | undefined; USERPROFILE: string | undefined };

function snapshotHome(): HomeEnv {
  return { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
}

function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function restoreHome(env: HomeEnv): void {
  process.env.HOME = env.HOME;
  process.env.USERPROFILE = env.USERPROFILE;
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
  };
  const result = applyUserConfig(adapter, user);
  assert.equal(result.debug, true);
  assert.equal(result.autoUpdate, false);
  assert.equal(result.modelContextLimit, 50_000);
  assert.equal(result.delegate, false);
  assert.equal(result.toolBashDefaultTimeout, 120);
  assert.equal(result.toolOutputMaxBytes, 100_000);
  assert.equal(result.outputHeadroomMaxPct, 0.1);
});

function mkOk(scope: "global" | "project", value: Record<string, unknown>): AcpFileResult {
  return { file: `/x/${scope}/acp.json`, scope, status: "ok", value };
}

function mkFailed(scope: "global" | "project"): AcpFileResult {
  return { file: `/x/${scope}/acp.json`, scope, status: "failed", reason: "bad" };
}

async function writeRawAcp(baseDir: string, raw: string): Promise<void> {
  const d = path.join(baseDir, CONFIG_DIR_NAME);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, "acp.json"), raw, "utf8");
}

test("diagnoseJsonFailure classifies BOM prefix", () => {
  assert.match(diagnoseJsonFailure("\uFEFF{}", new Error("Unexpected token")), /BOM/);
});

test("diagnoseJsonFailure classifies trailing comma", () => {
  assert.match(diagnoseJsonFailure('{ "a": 1, }', new Error("Expected double-quoted property name")), /trailing comma/);
});

test("diagnoseJsonFailure classifies comment", () => {
  assert.match(diagnoseJsonFailure('{ // c\n "a": 1 }', new Error("Unexpected token '/'")), /comment/i);
});

test("diagnoseJsonFailure classifies unquoted key", () => {
  assert.match(diagnoseJsonFailure("{ a: 1 }", new Error("Expected property name or '}' in JSON at position 2")), /double quotes/);
});

test("diagnoseJsonFailure falls back to parser message", () => {
  assert.equal(diagnoseJsonFailure("{}", new Error("custom boom")), "custom boom");
});

test("readAcpFiles reports missing for absent files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-h-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acp-c-"));
  const env = snapshotHome(); setHome(home);
  try {
    const res = readAcpFiles(cwd);
    assert.deepEqual(res.map((r) => [r.scope, r.status]), [["global", "missing"], ["project", "missing"]]);
  } finally {
    restoreHome(env);
    await Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(cwd, { recursive: true, force: true })]);
  }
});

test("readAcpFiles parses valid global and project", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-h-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acp-c-"));
  const env = snapshotHome(); setHome(home);
  try {
    await writeConfig(home, { debug: true });
    await writeConfig(cwd, { modelContextLimit: 123 });
    const res = readAcpFiles(cwd);
    assert.equal(res[0]?.status, "ok");
    assert.equal(res[0]?.value?.debug, true);
    assert.equal(res[1]?.status, "ok");
    assert.equal(res[1]?.value?.modelContextLimit, 123);
  } finally {
    restoreHome(env);
    await Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(cwd, { recursive: true, force: true })]);
  }
});

test("readAcpFiles flags malformed project file with hint, leaves global intact", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-h-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acp-c-"));
  const env = snapshotHome(); setHome(home);
  try {
    await writeConfig(home, { debug: true });
    await writeRawAcp(cwd, "{ enabled : false }");
    const res = readAcpFiles(cwd);
    assert.equal(res[0]?.status, "ok");
    assert.equal(res[1]?.status, "failed");
    assert.match(res[1]?.reason ?? "", /double quotes/);
  } finally {
    restoreHome(env);
    await Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(cwd, { recursive: true, force: true })]);
  }
});

test("readAcpFiles flags BOM-prefixed global file", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-h-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acp-c-"));
  const env = snapshotHome(); setHome(home);
  try {
    await writeRawAcp(home, "\uFEFF{ \"enabled\": false }");
    const res = readAcpFiles(cwd);
    assert.equal(res[0]?.status, "failed");
    assert.match(res[0]?.reason ?? "", /BOM/);
    assert.equal(res[1]?.status, "missing");
  } finally {
    restoreHome(env);
    await Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(cwd, { recursive: true, force: true })]);
  }
});

test("resolveAcpDisabled: empty -> not disabled", () => {
  assert.equal(resolveAcpDisabled([]), false);
});

test("resolveAcpDisabled: literal false disables, true and non-boolean do not", () => {
  assert.equal(resolveAcpDisabled([mkOk("global", { enabled: false })]), true);
  assert.equal(resolveAcpDisabled([mkOk("global", { enabled: true })]), false);
  assert.equal(resolveAcpDisabled([mkOk("global", { enabled: "false" })]), false);
});

test("resolveAcpDisabled: project overrides global", () => {
  assert.equal(resolveAcpDisabled([mkOk("global", { enabled: true }), mkOk("project", { enabled: false })]), true);
  assert.equal(resolveAcpDisabled([mkOk("global", { enabled: false }), mkOk("project", { enabled: true })]), false);
});

test("resolveAcpDisabled: failed file ignored, valid global stands", () => {
  assert.equal(resolveAcpDisabled([mkOk("global", { enabled: false }), mkFailed("project")]), true);
});

test("enabledTypeHint: silent for absent/boolean enabled, flags non-boolean", () => {
  assert.equal(enabledTypeHint([]), null);
  assert.equal(enabledTypeHint([mkOk("global", { enabled: false })]), null);
  assert.equal(enabledTypeHint([mkOk("global", { other: 1 })]), null);
  const h = enabledTypeHint([mkOk("global", { enabled: "false" })]);
  assert.match(h ?? "", /boolean/);
  assert.match(h ?? "", /"false"/);
});
