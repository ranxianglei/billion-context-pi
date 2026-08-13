import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiCliEntry } from "../src/delegate-tool.js";

const REL = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");

/** A machine with pi installed under /usr/* would defeat the fallback test. */
function globalPiInstalled(): boolean {
  if (process.platform === "win32") return false;
  return ["/usr/local/lib", "/usr/lib"].some((p) => existsSync(join(p, "node_modules", REL)));
}

function makeTree(rel: string): string {
  const base = mkdtempSync(join(tmpdir(), "acp-entry-"));
  const cli = join(base, rel);
  mkdirSync(join(cli, ".."), { recursive: true });
  writeFileSync(cli, "");
  return base;
}

test("PI_CLI_PATH env overrides everything, even when argv[1] is the pi CLI", () => {
  const argv1 = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const explicit = join("custom", "pi", "cli.js");
  assert.equal(
    resolvePiCliEntry(argv1, { PI_CLI_PATH: explicit }, true),
    explicit,
  );
});

test("argv[1] matching the pi CLI path is used as-is (CLI host, no fs probing)", () => {
  const posixPath = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  assert.equal(resolvePiCliEntry(posixPath, {}, true), posixPath);

  const winPath = "C:\\Users\\dev\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";
  assert.equal(resolvePiCliEntry(winPath, {}, true), winPath);
});

test("embedded host probes upward from argv[1] (pi-web: next bin finds pi-coding-agent)", () => {
  const base = makeTree(join("app", "node_modules", REL));
  const nextBin = join(base, "app", "node_modules", "next", "dist", "bin", "next");
  try {
    const expected = join(base, "app", "node_modules", REL);
    assert.equal(resolvePiCliEntry(nextBin, {}, true), expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("global install candidates are probed when upward probe fails", () => {
  const base = mkdtempSync(join(tmpdir(), "acp-entry-global-"));
  try {
    let env: NodeJS.ProcessEnv;
    let expected: string;
    if (process.platform === "win32") {
      expected = join(base, "npm", "node_modules", REL);
      mkdirSync(join(expected, ".."), { recursive: true });
      writeFileSync(expected, "");
      env = { APPDATA: base };
    } else {
      expected = join(base, ".local", "lib", "node_modules", REL);
      mkdirSync(join(expected, ".."), { recursive: true });
      writeFileSync(expected, "");
      env = { HOME: base };
    }
    const argv1 = join(base, "host", "bin", "server.js");
    assert.equal(resolvePiCliEntry(argv1, env, true), expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unresolvable pi host falls back to argv[1] (never worse than status quo)", { skip: globalPiInstalled() }, () => {
  const argv1 = join(tmpdir(), "acp-entry-nohit", "bin", "server.js");
  assert.equal(resolvePiCliEntry(argv1, {}, true), argv1);
});

test("non-pi host (omp) keeps argv[1] untouched - probing is pi-host only", () => {
  const argv1 = join("omp", "dist", "cli.js");
  assert.equal(resolvePiCliEntry(argv1, {}, false), argv1);
});

test("PI_CLI_PATH still overrides on non-pi hosts (explicit user choice)", () => {
  const explicit = join("custom", "pi", "cli.js");
  assert.equal(
    resolvePiCliEntry(join("omp", "dist", "cli.js"), { PI_CLI_PATH: explicit }, false),
    explicit,
  );
});
