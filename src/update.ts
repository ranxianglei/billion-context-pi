import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { debug, logInfo, logWarn } from "./log.js";

declare const CURRENT_VERSION: string;

const PACKAGE_NAME = "billion-context-pi";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
// Spec (AGENTS.md §2.5): npm registry check throttled to 6h. The context event
// fires on every LLM call, so the throttle is what makes this cheap.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const THROTTLE_FILE = join(homedir(), CONFIG_DIR_NAME, "agent", ".billion-context-pi-update-check");

// Guards against concurrent checks: the context event fires on every LLM call,
// so several can race past the throttle read before any writes the timestamp.
let updateInFlight = false;

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  // Same x.y.z: a release beats a prerelease; a prerelease is never "newer".
  const lPre = /^\d+\.\d+\.\d+-/.test(latest.replace(/^v/, ""));
  const cPre = /^\d+\.\d+\.\d+-/.test(current.replace(/^v/, ""));
  return !lPre && cPre;
}

async function readLastCheck(): Promise<number> {
  try {
    const data = await readFile(THROTTLE_FILE, "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    await mkdir(dirname(THROTTLE_FILE), { recursive: true });
    await writeFile(THROTTLE_FILE, String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
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

async function autoInstallLatest(latest: string): Promise<boolean> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) return false;
  const extDir = await findExtensionDir();
  if (!extDir) return false;
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) return false;

  try {
    const code = await new Promise<number>((resolve) => {
      execFile(
        "npm",
        ["install", `${PACKAGE_NAME}@${latest}`, "--silent", "--no-audit", "--no-fund"],
        { cwd: npmDir, timeout: 60_000, shell: process.platform === "win32" },
        (err) => resolve(err ? 1 : 0),
      );
    });
    return code === 0;
  } catch {
    return false;
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

    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      logWarn("update", { event: "check-http", status: res.status });
      return;
    }
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return;

    const current = runtimeVersion ?? CURRENT_VERSION;
    const hasUpdate = isNewer(latest, current);
    debug.event("update-check", {
      current,
      latest,
      hasUpdate,
    });
    logInfo("update", { event: "check", current, latest, hasUpdate });

    if (hasUpdate) {
      const installed = await autoInstallLatest(latest);
      if (installed && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart Pi to finish.\x1b[0m`,
        );
        logInfo("update", { event: "auto-installed", from: current, to: latest });
      } else if (!installed && notify) {
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
