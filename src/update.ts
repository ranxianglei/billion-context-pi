import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from "./log.js";

declare const CURRENT_VERSION: string;

const PACKAGE_NAME = "pai-acp";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const THROTTLE_FILE = `${process.env.HOME ?? ""}/.pi/agent/.pai-acp-update-check`;

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function readLastCheck(): Promise<number> {
  try {
    const fs = await import("node:fs/promises");
    const data = await fs.readFile(THROTTLE_FILE, "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.dirname(THROTTLE_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(THROTTLE_FILE, String(timestamp), "utf-8");
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

function findNpmRoot(extDir: string): string | undefined {
  let dir = dirname(extDir);
  while (dir !== "/" && dir !== ".") {
    if (dir.endsWith("node_modules")) return dirname(dir);
    dir = dirname(dir);
  }
  return undefined;
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
  const extDir = await findExtensionDir();
  if (!extDir) return false;
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) return false;

  try {
    const npmPkgPath = join(npmDir, "package.json");
    const npmPkg = await readPackageJson(npmPkgPath);
    if (npmPkg?.dependencies?.[PACKAGE_NAME]) {
      npmPkg.dependencies[PACKAGE_NAME] = latest;
      await writeFile(npmPkgPath, JSON.stringify(npmPkg, null, 2) + "\n");
    }

    const { exec } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      exec("npm install --silent --no-audit --no-fund", { cwd: npmDir, timeout: 30_000 }, () => resolve());
    });
    return true;
  } catch {
    return false;
  }
}

export async function checkForUpdate(
  notify?: (msg: string) => void,
): Promise<void> {
  const now = Date.now();
  const lastCheck = await readLastCheck();
  if (now - lastCheck < CHECK_INTERVAL_MS) return;

  await writeLastCheck(now);

  const runtimeVersion = await getRuntimeVersion();

  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return;

    const current = runtimeVersion ?? CURRENT_VERSION;
    debug.event("update-check", {
      current,
      latest,
      hasUpdate: isNewer(latest, current),
    });

    if (isNewer(latest, current)) {
      const installed = await autoInstallLatest(latest);
      if (installed && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart Pi to finish.\x1b[0m`,
        );
      } else if (!installed && notify) {
        notify(
          `${PACKAGE_NAME} ${latest} available (you have ${current}). Run: pi update --extension npm:${PACKAGE_NAME}`,
        );
      }
    }
  } catch {
    // network error, registry down, timeout — silent
  }
}

async function getRuntimeVersion(): Promise<string | undefined> {
  const extDir = await findExtensionDir();
  if (!extDir) return undefined;
  const pkg = await readPackageJson(join(extDir, "package.json"));
  return pkg?.version;
}
