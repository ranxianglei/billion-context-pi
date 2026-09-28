import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME, resolveConfigDirName, userFileBases } from "../src/config-dir.js";
import { loadUserConfig } from "../src/user-config.js";
import { readToolSurfaceSync } from "../src/surface.js";
import { defaultPackSources } from "../src/prompt-pack.js";

// issue #574: a fork host (Prime) exports no CONFIG_DIR_NAME, so the adapter
// fell back to Pi's ".pi" and wrote its log/markers into Pi's home dir while
// reading user files Pi could also see. The resolution ladder fixes the name;
// hand-written user files additionally fall back to their legacy ".pi"
// location per scope until the host's own path exists.

const HOME = "/home/u";

test("#574 ladder: single-segment host export is used as-is", () => {
  assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: ".pi" }, HOME), ".pi");
  assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: ".foo" }, HOME), ".foo");
});

test("#574 ladder: absent or invalid export falls through", () => {
  for (const bad of [undefined, "", null, 42]) {
    assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: bad }, HOME), ".pi");
  }
  assert.equal(resolveConfigDirName({}, HOME), ".pi");
});

test("#574 ladder: multi-segment export rejected, derived from getAgentDir instead", () => {
  // Prime's internal constant IS the agent dir — using it verbatim would join paths to <agentDir>/agent
  const host = { CONFIG_DIR_NAME: ".prime/agent", getAgentDir: () => `${HOME}/.prime/agent` };
  assert.equal(resolveConfigDirName(host, HOME), ".prime");
});

test("#574 ladder: getAgentDir shaped <home>/<name>/agent derives <name>", () => {
  assert.equal(resolveConfigDirName({ getAgentDir: () => `${HOME}/.prime/agent` }, HOME), ".prime");
  assert.equal(resolveConfigDirName({ getAgentDir: () => `${HOME}/.prime/agent/` }, HOME), ".prime");
  assert.equal(resolveConfigDirName({ getAgentDir: () => `${HOME}/.pi/agent` }, HOME), ".pi");
});

test("#574 ladder: out-of-shape getAgentDir falls back to .pi", () => {
  assert.equal(resolveConfigDirName({ getAgentDir: () => `${HOME}/agent` }, HOME), ".pi");
  assert.equal(resolveConfigDirName({ getAgentDir: () => `/elsewhere/.x/agent` }, HOME), ".pi");
  assert.equal(resolveConfigDirName({ getAgentDir: () => `${HOME}/.x/deeper/agent` }, HOME), ".pi");
  assert.equal(resolveConfigDirName({ getAgentDir: () => "not-a-path" }, HOME), ".pi");
});

test("#574 ladder: throwing or non-function getAgentDir falls back to .pi", () => {
  const throwing = { getAgentDir: (): string => { throw new Error("boom"); } };
  assert.equal(resolveConfigDirName(throwing, HOME), ".pi");
  assert.equal(resolveConfigDirName({ getAgentDir: "nope" }, HOME), ".pi");
});

test("#574 CONFIG_DIR_NAME resolves to a single-segment dir against the installed host", () => {
  assert.ok(CONFIG_DIR_NAME.length > 0 && !CONFIG_DIR_NAME.includes("/") && !CONFIG_DIR_NAME.includes("\\"));
});

test("#574 userFileBases: legacy .pi trails the primary per scope on forks only", () => {
  const cwd = "/work/proj";
  const fork = userFileBases(cwd, ".prime");
  assert.deepEqual(fork.project, [path.join(cwd, ".prime"), path.join(cwd, LEGACY_CONFIG_DIR_NAME)]);
  assert.equal(fork.global.length, 2);
  assert.ok(fork.global[0].endsWith(path.sep + ".prime"));
  assert.ok(fork.global[1].endsWith(path.sep + LEGACY_CONFIG_DIR_NAME));
  const pi = userFileBases(cwd, ".pi");
  assert.deepEqual(pi.project, [path.join(cwd, ".pi")]);
  assert.equal(pi.global.length, 1);
});

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(os.tmpdir(), "bili-acp-fork-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeFile(dir: string, file: string, content: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content));
}

