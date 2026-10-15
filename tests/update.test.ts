import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { NpmRunner } from "../src/update.js";

// Redirect HOME before importing src/update: THROTTLE_FILE is a module-level
// constant derived from homedir(), and we must not touch the real one.
const REAL_HOME = process.env.HOME ?? "";
const FAKE_HOME = mkdtempSync(join(tmpdir(), "acp-update-test-"));
process.env.HOME = FAKE_HOME;
process.env.ACP_LOG_FILE = join(FAKE_HOME, "acp.log");

// The real-npm tests below need the user's actual HOME (npm resolution may
// depend on it, e.g. nvm layouts or npm wrapper scripts).
function withRealHome<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HOME;
  process.env.HOME = REAL_HOME;
  return fn().finally(() => {
    process.env.HOME = prev;
  });
}

const {
  checkForUpdate,
  findNpmRoot,
  setRunNpmForTest,
  setRunNodeForTest,
  setInstalledSpecForTest,
  autoInstallLatest,
  isVersionNewer,
  specUpdateTag,
  isAutoUpdatableSpec,
  runNpm,
  runNode,
  findExtensionDir,
  readOnlyMarkerFile,
  resetUpdateStateForTest,
  cleanupStaleMarkers,
} = await import("../src/update.js");

const THROTTLE = join(
  FAKE_HOME,
  CONFIG_DIR_NAME,
  "agent",
  ".billion-context-pi-update-check",
);
// HOME redirection is a no-op on Windows (os.homedir() reads USERPROFILE), so
// also pin the throttle file via env — src/update.ts resolves it lazily and
// prefers this over any homedir-derived path.
process.env.ACP_UPDATE_THROTTLE_FILE = THROTTLE;
const REPO_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version;

function resetThrottle(): void {
  try {
    rmSync(THROTTLE);
  } catch {
  }
}

function readLog(): string {
  try {
    return readFileSync(process.env.ACP_LOG_FILE as string, "utf-8");
  } catch {
    return "";
  }
}

type NpmResult = { code: number; stdout: string; stderr: string };

function makeFakeNpm(viewResult: NpmResult, installResult: NpmResult) {
  const calls: { args: string[]; opts: { cwd?: string; timeout: number } }[] = [];
  const impl: NpmRunner = async (args, opts) => {
    calls.push({ args, opts });
    return args[0] === "view" ? viewResult : installResult;
  };
  return { impl, calls };
}

// Opt-out must short-circuit BEFORE any npm/fetch touch.
function withGuards<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("fetch must not be called when auto-update is disabled");
  }) as typeof fetch;
  setRunNpmForTest(async () => {
    throw new Error("npm must not be called when auto-update is disabled");
  });
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("checkForUpdate is a no-op when autoUpdate=false (no npm, no fetch)", async () => {
  delete process.env.ACP_AUTO_UPDATE;
  await withGuards(() => checkForUpdate(false));
});

test("checkForUpdate is a no-op for every opt-out env value, case-insensitive (no npm, no fetch)", async () => {
  const opts = ["0", "false", "no", "off", "FALSE", "No", "Off"];
  for (const v of opts) {
    process.env.ACP_AUTO_UPDATE = v;
    await withGuards(() => checkForUpdate(true));
  }
  delete process.env.ACP_AUTO_UPDATE;
});

test("checkForUpdate trims surrounding whitespace in ACP_AUTO_UPDATE before matching (no npm, no fetch)", async () => {
  for (const v of [" false ", "\t no\t", "  off "]) {
    process.env.ACP_AUTO_UPDATE = v;
    await withGuards(() => checkForUpdate(true));
  }
  delete process.env.ACP_AUTO_UPDATE;
});

test("isVersionNewer compares numeric segments", () => {
  assert.equal(isVersionNewer("0.1.43", "0.1.41"), true);
  assert.equal(isVersionNewer("0.1.41", "0.1.43"), false);
  assert.equal(isVersionNewer("0.1.41", "0.1.41"), false);
  assert.equal(isVersionNewer("0.2.0", "0.10.0"), false);
  assert.equal(isVersionNewer("1.0.0", "0.9.9"), true);
  assert.equal(isVersionNewer("v1.2.3", "1.2.2"), true);
});

