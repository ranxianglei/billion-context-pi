import * as path from "node:path";
import { homedir } from "node:os";
import * as piModule from "@earendil-works/pi-coding-agent";

type PiNamespace = { CONFIG_DIR_NAME?: unknown; getAgentDir?: unknown };

/** The single-segment dir every host used before fork-aware resolution (#364/#467). */
export const LEGACY_CONFIG_DIR_NAME = ".pi";

function isSingleSegmentName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("/") && !v.includes("\\") && v !== "." && v !== "..";
}

/**
 * Resolve the config dir name from a host namespace (#574):
 * 1. the host's `CONFIG_DIR_NAME` export is a single-segment dir name -> use it (Pi: ".pi");
 * 2. else the host's `getAgentDir()` is exactly `<home>/<name>/agent` -> use `<name>`
 *    (Prime exports no CONFIG_DIR_NAME, and its internal constant is ".prime/agent" — the
 *    agent dir itself — so re-exporting it verbatim would join paths to <agentDir>/agent);
 * 3. else -> the canonical ".pi".
 */
export function resolveConfigDirName(host: PiNamespace, home: string): string {
  if (isSingleSegmentName(host.CONFIG_DIR_NAME)) return host.CONFIG_DIR_NAME;
  if (typeof host.getAgentDir === "function") {
    try {
      const agentDir = (host.getAgentDir as () => unknown)();
      if (typeof agentDir === "string") {
        const rel = path.relative(path.resolve(home), path.resolve(agentDir));
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
          const parts = rel.split(path.sep);
          if (parts.length === 2 && parts[1] === "agent" && isSingleSegmentName(parts[0])) return parts[0];
        }
      }
    } catch {
      // a throwing getAgentDir must not break extension loading — fall through
    }
  }
  return LEGACY_CONFIG_DIR_NAME;
}

/**
 * Config directory name with a host feature-detection fallback (#364, #574).
 *
 * Pi exports CONFIG_DIR_NAME (".pi"). Hosts that alias the pi package to their own build
 * (e.g. Prime) may not re-export it. A static named import of it fails differently per
 * resolver — link-time SyntaxError under plain Node ESM→CJS interop, or `undefined` at
 * runtime (which then breaks `path.join()`) under loader-based aliasing — so this module
 * uses a namespace import (safe in both cases) and resolves the dir name through
 * resolveConfigDirName(), which also derives the name from the host's getAgentDir()
 * shape when the export is absent. It is the ONLY value import from the pi package;
 * everything else is type-only.
 * Contract & responsibility boundary: docs/host-adapter.md → "Config directory".
 */
export const CONFIG_DIR_NAME: string = resolveConfigDirName(piModule as unknown as PiNamespace, homedir());

/**
 * Base dirs for hand-written user files (acp.json, acp/packs), per scope (#574). Every
 * host used ".pi" before fork-aware resolution, so on a host that resolves to its own dir
 * the legacy ".pi" dir trails the primary one as a second candidate in each scope.
 * Callers try the candidates in order WITHIN a scope — the first usable candidate stands
 * for that scope — and later scopes override earlier ones (project over global).
 * Plugin-written paths (log, agent-dir markers, install probes) never use this list; they
 * go straight to the host's own dir without legacy fallback.
 */
export function userFileBases(
  cwd: string,
  dirName: string = CONFIG_DIR_NAME,
): { global: string[]; project: string[] } {
  const bases = (root: string): string[] =>
    dirName === LEGACY_CONFIG_DIR_NAME
      ? [path.join(root, LEGACY_CONFIG_DIR_NAME)]
      : [path.join(root, dirName), path.join(root, LEGACY_CONFIG_DIR_NAME)];
  return { global: bases(homedir()), project: bases(cwd) };
}
