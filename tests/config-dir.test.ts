import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, acpJsonFiles, resolveConfigDirName, userConfigPathIn } from "../src/config-dir.js";

const HOME = path.resolve("/home/tester");
const agentDirAt = (...segments: string[]) => () => path.join(HOME, ...segments);

const CASES: Array<{ name: string; host: Parameters<typeof resolveConfigDirName>[0]; expected: string }> = [
  { name: "Pi: exported single-segment name wins", host: { CONFIG_DIR_NAME: ".pi", getAgentDir: agentDirAt(".pi", "agent") }, expected: ".pi" },
  {
    name: "Pi with PI_CODING_AGENT_DIR override: export still wins",
    host: { CONFIG_DIR_NAME: ".pi", getAgentDir: () => path.resolve("/srv/pi-agent") },
    expected: ".pi",
  },
  { name: "Prime (no CONFIG_DIR_NAME export): derived from getAgentDir()", host: { getAgentDir: agentDirAt(".prime", "agent") }, expected: ".prime" },
  {
    name: "Prime re-exporting its own CONFIG_DIR_NAME (.prime/agent): not a dir name, derived instead",
    host: { CONFIG_DIR_NAME: ".prime/agent", getAgentDir: agentDirAt(".prime", "agent") },
    expected: ".prime",
  },
  { name: "backslash-separated export is rejected", host: { CONFIG_DIR_NAME: ".prime\\agent" }, expected: ".pi" },
  { name: "empty or non-string export falls through", host: { CONFIG_DIR_NAME: "", getAgentDir: agentDirAt(".omp", "agent") }, expected: ".omp" },
  { name: "agent dir outside home (env override) falls back", host: { getAgentDir: () => path.resolve("/srv/prime/agent") }, expected: ".pi" },
  { name: "agent dir not named agent falls back", host: { getAgentDir: agentDirAt(".prime", "state") }, expected: ".pi" },
  { name: "agent dir nested deeper than ~/<name>/agent falls back", host: { getAgentDir: agentDirAt("x", ".prime", "agent") }, expected: ".pi" },
  {
    name: "throwing getAgentDir falls back",
    host: {
      getAgentDir: () => {
        throw new Error("boom");
      },
    },
    expected: ".pi",
  },
  { name: "non-string getAgentDir result falls back", host: { getAgentDir: () => 42 }, expected: ".pi" },
  { name: "nothing exported falls back", host: {}, expected: ".pi" },
];

for (const { name, host, expected } of CASES) {
  test(`#574 resolveConfigDirName: ${name}`, () => {
    assert.equal(resolveConfigDirName(host, HOME), expected);
  });
}

test("#574 CONFIG_DIR_NAME under the real pi package is unchanged (.pi)", () => {
  assert.equal(CONFIG_DIR_NAME, ".pi");
});

function withRoot(files: string[], run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "bcp-config-dir-"));
  try {
    for (const rel of files) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), "{}");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LEGACY_CASES: Array<{ name: string; dirName: string; files: string[]; expected: string }> = [
  { name: "Pi: own path even when absent", dirName: ".pi", files: [], expected: ".pi/acp.json" },
  { name: "fork: own file exists", dirName: ".prime", files: [".prime/acp.json"], expected: ".prime/acp.json" },
  { name: "fork: own file wins over legacy .pi", dirName: ".prime", files: [".prime/acp.json", ".pi/acp.json"], expected: ".prime/acp.json" },
  { name: "fork: only legacy .pi file exists, still honoured", dirName: ".prime", files: [".pi/acp.json"], expected: ".pi/acp.json" },
  { name: "fork: nothing exists, own path", dirName: ".prime", files: [], expected: ".prime/acp.json" },
];

for (const { name, dirName, files, expected } of LEGACY_CASES) {
  test(`#574 userConfigPathIn: ${name}`, () => {
    withRoot(files, (root) => {
      assert.equal(userConfigPathIn(dirName, root, "acp.json"), path.join(root, expected));
    });
  });
}

test("#574 userConfigPathIn: legacy fallback also covers directories (prompt packs)", () => {
  withRoot([".pi/acp/packs/mine.json"], (root) => {
    assert.equal(userConfigPathIn(".prime", root, "acp", "packs"), path.join(root, ".pi", "acp", "packs"));
  });
});

test("#574 acpJsonFiles: global then project, under the real pi package", () => {
  const cwd = path.resolve("/work/project");
  assert.deepEqual(acpJsonFiles(cwd), [path.join(homedir(), ".pi", "acp.json"), path.join(cwd, ".pi", "acp.json")]);
});
