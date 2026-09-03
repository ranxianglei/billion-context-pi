import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Prompts } from "acp-kernel";
import type { AdapterConfig, CompressConfig, DelegateConfig } from "./config.js";
import type { ThrottleRetryConfig } from "./throttle-retry.js";
import { debug, logWarn } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  <agentDir>/acp.json (global, e.g. ~/.pi/agent/acp.json) and
 *  <cwd>/.pi/agent/acp.json (project-local). Project wins over global per-field.
 *  Legacy locations (~/.pi/acp.json, <cwd>/.pi/acp.json) are still read as a
 *  fallback for backward compatibility (issue #231). */
export interface UserAcpConfig {
  enabled?: boolean;
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
  delegate?: boolean | DelegateConfig;
  compress?: CompressConfig;
  throttleRetry?: boolean | ThrottleRetryConfig;
  displayUsage?: "merged" | "separate";
  prompts?: Partial<Prompts>;
  acknowledgePromptsRisk?: boolean;
}

/** Read global + project acp.json, project overrides global per-field. Returns
 *  {} on any error (missing file, bad JSON) — never throws.
 *
 *  Locations (issue #231): the canonical config now lives under the agent dir —
 *  global at <agentDir>/acp.json (e.g. ~/.pi/agent/acp.json), project at
 *  <cwd>/.pi/agent/acp.json. The legacy locations (~/.pi/acp.json and
 *  <cwd>/.pi/acp.json) remain readable so existing setups keep working: when the
 *  new location is absent the legacy file is used, and the new location wins when
 *  both are present. No files are written — to move an existing config, copy it
 *  to the new location (see CONFIGURATION.md). */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const scopes: { name: "global" | "project"; fresh: string; legacy: string }[] = [
    {
      name: "global",
      fresh: path.join(getAgentDir(), CONFIG_FILE_NAME),
      legacy: path.join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    },
    {
      name: "project",
      fresh: path.join(cwd, CONFIG_DIR_NAME, "agent", CONFIG_FILE_NAME),
      legacy: path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    },
  ];
  const merged: UserAcpConfig = {};
  for (const scope of scopes) {
    const file = await resolveConfigFile(scope);
    if (!file) continue;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(merged, pickKnown(parsed));
        debug.event("config-loaded", { file, scope: scope.name });
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logWarn("config", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return merged;
}

const CONFIG_FILE_NAME = "acp.json";

/** Pick the effective config file for a scope: prefer the fresh (agent-dir)
 *  location; fall back to the legacy location when the fresh one is absent.
 *  Returns the path to read, or null when neither location exists. */
async function resolveConfigFile(scope: { fresh: string; legacy: string }): Promise<string | null> {
  if (await fileExists(scope.fresh)) return scope.fresh;
  if (await fileExists(scope.legacy)) return scope.legacy;
  return null;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const KNOWN = new Set([
  "enabled", "debug", "autoUpdate", "modelContextLimit",
  "toolBashDefaultTimeout", "toolOutputMaxBytes",
  "delegate", "compress", "displayUsage", "throttleRetry",
  "prompts", "acknowledgePromptsRisk",
]);

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  return {
    ...adapter,
    ...user,
    coreOverrides: adapter.coreOverrides,
    protectedTools: adapter.protectedTools,
    preserveRecentMessages: adapter.preserveRecentMessages,
  };
}