test("#574 acp.json: legacy .pi global is read while the primary is absent (fork)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(path.join(home, ".pi"), "acp.json", { debug: true });
    assert.deepEqual(await loadUserConfig(cwd, ".prime"), { debug: true });
  });
});

test("#574 acp.json: primary shadows the legacy file within a scope (fork)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(path.join(home, ".pi"), "acp.json", { debug: true });
    writeFile(path.join(home, ".prime"), "acp.json", { debug: false });
    assert.deepEqual(await loadUserConfig(cwd, ".prime"), { debug: false });
  });
});

test("#574 acp.json: corrupt primary falls through to the legacy file (fork)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(path.join(home, ".pi"), "acp.json", { debug: true });
    writeFile(path.join(home, ".prime"), "acp.json", "{ enabled false !!!");
    assert.deepEqual(await loadUserConfig(cwd, ".prime"), { debug: true });
  });
});

test("#574 acp.json: project still overrides global on forks (independent scopes)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(path.join(home, ".pi"), "acp.json", { debug: true });
    writeFile(path.join(cwd, ".prime"), "acp.json", { debug: false });
    assert.deepEqual(await loadUserConfig(cwd, ".prime"), { debug: false });
  });
});

test("#574 toolPrompts: legacy .pi surface is read while the primary is absent (fork)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(path.join(home, ".pi"), "acp.json", { toolPrompts: { compress: { description: "legacy-desc" } } });
    assert.deepEqual(readToolSurfaceSync(cwd, ".prime"), { compress: { description: "legacy-desc" } });
  });
});

test("#574 toolPrompts: primary shadows the legacy surface (fork)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(path.join(home, ".pi"), "acp.json", { toolPrompts: { compress: { description: "legacy-desc" } } });
    writeFile(path.join(home, ".prime"), "acp.json", { toolPrompts: { compress: { description: "fresh-desc" } } });
    assert.deepEqual(readToolSurfaceSync(cwd, ".prime"), { compress: { description: "fresh-desc" } });
  });
});

test("#574 packs: each legacy packs dir trails its primary in source order (fork)", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    const sources = defaultPackSources(cwd, ".prime");
    assert.equal(sources.length, 5); // project, project-legacy, user, user-legacy, builtin
    const resolveFirst = (name: string) => {
      for (const s of sources) {
        const p = s.resolve(name);
        if (p) return p;
      }
      return null;
    };

    // pack only in the legacy project dir still resolves
    writeFile(path.join(cwd, ".pi", "acp", "packs"), "mypack.json", { version: "1", surface: {} });
    let pack = resolveFirst("mypack");
    assert.ok(pack && pack.source.endsWith(path.join(".pi", "acp", "packs", "mypack.json")));

    // same-named pack in the primary project dir wins over legacy
    writeFile(path.join(cwd, ".prime", "acp", "packs"), "mypack.json", { version: "2", surface: {} });
    pack = resolveFirst("mypack");
    assert.ok(pack && pack.source.endsWith(path.join(".prime", "acp", "packs", "mypack.json")));
    assert.equal(pack.version, "2");

    // with the project scope empty, the user scope resolves; primary user dir beats legacy
    rmSync(path.join(cwd, ".prime", "acp", "packs", "mypack.json"));
    rmSync(path.join(cwd, ".pi", "acp", "packs", "mypack.json"));
    writeFile(path.join(home, ".pi", "acp", "packs"), "mypack.json", { version: "3", surface: {} });
    writeFile(path.join(home, ".prime", "acp", "packs"), "mypack.json", { version: "4", surface: {} });
    pack = resolveFirst("mypack");
    assert.ok(pack && pack.source.endsWith(path.join(".prime", "acp", "packs", "mypack.json")));
    assert.equal(pack.version, "4");

    // legacy user dir alone still resolves
    rmSync(path.join(home, ".prime", "acp", "packs", "mypack.json"));
    pack = resolveFirst("mypack");
    assert.ok(pack && pack.source.endsWith(path.join(".pi", "acp", "packs", "mypack.json")));
    assert.equal(pack.version, "3");
  });
});

test("#574 packs: .pi hosts keep the historical three-source layout", async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, "proj");
    assert.equal(defaultPackSources(cwd, ".pi").length, 3);
    assert.equal(defaultPackSources(cwd).length, 3); // installed devDep resolves to .pi
  });
});
