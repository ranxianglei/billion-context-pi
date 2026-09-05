import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { debug, logInfo, logWarn } from "./log.js";

declare const CURRENT_VERSION: string;

const PACKAGE_NAME = "billion-context-pi";
const registryUrl = (tag: string) =>
  `https://registry.npmjs.org/${PACKAGE_NAME}/${encodeURIComponent(tag)}`;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
// Resolved lazily (not at module load) so tests can redirect it via env at any
// time. Without this, parallel test processes race on the real file under the
// user's home dir: one process stamps the throttle timestamp while another has
// just deleted it, making the victim's check skip "npm view" entirely.
const throttleFile = () =>
  process.env.ACP_UPDATE_THROTTLE_FILE ?? join(homedir(), CONFIG_DIR_NAME, "agent", ".billion-context-pi-update-check");

// Guards against concurrent checks: the context event fires on every LLM call,
// so several can race past the throttle read before any writes the timestamp.
let updateInFlight = false;

export type NpmRunner = (
  args: string[],
  opts: { cwd?: string; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runNpm: NpmRunner = async (args, opts) => {
  return new Promise((resolve) => {
    execFile(
      "npm",
      args,
      { ...opts, shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }),
    );
  });
};

let runNpmImpl: NpmRunner = runNpm;

export function setRunNpmForTest(impl: NpmRunner): void {
  runNpmImpl = impl;
}

export type NodeRunner = (
  args: string[],
  opts: { timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Always shell:false: process.execPath is absolute, so no win32 shell quoting
// hazards. Used to smoke-import a freshly installed extension entry.
export const runNode: NodeRunner = (args, opts) => {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { ...opts, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }),
    );
  });
};

let runNodeImpl: NodeRunner = runNode;

export function setRunNodeForTest(impl: NodeRunner): void {
  runNodeImpl = impl;
}

// Test-only override for the installed spec (the channel the user installed
// from). null = not overridden (real discovery). Lets tests exercise the
// non-latest channel path without a full node_modules fixture.
let installedSpecOverride: string | null = null;
export function setInstalledSpecForTest(spec: string | null): void {
  installedSpecOverride = spec;
}

// --- Channel-based auto-update (ported from opencode-acp lib/update.ts) ---
// The updater follows the dist-tag the user installed from, not the global
// `latest`: an @stable install tracks `stable`, @dev tracks `dev`, @pr-N
// tracks `pr-N`, ranges/latest/* track `latest`, and an exact pin never
// auto-updates.

export function isAutoUpdatableSpec(spec: string): boolean {
  const value = spec.trim();
  if (!value) return false;
  if (value === "latest" || value === "*") return true;
  if (/^[~^]/.test(value)) return true;
  if (/^(?:>=|>|<=|<)/.test(value)) return true;
  if (/\s+(?:\|\||-|[<>=])\s+/.test(value)) return true;
  if (isDistTag(value)) return true;
  return false;
}

/**
 * Registry dist-tag the auto-updater should track for a spec.
 * - `stable`, `dev`, `pr-327`, `latest` → that dist-tag
 * - ranges (`^1.2.3`, `>=1.0.0`, `*`) → `latest`
 * - exact pins / non-registry specs → undefined (never auto-update)
 * - exact *prerelease* versions → `latest`: npm records tag installs
 *   (`@pr-N`, `@dev`) as the resolved exact version, so without this
 *   fallback those users would freeze on a stale PR/dev build forever
 */
export function specUpdateTag(spec: string): string | undefined {
  const value = spec.trim();
  if (!isAutoUpdatableSpec(value)) {
    if (/^\d+\.\d+\.\d+-[0-9A-Za-z-.]+$/.test(value)) return "latest";
    return undefined;
  }
  if (value === "*") return "latest";
  if (isDistTag(value)) return value;
  return "latest";
}

function isDistTag(value: string): boolean {
  // npm dist-tag names contain no `/`, `@`, `:`, or whitespace. Anything with
  // those is a path/git/URL spec; a bare exact version (or x-range) is a pin,
  // not a tag.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return false;
  if (parseSemVer(value)) return false;
  if (/\.x(\.|$)/i.test(value)) return false;
  return true;
}

export function isVersionNewer(latest: string, current: string): boolean {
  const next = parseSemVer(latest);
  const prev = parseSemVer(current);
  if (!next || !prev) return false;

  for (let i = 0; i < 3; i++) {
    const a = next.parts[i] ?? 0;
    const b = prev.parts[i] ?? 0;
    if (a !== b) return a > b;
  }

  if (!next.pre.length && prev.pre.length) return true;
  if (next.pre.length && !prev.pre.length) return false;

  for (let i = 0; i < Math.max(next.pre.length, prev.pre.length); i++) {
    const a = next.pre[i];
    const b = prev.pre[i];
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a === b) continue;

    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined;
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber;
    if (aNumber !== undefined) return false;
    if (bNumber !== undefined) return true;
    return a > b;
  }

  return false;
}

