import { readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import type { Prompts } from "acp-kernel";
import type { AdapterConfig, CompressConfig, DelegateConfig, HostSessionConfig, RepetitionGuardConfig } from "./config.js";
import type { PiPromptSections } from "./system-prompt.js";
import type { NudgeSectionsConfig, ToolPromptsConfig } from "./surface.js";
import type { DegenerationGuardConfig } from "./degeneration.js";
import type { ThrottleRetryConfig } from "./throttle-retry.js";
import { debug, logWarn } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  enabled?: boolean;
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
  delegate?: boolean | DelegateConfig;
  compress?: CompressConfig;
  outputHeadroomMaxPct?: number | string;
  throttleRetry?: boolean | ThrottleRetryConfig;
  repetitionGuard?: boolean | RepetitionGuardConfig;
  degenerationGuard?: boolean | DegenerationGuardConfig;
  displayUsage?: "merged" | "separate";
  prompts?: Partial<Prompts>;
  acknowledgePromptsRisk?: boolean;
  promptSections?: PiPromptSections;
  nudgeSections?: NudgeSectionsConfig;
  toolPrompts?: ToolPromptsConfig;
  delegatePrompt?: string | null;
  hostSession?: boolean | HostSessionConfig;
}

export type AcpFileStatus = "missing" | "ok" | "failed";
export type AcpFileScope = "global" | "project";

export interface AcpFileResult {
  file: string;
  scope: AcpFileScope;
  status: AcpFileStatus;
  /** only when status === "failed" */
  reason?: string;
  /** only when status === "ok" */
  value?: Record<string, unknown>;
}

function join(... parts: string[]): string {
  return path.join(...parts);
}

// Ordered regex heuristics: most specific common cause first, parser msg as fallback.
export function diagnoseJsonFailure(raw: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    return 'file starts with a BOM (byte-order mark); save it as plain UTF-8 without BOM (Windows Notepad → Save as → encoding "UTF-8", not "UTF-8 with BOM")';
  }
  if (/\,\s*[}\]]/.test(raw)) {
    return "trailing comma is not allowed in JSON (remove the last comma before } or ])";
  }
  if (/\/\/|\/\*/.test(raw)) {
    return "comments are not allowed in JSON (delete // and /* */ lines)";
  }
  if (/property name/i.test(msg)) {
    return 'object keys must be wrapped in double quotes (write "enabled": false, not enabled: false)';
  }
  if (/Unexpected token/i.test(msg)) {
    return `invalid JSON syntax (${msg})`;
  }
  return msg;
}

export function readAcpFiles(cwd: string): AcpFileResult[] {
  const home = homedir();
  return [
    readAcpFile(join(home, CONFIG_DIR_NAME, "acp.json"), "global"),
    readAcpFile(join(cwd, CONFIG_DIR_NAME, "acp.json"), "project"),
  ];
}

function readAcpFile(file: string, scope: AcpFileScope): AcpFileResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file, scope, status: "missing" };
    return { file, scope, status: "failed", reason: `cannot read file: ${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { file, scope, status: "failed", reason: diagnoseJsonFailure(raw, e) };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { file, scope, status: "ok", value: parsed as Record<string, unknown> };
  }
  return { file, scope, status: "failed", reason: `top-level JSON must be an object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}` };
}

// Project overrides global; only a literal boolean counts; missing/failed ignored.
export function resolveAcpDisabled(files: AcpFileResult[]): boolean {
  let disabled: boolean | undefined;
  for (const f of files) {
    if (f.status !== "ok" || !f.value) continue;
    const v = f.value.enabled;
    if (v === true || v === false) disabled = v;
  }
  return disabled === false;
}

export function enabledTypeHint(files: AcpFileResult[]): string | null {
  const problems: string[] = [];
  for (const f of files) {
    if (f.status !== "ok" || !f.value) continue;
    if (!("enabled" in f.value)) continue;
    const v = f.value.enabled;
    if (typeof v !== "boolean") {
      problems.push(`${f.file}: "enabled" must be a boolean (true/false), got ${JSON.stringify(v)}`);
    }
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

// Project overrides global; returns {} on any per-file error (never throws).
// Failed files log a `load-failed` warn carrying the diagnosed reason (#467).
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const merged: UserAcpConfig = {};
  for (const f of readAcpFiles(cwd)) {
    if (f.status === "ok" && f.value) {
      Object.assign(merged, pickKnown(f.value));
      debug.event("config-loaded", { file: f.file });
    } else if (f.status === "failed") {
      logWarn("config", { event: "load-failed", scope: f.scope, file: f.file, error: f.reason });
    }
  }
  return merged;
}

const KNOWN = new Set([
  "enabled", "debug", "autoUpdate", "modelContextLimit",
  "toolBashDefaultTimeout", "toolOutputMaxBytes",
  "delegate", "compress", "displayUsage", "throttleRetry",
  "outputHeadroomMaxPct",
  "repetitionGuard", "degenerationGuard",
  "prompts", "acknowledgePromptsRisk",
  "promptSections", "nudgeSections", "toolPrompts", "delegatePrompt",
  "hostSession",
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
