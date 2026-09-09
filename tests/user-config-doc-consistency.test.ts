import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadUserConfig } from "../src/user-config.js";

function parseDocumentedTopLevelKeys(md: string): string[] {
  const start = md.indexOf("## Parameter Reference");
  assert.notEqual(start, -1, "'## Parameter Reference' section not found in CONFIGURATION.md");
  const tail = md.slice(start);
  const end = tail.indexOf("\n## ", 1);
  const section = end === -1 ? tail : tail.slice(0, end);
  const keys = new Set<string>();
  let inKeyTable = false;
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) {
      inKeyTable = false;
      continue;
    }
    if (!inKeyTable) {
      inKeyTable = /^key\b/i.test(line.slice(1).trim());
      continue;
    }
    const m = line.match(/^\|\s*`([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)`\s*\|/);
    if (!m) continue;
    keys.add(m[1].split(".")[0]);
  }
  return [...keys].sort();
}

type HomeEnv = { HOME: string | undefined; USERPROFILE: string | undefined };

let savedHome: HomeEnv;
let emptyHome: string;

before(async () => {
  savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-doc-consistency-home-"));
  process.env.HOME = emptyHome;
  process.env.USERPROFILE = emptyHome;
});

after(async () => {
  process.env.HOME = savedHome.HOME;
  process.env.USERPROFILE = savedHome.USERPROFILE;
  await fs.rm(emptyHome, { recursive: true, force: true });
});

test("every documented top-level acp.json key survives loadUserConfig", async () => {
  const md = await fs.readFile(new URL("../CONFIGURATION.md", import.meta.url), "utf8");
  const keys = parseDocumentedTopLevelKeys(md);
  assert.ok(
    keys.length >= 9,
    `expected at least 9 documented top-level keys, got ${keys.length}: ${keys.join(", ")}`
  );
  for (const core of ["enabled", "debug", "autoUpdate", "delegate", "compress", "prompts"]) {
    assert.ok(keys.includes(core), `parser guard: '${core}' should be documented in CONFIGURATION.md`);
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acp-doc-consistency-cwd-"));
  try {
    const dirPath = path.join(cwd, ".pi");
    await fs.mkdir(dirPath, { recursive: true });
    const payload: Record<string, boolean> = {};
    for (const k of keys) payload[k] = true;
    await fs.writeFile(path.join(dirPath, "acp.json"), JSON.stringify(payload), "utf8");
    const config = await loadUserConfig(cwd);
    for (const k of keys) {
      assert.equal(
        (config as Record<string, unknown>)[k],
        true,
        `documented top-level key '${k}' was silently dropped by loadUserConfig (missing from KNOWN whitelist?)`
      );
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
