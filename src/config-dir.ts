import * as piModule from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export type HostConfigSurface = { CONFIG_DIR_NAME?: unknown; getAgentDir?: unknown };

/** Pi's name — the fallback, and what releases before fork-host resolution used on every host. */
export const PI_CONFIG_DIR_NAME = ".pi";

function isDirName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

function dirNameFromAgentDir(getAgentDir: unknown, home: string): string | undefined {
  if (typeof getAgentDir !== "function") return undefined;
  let agentDir: unknown;
  try {
    agentDir = getAgentDir();
  } catch {
    return undefined;
  }
  if (typeof agentDir !== "string" || agentDir.length === 0) return undefined;
  const resolved = path.resolve(agentDir);
  if (path.basename(resolved) !== "agent") return undefined;
  const root = path.dirname(resolved);
  if (path.dirname(root) !== path.resolve(home)) return undefined;
  const name = path.basename(root);
  return isDirName(name) ? name : undefined;
}

/**
 * Config directory name, resolved from the host package the extension runs under.
 *
 * Every path in this adapter is `<home|cwd>/<name>/…`, with the agent dir at
 * `~/<name>/agent` — Pi's layout, where CONFIG_DIR_NAME is ".pi". Resolution order:
 * 1. the host's CONFIG_DIR_NAME, if it is a single directory name (Pi);
 * 2. the parent of the host's getAgentDir(), if that is `~/<name>/agent` — Pi forks
 *    that do not re-export CONFIG_DIR_NAME, or export it with other semantics (Prime:
 *    CONFIG_DIR_NAME ".prime/agent", getAgentDir() ~/.prime/agent → ".prime");
 * 3. ".pi".
 * The namespace import is deliberate: a missing named export fails at link time
 * under plain Node ESM→CJS interop and as `undefined` under loader aliasing (#364).
 * It is the ONLY value import from the pi package. See docs/host-adapter.md §4.
 */
export function resolveConfigDirName(host: HostConfigSurface, home: string): string {
  if (isDirName(host.CONFIG_DIR_NAME)) return host.CONFIG_DIR_NAME;
  return dirNameFromAgentDir(host.getAgentDir, home) ?? PI_CONFIG_DIR_NAME;
}

export const CONFIG_DIR_NAME: string = resolveConfigDirName(piModule as unknown as HostConfigSurface, homedir());

/**
 * `<root>/<name>/<segments>` for a user-authored file (acp.json, prompt packs). When
 * `name` is not ".pi", an existing `<root>/.pi/<segments>` is still used while the
 * host's own path does not exist: earlier releases read ".pi" on every host, and Prime
 * users were told to put acp.json there (#467).
 */
export function userConfigPathIn(name: string, root: string, ...segments: string[]): string {
  const own = path.join(root, name, ...segments);
  if (name === PI_CONFIG_DIR_NAME || existsSync(own)) return own;
  const legacy = path.join(root, PI_CONFIG_DIR_NAME, ...segments);
  return existsSync(legacy) ? legacy : own;
}

export function userConfigPath(root: string, ...segments: string[]): string {
  return userConfigPathIn(CONFIG_DIR_NAME, root, ...segments);
}

/** Global then project acp.json; later entries override earlier ones. */
export function acpJsonFiles(cwd: string): string[] {
  return [userConfigPath(homedir(), "acp.json"), userConfigPath(cwd, "acp.json")];
}
