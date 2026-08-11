import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { checkForUpdate, findNpmRoot, isNewer } from "../src/update.js";

// Opt-out must short-circuit BEFORE any network/filesystem touch. We assert this
// by making global fetch throw if it is ever reached.
function withFetchGuard<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("fetch must not be called when auto-update is disabled");
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("checkForUpdate is a no-op when autoUpdate=false (no fetch)", async () => {
  delete process.env.ACP_AUTO_UPDATE;
  await withFetchGuard(() => checkForUpdate(false));
});

test("checkForUpdate is a no-op for every opt-out env value, case-insensitive (no fetch)", async () => {
  const opts = ["0", "false", "no", "off", "FALSE", "No", "Off"];
  for (const v of opts) {
    process.env.ACP_AUTO_UPDATE = v;
    await withFetchGuard(() => checkForUpdate(true));
  }
  delete process.env.ACP_AUTO_UPDATE;
});

test("checkForUpdate trims surrounding whitespace in ACP_AUTO_UPDATE before matching (no fetch)", async () => {
  for (const v of [" false ", "\t no\t", "  off "]) {
    process.env.ACP_AUTO_UPDATE = v;
    await withFetchGuard(() => checkForUpdate(true));
  }
  delete process.env.ACP_AUTO_UPDATE;
});

test("findNpmRoot locates the package root when nested under node_modules", () => {
  const ext = join(homedir(), "x", "node_modules", "billion-context-pi");
  assert.equal(findNpmRoot(ext), join(homedir(), "x"));
});

test("findNpmRoot terminates when no node_modules ancestor exists (no Windows infinite loop)", { timeout: 2000 }, () => {
  assert.equal(findNpmRoot(homedir()), undefined);
});

test("isNewer: compares x.y.z numerically", () => {
  assert.equal(isNewer("1.2.3", "1.2.2"), true);
  assert.equal(isNewer("1.2.2", "1.2.3"), false);
  assert.equal(isNewer("2.0.0", "1.9.9"), true);
  assert.equal(isNewer("1.2.3", "1.2.3"), false);
});

test("isNewer: prerelease never beats the same release, release beats prerelease", () => {
  assert.equal(isNewer("1.0.1-rc.1", "1.0.0"), true, "rc still newer than old release");
  assert.equal(isNewer("1.0.1-rc.1", "1.0.1"), false, "rc must not win over its own release");
  assert.equal(isNewer("1.0.1", "1.0.1-rc.1"), true, "release beats the rc");
  assert.equal(isNewer("1.0.0-rc.1", "1.0.0"), false);
});