test("isVersionNewer handles prerelease ordering (pre < release, numeric pre parts)", () => {
  // A prerelease is OLDER than its release: 0.1.46-pr.202.1 < 0.1.46
  assert.equal(isVersionNewer("0.1.46", "0.1.46-pr.202.1"), true);
  assert.equal(isVersionNewer("0.1.46-pr.202.1", "0.1.46"), false);
  // Higher prerelease number is newer
  assert.equal(isVersionNewer("0.1.46-pr.203.1", "0.1.46-pr.202.1"), true);
  // A release is newer than any prerelease of a lower version
  assert.equal(isVersionNewer("0.1.47", "0.1.46-pr.999.1"), true);
});

test("specUpdateTag maps a spec to the dist-tag channel to track", () => {
  // dist-tags track themselves
  assert.equal(specUpdateTag("stable"), "stable");
  assert.equal(specUpdateTag("dev"), "dev");
  assert.equal(specUpdateTag("pr-327"), "pr-327");
  assert.equal(specUpdateTag("latest"), "latest");
  // ranges and * track latest
  assert.equal(specUpdateTag("^1.2.3"), "latest");
  assert.equal(specUpdateTag("~0.1.0"), "latest");
  assert.equal(specUpdateTag(">=1.0.0"), "latest");
  assert.equal(specUpdateTag("*"), "latest");
  // exact pins and non-registry specs never auto-update
  assert.equal(specUpdateTag("1.2.3"), undefined);
  assert.equal(specUpdateTag("file:../local/x.tgz"), undefined);
  assert.equal(specUpdateTag("git+https://github.com/x/y.git"), undefined);
  assert.equal(specUpdateTag(""), undefined);
});

test("specUpdateTag tracks latest for exact prerelease pins (npm-resolved tag installs)", () => {
  // npm records `npm i pkg@pr-293` as the resolved exact version, losing the
  // channel; freezing those users on a stale PR/dev build serves no one.
  assert.equal(specUpdateTag("0.1.56-pr.293.4"), "latest");
  assert.equal(specUpdateTag("0.1.57-beta.1"), "latest");
  // exact stable pins still never auto-update
  assert.equal(specUpdateTag("0.1.56"), undefined);
});

test("isAutoUpdatableSpec classifies specs", () => {
  assert.equal(isAutoUpdatableSpec("latest"), true);
  assert.equal(isAutoUpdatableSpec("*"), true);
  assert.equal(isAutoUpdatableSpec("^1.2.3"), true);
  assert.equal(isAutoUpdatableSpec("stable"), true);
  assert.equal(isAutoUpdatableSpec("pr-327"), true);
  assert.equal(isAutoUpdatableSpec("1.2.3"), false);
  assert.equal(isAutoUpdatableSpec("file:../x.tgz"), false);
  assert.equal(isAutoUpdatableSpec(""), false);
});