function parseSemVer(version: string): { parts: number[]; pre: string[] } | undefined {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/);
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split(".") ?? [],
  };
}

async function readLastCheck(): Promise<number> {
  try {
    const data = await readFile(throttleFile(), "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    await mkdir(dirname(throttleFile()), { recursive: true });
    await writeFile(throttleFile(), String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

type PackageJson = {
  name?: string;
  version?: string;
  main?: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string | { import?: string }>;
  pi?: { extensions?: string[] };
};

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    const data = JSON.parse(await readFile(path, "utf-8"));
    return data && typeof data === "object" ? (data as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

export function findNpmRoot(extDir: string): string | undefined {
  let dir = dirname(extDir);
  for (;;) {
    if (dir.endsWith("node_modules")) return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function findExtensionDir(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = await readPackageJson(join(dir, "package.json"));
    if (pkg?.name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type InstallOutcome = "ok" | "failed" | "rolled-back";

// The declared entries pi/loaders may touch: pi's own extension entry, the
// ESM export, and main. All of them must exist on disk after an install.
function declaredEntries(pkg: PackageJson): string[] {
  const dot = pkg.exports?.["."];
  const exportEntry = typeof dot === "string" ? dot : dot?.import;
  return [...new Set([pkg.pi?.extensions?.[0], exportEntry, pkg.main])]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

// A bad publish (missing dist, syntax error, ABI break) must never strand the
// user: npm's exit code 0 only means "tarball extracted", not "extension
// loads". A broken extension can never load again — and an extension that
// cannot load can never auto-update itself back to health. That is a permanent
// brick, so verify before declaring success: files present, version matches,
// and the entry imports cleanly in a child process.
export async function verifyInstall(
  npmDir: string,
  latest: string,
): Promise<{ ok: boolean; reason?: string }> {
  const dir = join(npmDir, "node_modules", PACKAGE_NAME);
  const pkg = await readPackageJson(join(dir, "package.json"));
  if (!pkg?.version) return { ok: false, reason: "package-json-missing" };
  if (pkg.version !== latest) return { ok: false, reason: `version-mismatch:${pkg.version}` };
  const entries = declaredEntries(pkg);
  if (entries.length === 0) return { ok: false, reason: "no-entry-declared" };
  for (const rel of entries) {
    try {
      await access(join(dir, rel));
    } catch {
      return { ok: false, reason: `entry-missing:${rel}` };
    }
  }
  // Smoke-import the entry pi will actually load. pathToFileURL handles
  // Windows drive letters (a bare "C:\..." import() is parsed as a protocol).
  const smokeEntry = pkg.pi?.extensions?.[0] ?? entries[0];
  if (!smokeEntry) return { ok: false, reason: "no-entry-declared" };
  const entry = join(dir, smokeEntry);
  const SMOKE =
    "const{pathToFileURL}=require('node:url');" +
    "import(pathToFileURL(process.argv[1]).href).then(()=>{}," +
    "(e)=>{console.error(e&&e.stack||e);process.exit(1)})";
  const { code, stderr } = await runNodeImpl(["-e", SMOKE, entry], { timeout: 15_000 });
  if (code !== 0) return { ok: false, reason: `entry-import-failed:${stderr.trim().slice(-500)}` };
  return { ok: true };
}

// extDirOverride exists so tests can point the installer at a fixture layout
// (the test runner itself is never under node_modules, so the real discovery
// always bails at "not-under-node-modules" and the install path would be
// unreachable otherwise).
export async function autoInstallLatest(latest: string, extDirOverride?: string): Promise<InstallOutcome> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) return "failed";
  const extDir = extDirOverride ?? (await findExtensionDir());
  if (!extDir) {
    logWarn("update", { event: "install-skip", reason: "extension-dir-not-found" });
    return "failed";
  }
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) {
    logWarn("update", { event: "install-skip", reason: "not-under-node-modules", extDir });
    return "failed";
  }

  try {
    // --no-save: the host project's package.json/lockfile must never be
    // mutated by an auto-update; node_modules is what pi loads from anyway.
    const installArgs = (v: string) => [
      "install",
      `${PACKAGE_NAME}@${v}`,
      "--silent",
      "--no-audit",
      "--no-fund",
      "--no-save",
    ];
    const prevVersion = (await readPackageJson(join(extDir, "package.json")))?.version ?? CURRENT_VERSION;
    const { code, stderr } = await runNpmImpl(installArgs(latest), { cwd: npmDir, timeout: 60_000 });
    if (code !== 0) {
      logWarn("update", {
        event: "auto-install-failed",
        latest,
        npmDir,
        stderr: stderr.trim().slice(-2000),
      });
      return "failed";
    }
    const verify = await verifyInstall(npmDir, latest);
    if (!verify.ok) {
      // Roll back to what was running before: a broken latest must not sit on
      // disk waiting for the next restart to brick the extension.
      const rollbackTo = SEMVER_RE.test(prevVersion) ? prevVersion : CURRENT_VERSION;
      logWarn("update", { event: "auto-install-verify-failed", latest, reason: verify.reason, rollbackTo });
      const rb = await runNpmImpl(installArgs(rollbackTo), { cwd: npmDir, timeout: 60_000 });
      logInfo("update", { event: "rollback", from: latest, to: rollbackTo, ok: rb.code === 0 });
      return "rolled-back";
    }
    return "ok";
  } catch (e) {
    logWarn("update", {
      event: "auto-install-error",
      latest,
      error: e instanceof Error ? e.message : String(e),
    });
    return "failed";
  }
}

async function fetchLatestVersion(tag: string): Promise<string | undefined> {
  // Prefer `npm view`: it honors the user's registry/proxy/auth config (mirrors,
  // corporate proxies) — the same toolchain as the install step. A direct fetch
  // to registry.npmjs.org fails on machines that only reach npm via a mirror or
  // proxy (Node fetch ignores HTTP_PROXY/HTTPS_PROXY).
  try {
    // `npm view <pkg> version` defaults to the `latest` tag; only pass --tag
    // for a non-latest channel so the default path stays byte-identical.
    const viewArgs = ["view", PACKAGE_NAME, "version"];
    if (tag !== "latest") viewArgs.push("--tag", tag);
    const { code, stdout } = await runNpmImpl(viewArgs, {
      timeout: 20_000,
    });
    if (code === 0) {
      const v = stdout
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (v && SEMVER_RE.test(v)) return v;
    }
  } catch {
  }
  try {
    const res = await fetch(registryUrl(tag), {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      logWarn("update", { event: "check-http", status: res.status });
      return undefined;
    }
    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch (e) {
    logWarn("update", {
      event: "check-fetch-error",
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

export async function checkForUpdate(
  autoUpdate: boolean,
  notify?: (msg: string) => void,
): Promise<void> {
  const envFlag = process.env.ACP_AUTO_UPDATE?.trim().toLowerCase();
  if (
    !autoUpdate ||
    envFlag === "0" ||
    envFlag === "false" ||
    envFlag === "no" ||
    envFlag === "off"
  ) {
    return;
  }
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    const now = Date.now();
    const lastCheck = await readLastCheck();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;

    await writeLastCheck(now);

    const runtimeVersion = await getRuntimeVersion();
    // Follow the channel the user installed from (dist-tag), not the global
    // `latest`: an @stable install tracks `stable`, @dev tracks `dev`, @pr-N
    // tracks `pr-N`, ranges/latest/* track `latest`, an exact stable pin never
    // auto-updates (exact prerelease versions fall back to latest — see
    // specUpdateTag). No recoverable spec (e.g. not under node_modules) → latest.
    const spec = await getInstalledSpec();
    const tag = spec ? specUpdateTag(spec) : "latest";
    if (!tag) {
      debug.event("update-check", { event: "skip", reason: "pinned-spec", spec });
      return;
    }
    const latest = await fetchLatestVersion(tag);
    if (!latest) return;

    const current = runtimeVersion ?? CURRENT_VERSION;
    const hasUpdate = isVersionNewer(latest, current);
    debug.event("update-check", {
      current,
      latest,
      tag,
      hasUpdate,
    });
    logInfo("update", { event: "check", current, latest, hasUpdate });

    if (hasUpdate) {
      const outcome = await autoInstallLatest(latest);
      if (outcome === "ok" && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart Pi to finish.\x1b[0m`,
        );
        logInfo("update", { event: "auto-installed", from: current, to: latest });
      } else if (outcome === "rolled-back" && notify) {
        // Tell the user what happened and DO NOT suggest the manual install
        // hint — latest is known broken, and following the hint would brick
        // the extension by hand.
        notify(
          `\x1b[33mACP ${latest} failed verification and was rolled back. Keeping ${current}. A later release will auto-update.\x1b[0m`,
        );
      } else if (notify) {
        notify(
          `${PACKAGE_NAME} ${latest} available (you have ${current}). Run: pi update --extension npm:${PACKAGE_NAME}`,
        );
      }
    }
  } catch (e) {
    logWarn("update", { event: "check-error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    updateInFlight = false;
  }
}

async function getRuntimeVersion(): Promise<string | undefined> {
  const extDir = await findExtensionDir();
  if (!extDir) return undefined;
  const pkg = await readPackageJson(join(extDir, "package.json"));
  return pkg?.version;
}

// The spec the user installed with, as recorded in the host project's
// package.json dependencies (e.g. `~/.pi/agent/npm/package.json` →
// `"billion-context-pi": "^0.1.46"` or `"stable"`). This is what determines
// which dist-tag channel the auto-updater follows.
async function getInstalledSpec(): Promise<string | undefined> {
  if (installedSpecOverride !== null) return installedSpecOverride;
  const extDir = await findExtensionDir();
  if (!extDir) return undefined;
  const npmRoot = findNpmRoot(extDir);
  if (!npmRoot) return undefined;
  const hostPkg = await readPackageJson(join(npmRoot, "package.json"));
  return hostPkg?.dependencies?.[PACKAGE_NAME];
}