test("runNpm resolves real npm output", { timeout: 30_000 }, (t) => {
  if (!REAL_HOME) t.skip("HOME not set");
  return withRealHome(async () => {
    const r = await runNpm(["--version"], { timeout: 20_000 });
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});

test("runNpm captures stderr on failure (unreachable registry, no retries)", { timeout: 30_000 }, (t) => {
  if (!REAL_HOME) t.skip("HOME not set");
  return withRealHome(async () => {
    const r = await runNpm(
      ["view", "billion-context-pi", "--registry", "http://127.0.0.1:9/", "--fetch-retries=0"],
      { timeout: 20_000 },
    );
    assert.equal(r.code, 1);
    assert.ok(r.stderr.length > 0);
  });
});

test("checkForUpdate queries npm view first with exact args", async () => {
  resetThrottle();
  const { impl, calls } = makeFakeNpm(
    { code: 0, stdout: "0.0.1\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  setRunNpmForTest(impl);
  const notes: string[] = [];
  await checkForUpdate(true, (m) => notes.push(m));
  assert.equal(notes.length, 0);
  assert.deepEqual(calls[0].args, ["view", "billion-context-pi", "version"]);
  assert.ok(calls[0].opts.timeout > 0);
  assert.match(readLog(), new RegExp(`event=check current=${REPO_VERSION} latest=0\\.0\\.1 hasUpdate=false`));
});

test("checkForUpdate follows the installed channel: @stable → npm view --tag stable", async () => {
  resetThrottle();
  const { impl, calls } = makeFakeNpm(
    { code: 0, stdout: "0.0.1\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  setRunNpmForTest(impl);
  setInstalledSpecForTest("stable");
  try {
    const notes: string[] = [];
    await checkForUpdate(true, (m) => notes.push(m));
    assert.equal(notes.length, 0);
    assert.deepEqual(calls[0].args, ["view", "billion-context-pi", "version", "--tag", "stable"]);
  } finally {
    setInstalledSpecForTest(null);
  }
});

test("checkForUpdate skips the check entirely for an exact-pin spec (never auto-updates)", async () => {
  resetThrottle();
  const { impl, calls } = makeFakeNpm(
    { code: 0, stdout: "99.0.0\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  setRunNpmForTest(impl);
  setInstalledSpecForTest("1.2.3");
  try {
    const notes: string[] = [];
    await checkForUpdate(true, (m) => notes.push(m));
    // pinned spec → no npm view, no notify
    assert.equal(calls.length, 0);
    assert.equal(notes.length, 0);
  } finally {
    setInstalledSpecForTest(null);
  }
});

test("checkForUpdate: update available but not under node_modules → manual hint + install-skip logged", async () => {
  resetThrottle();
  const { impl } = makeFakeNpm(
    { code: 0, stdout: "99.0.0\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  setRunNpmForTest(impl);
  const notes: string[] = [];
  await checkForUpdate(true, (m) => notes.push(m));
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`billion-context-pi 99\\.0\\.0 available \\(you have ${REPO_VERSION}\\)`));
  assert.match(notes[0], /Run: pi update --extension npm:billion-context-pi/);
  assert.match(readLog(), /event=install-skip reason=not-under-node-modules/);
});

test("checkForUpdate: npm view fails → falls back to registry fetch", async () => {
  resetThrottle();
  setRunNpmForTest(async () => ({ code: 1, stdout: "", stderr: "npm error ENOENT" }));
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ version: "88.0.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const notes: string[] = [];
  try {
    await checkForUpdate(true, (m) => notes.push(m));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /registry\.npmjs\.org\/billion-context-pi\/latest/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /88\.0\.0 available/);
});

test("checkForUpdate: npm view fails and fetch throws → no notify, check-fetch-error logged", async () => {
  resetThrottle();
  setRunNpmForTest(async () => ({ code: 1, stdout: "", stderr: "" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network down");
  }) as typeof fetch;
  const notes: string[] = [];
  try {
    await checkForUpdate(true, (m) => notes.push(m));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(notes.length, 0);
  assert.match(readLog(), /event=check-fetch-error/);
});

test("checkForUpdate: npm view fails and fetch non-OK → no notify, check-http logged", async () => {
  resetThrottle();
  setRunNpmForTest(async () => ({ code: 1, stdout: "", stderr: "" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  const notes: string[] = [];
  try {
    await checkForUpdate(true, (m) => notes.push(m));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(notes.length, 0);
  assert.match(readLog(), /event=check-http status=503/);
});

test("checkForUpdate: second call within the 3-minute window is throttled", async () => {
  resetThrottle();
  const { impl, calls } = makeFakeNpm(
    { code: 0, stdout: "99.0.0\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  setRunNpmForTest(impl);
  await checkForUpdate(true);
  await checkForUpdate(true);
  assert.equal(calls.length, 1);
});

test("findNpmRoot locates the package root when nested under node_modules", () => {
  const ext = join(homedir(), "x", "node_modules", "billion-context-pi");
  assert.equal(findNpmRoot(ext), join(homedir(), "x"));
});

test("findNpmRoot terminates when no node_modules ancestor exists (no Windows infinite loop)", { timeout: 2000 }, () => {
  assert.equal(findNpmRoot(homedir()), undefined);
});

// --- install path (fixture layout; real runner not under node_modules) ---

type Fixture = {
  root: string;
  extDir: string;
  writeInstalled(version: string, opts?: { brokenEntry?: boolean }): void;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "acp-install-test-"));
  const extDir = join(root, "node_modules", "billion-context-pi");
  return {
    root,
    extDir,
    writeInstalled(version: string, opts?: { brokenEntry?: boolean }): void {
      const dist = join(extDir, "dist");
      mkdirSync(dist, { recursive: true });
      const body = opts?.brokenEntry
        ? "export const broken = (!!"
        : "export const loaded = true;\n";
      writeFileSync(join(dist, "index.js"), body);
      writeFileSync(
        join(extDir, "package.json"),
        JSON.stringify(
          {
            name: "billion-context-pi",
            version,
            main: "dist/index.js",
            exports: { ".": { import: "./dist/index.js" } },
            pi: { extensions: ["./dist/index.js"] },
          },
          null,
          2,
        ),
      );
    },
  };
}

test("autoInstallLatest: clean install verifies (real smoke import) and reports ok", { timeout: 60_000 }, async () => {
  const fx = makeFixture();
  fx.writeInstalled("9.9.9");
  const { impl, calls } = makeFakeNpm(
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  // install succeeded → put the new version on disk, as npm would
  const impl2: NpmRunner = async (args, opts) => {
    const res = await impl(args, opts);
    if (args[0] === "install") fx.writeInstalled("9.9.9");
    return res;
  };
  setRunNpmForTest(impl2);
  setRunNodeForTest(runNode); // real child process for the smoke import
  const outcome = await autoInstallLatest("9.9.9", fx.extDir);
  assert.equal(outcome, "ok");
  assert.ok(
    calls.some((c) => c.args.includes("billion-context-pi@9.9.9") && c.args.includes("--no-save")),
  );
  rmSync(fx.root, { recursive: true, force: true });
});

test("autoInstallLatest: syntax-broken entry fails verify → rolls back to previous version", { timeout: 60_000 }, async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.2.3"); // previously-installed = rollback target
  const { impl, calls } = makeFakeNpm(
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  );
  const impl2: NpmRunner = async (args, opts) => {
    const res = await impl(args, opts);
    if (args[0] !== "install" || !args[1]) return res;
    if (args[1].includes("@9.9.9")) {
      // broken publish: exit 0, but the entry has a syntax error
      fx.writeInstalled("9.9.9", { brokenEntry: true });
    } else if (args[1].includes("@1.2.3")) {
      // rollback: npm puts the working previous version back on disk
      fx.writeInstalled("1.2.3");
    }
    return res;
  };
  setRunNpmForTest(impl2);
  setRunNodeForTest(runNode);
  const outcome = await autoInstallLatest("9.9.9", fx.extDir);
  assert.equal(outcome, "rolled-back");
  const versions = calls.filter((c) => c.args[0] === "install").map((c) => c.args[1]);
  assert.deepEqual(versions, ["billion-context-pi@9.9.9", "billion-context-pi@1.2.3"]);
  // and the disk is back to the working previous version
  const pkg = JSON.parse(readFileSync(join(fx.extDir, "package.json"), "utf-8")) as {
    version: string;
  };
  assert.equal(pkg.version, "1.2.3");
  rmSync(fx.root, { recursive: true, force: true });
});

test("autoInstallLatest: npm install failure → failed, no rollback, no verify", { timeout: 30_000 }, async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.2.3");
  let nodeCalls = 0;
  setRunNpmForTest(makeFakeNpm(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "E404" },
  ).impl);
  setRunNodeForTest(async () => {
    nodeCalls += 1;
    return { code: 0, stdout: "", stderr: "" };
  });
  const outcome = await autoInstallLatest("9.9.9", fx.extDir);
  assert.equal(outcome, "failed");
  assert.equal(nodeCalls, 0);
  rmSync(fx.root, { recursive: true, force: true });
});

// --- read-only (EACCES) handling (issue #267) ---

test("autoInstallLatest: EACCES install failure → read-only outcome + stop-retry marker written", async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.2.3");
  setRunNpmForTest(makeFakeNpm(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "npm error code EACCES\nnpm error syscall open\nnpm error errno -13" },
  ).impl);
  setRunNodeForTest(async () => ({ code: 0, stdout: "", stderr: "" }));
  const outcome = await autoInstallLatest("9.9.9", fx.extDir);
  assert.equal(outcome, "read-only");
  assert.ok(existsSync(readOnlyMarkerFile(fx.extDir)), "stop-retry marker written for the read-only location");
  rmSync(fx.root, { recursive: true, force: true });
});

test("autoInstallLatest: non-permission failure (404) → failed, no stop-retry marker", async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.2.3");
  setRunNpmForTest(makeFakeNpm(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "npm error 404 Not Found - GET" },
  ).impl);
  setRunNodeForTest(async () => ({ code: 0, stdout: "", stderr: "" }));
  const outcome = await autoInstallLatest("9.9.9", fx.extDir);
  assert.equal(outcome, "failed");
  assert.ok(!existsSync(readOnlyMarkerFile(fx.extDir)), "no marker for a non-permission failure");
  rmSync(fx.root, { recursive: true, force: true });
});

test("checkForUpdate: read-only marker present → skips npm view entirely + notifies once per process", async () => {
  resetUpdateStateForTest();
  const extDir = await findExtensionDir();
  assert.ok(extDir, "extension dir resolvable in test");
  mkdirSync(dirname(readOnlyMarkerFile(extDir)), { recursive: true });
  writeFileSync(readOnlyMarkerFile(extDir), String(Date.now()));
  let npmCalls = 0;
  setRunNpmForTest(async () => { npmCalls += 1; return { code: 0, stdout: "", stderr: "" }; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("fetch must not be called for a read-only location"); }) as typeof fetch;
  const notes: string[] = [];
  try {
    await checkForUpdate(true, (m) => notes.push(m));
    await checkForUpdate(true, (m) => notes.push(m));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(readOnlyMarkerFile(extDir), { force: true });
  }
  assert.equal(npmCalls, 0, "no npm view when the install location is read-only");
  assert.equal(notes.length, 1, "notify emitted once per process, not once per check");
  assert.match(notes[0], /npm i -g billion-context-pi/);
});

// --- stale per-location throttle-marker cleanup (#658) ---

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER_RE_LOCAL = /^\.billion-context-pi-update-check-[0-9a-f]{12}$/;

function writeFileAtMtime(path: string, mtimeMs: number): void {
  writeFileSync(path, String(Date.now()));
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

test("cleanupStaleMarkers removes stale (>7d) markers, keeps recent, always keeps active, ignores non-markers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-marker-cleanup-"));
  const now = Date.now();
  const activeName = ".billion-context-pi-update-check-aaaaaaaaaaaa";
  writeFileAtMtime(join(dir, activeName), now - 8 * DAY_MS); // active but ancient → must survive
  writeFileAtMtime(join(dir, ".billion-context-pi-update-check-bbbbbbbbbbbb"), now - 8 * DAY_MS); // stale → removed
  writeFileAtMtime(join(dir, ".billion-context-pi-update-check-cccccccccccc"), now - 1 * DAY_MS); // recent → kept
  writeFileAtMtime(join(dir, ".billion-context-pi-update-check"), now - 30 * DAY_MS); // unsuffixed base → not a marker
  writeFileAtMtime(join(dir, ".billion-context-pi-readonly-dddddddddddd"), now - 30 * DAY_MS); // readonly → untouched
  writeFileAtMtime(join(dir, "unrelated.txt"), now - 30 * DAY_MS); // unrelated → untouched

  const removed = await cleanupStaleMarkers(dir, join(dir, activeName));
  assert.equal(removed, 1);
  assert.ok(existsSync(join(dir, activeName)), "active marker survives even when older than the threshold");
  assert.ok(!existsSync(join(dir, ".billion-context-pi-update-check-bbbbbbbbbbbb")), "stale marker removed");
  assert.ok(existsSync(join(dir, ".billion-context-pi-update-check-cccccccccccc")), "recent marker kept");
  assert.ok(existsSync(join(dir, ".billion-context-pi-update-check")), "unsuffixed base file untouched");
  assert.ok(existsSync(join(dir, ".billion-context-pi-readonly-dddddddddddd")), "readonly marker untouched");
  assert.ok(existsSync(join(dir, "unrelated.txt")), "unrelated file untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("cleanupStaleMarkers leaves near-miss names alone (strict 12-lowercase-hex match)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-marker-cleanup-"));
  const nearMisses = [
    ".billion-context-pi-update-check-abc", // too short
    ".billion-context-pi-update-check-ABCDEF123456", // uppercase hex
    ".billion-context-pi-update-check-1234567890123", // 13 chars
    ".billion-context-pi-update-check-gggggggggggg", // non-hex chars
    ".billion-context-pi-update-check-", // empty suffix
  ];
  for (const n of nearMisses) writeFileAtMtime(join(dir, n), 0); // epoch → maximally old
  const removed = await cleanupStaleMarkers(dir, join(dir, ".billion-context-pi-update-check-zzzzzzzzzzzz"));
  assert.equal(removed, 0);
  for (const n of nearMisses) assert.ok(existsSync(join(dir, n)), `${n} must survive`);
  rmSync(dir, { recursive: true, force: true });
});

test("cleanupStaleMarkers caps non-active markers at MAX_STALE_MARKERS (safety valve)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-marker-cleanup-"));
  const now = Date.now();
  const activeName = ".billion-context-pi-update-check-a1a1a1a1a1a1";
  writeFileAtMtime(join(dir, activeName), now); // active, fresh
  for (let i = 0; i < 60; i++) {
    const name = `.billion-context-pi-update-check-${i.toString(16).padStart(12, "0")}`;
    writeFileAtMtime(join(dir, name), now); // all fresh → age rule alone would keep them all
  }
  const removed = await cleanupStaleMarkers(dir, join(dir, activeName));
  assert.equal(removed, 10, "60 non-active − 50 kept = 10 over-cap removed");
  const remaining = readdirSync(dir).filter((n) => MARKER_RE_LOCAL.test(n));
  assert.equal(remaining.length, 51, "50 non-active + 1 active remain");
  assert.ok(existsSync(join(dir, activeName)));
  rmSync(dir, { recursive: true, force: true });
});

test("checkForUpdate cleans stale markers as part of its lifecycle (wiring)", async () => {
  delete process.env.ACP_AUTO_UPDATE;
  resetThrottle();
  const agentDir = join(FAKE_HOME, CONFIG_DIR_NAME, "agent");
  mkdirSync(agentDir, { recursive: true });
  const staleA = join(agentDir, ".billion-context-pi-update-check-deaddeaddead");
  const staleB = join(agentDir, ".billion-context-pi-update-check-cafebabecafe");
  const recent = join(agentDir, ".billion-context-pi-update-check-0badc0de1234");
  writeFileAtMtime(staleA, 0); // epoch → stale
  writeFileAtMtime(staleB, 0); // epoch → stale
  writeFileAtMtime(recent, Date.now()); // fresh → kept
  setRunNpmForTest(
    makeFakeNpm({ code: 0, stdout: `${REPO_VERSION}\n`, stderr: "" }, { code: 0, stdout: "", stderr: "" }).impl,
  );
  try {
    await checkForUpdate(true);
    assert.ok(!existsSync(staleA), "stale marker cleaned during update check");
    assert.ok(!existsSync(staleB), "stale marker cleaned during update check");
    assert.ok(existsSync(recent), "recent marker preserved");
  } finally {
    for (const p of [staleA, staleB, recent]) rmSync(p, { force: true });
  }
});
