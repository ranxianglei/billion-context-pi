import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import type { Prompts } from "acp-kernel";
import type { AdapterConfig, CompressConfig, DelegateConfig, HostSessionConfig, RepetitionGuardConfig } from "./config.js";
import type { PiPromptSections } from "./system-prompt.js";
import type { NudgeSectionsConfig, ToolPromptsConfig } from "./surface.js";
import type { DegenerationGuardConfig } from "./degeneration.js";
import type { ThrottleRetryConfig } from "./throttle-retry.js";
import { debug } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  enabled?: boolean;
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  protectedTools?: string[];
  protectedLatestTools?: string[];
  neverPreserveRecentTools?: string[];
  preserveRecentTools?: string[];
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
  rules?: boolean;
}

/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. Malformed-but-repairable
 *  files are salvaged with a loud warning instead of silently meaning "not
 *  disabled" / "no config" (#467). */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const merged: UserAcpConfig = {};
  for (const base of [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const r = parseAcpJson(file, raw);
    if (r.status === "failed") {
      console.warn(`[bcp] ${r.reason}`);
      continue;
    }
    if (r.status === "repaired") {
      console.warn(`[bcp] ${r.reason}`);
    }
    if (r.value && typeof r.value === "object") {
      Object.assign(merged, pickKnown(r.value));
      debug.event("config-loaded", { file });
    }
  }
  return merged;
}

export interface AcpJsonParse {
  status: "ok" | "repaired" | "failed";
  value?: Record<string, unknown>;
  reason?: string;
}

/** Lenient parse of a hand-edited acp.json (#467): strict JSON first, then
 *  repair the common hand-edit shapes (BOM head, trailing commas, unquoted
 *  keys) with a loud warning, then give up with a diagnosed reason. The
 *  enabled:false master switch must survive a notepad edit — silently
 *  treating the user's file as absent is the exact opposite of intent. */
export function parseAcpJson(file: string, raw: string): AcpJsonParse {
  const stripped = raw.replace(/^\uFEFF/, "");
  const strict = tryJson(stripped);
  if (strict.ok) return { status: "ok", value: strict.value };
  const repaired = tryJson(
    stripped
      .replace(/,(?=\s*[}\]])/g, "")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3'),
  );
  if (repaired.ok) {
    return {
      status: "repaired",
      value: repaired.value,
      reason: `${file}: repaired non-strict JSON (BOM / unquoted keys / trailing commas) — prefer strict JSON so future config stays portable`,
    };
  }
  return { status: "failed", reason: `${file}: failed to parse (${diagnoseJsonFailure(stripped, strict.error)}) — fix the file; this acp.json is ignored` };
}

function tryJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown } {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? { ok: true, value: v as Record<string, unknown> } : { ok: false, error: new Error("top-level value is not an object") };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// Ordered heuristics: most specific common cause first, parser msg as fallback.
function diagnoseJsonFailure(raw: string, err: unknown): string {
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

function join(... parts: string[]): string {
  return path.join(...parts);
}

const KNOWN = new Set([
  "enabled", "debug", "autoUpdate", "modelContextLimit",
  "protectedTools", "protectedLatestTools", "neverPreserveRecentTools", "preserveRecentTools",
  "toolBashDefaultTimeout", "toolOutputMaxBytes",
  "delegate", "compress", "displayUsage", "throttleRetry",
  "outputHeadroomMaxPct",
  "repetitionGuard", "degenerationGuard",
  "prompts", "acknowledgePromptsRisk",
  "promptSections", "nudgeSections", "toolPrompts", "delegatePrompt",
  "hostSession", "rules",
]);

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. The two
 *  protection keys are shape-checked here because acp.json is hand-edited JSON
 *  and a malformed value must warn + fall back, never fail the session or feed
 *  garbage to the kernel (#499). */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  const result: AdapterConfig = {
    ...adapter,
    ...user,
    coreOverrides: adapter.coreOverrides,
    preserveRecentMessages: adapter.preserveRecentMessages,
  };
  for (const key of ["protectedTools", "protectedLatestTools"] as const) {
    if (!(key in user)) continue;
    const cleaned = cleanProtectionList(key, user[key]);
    if (cleaned !== undefined) result[key] = cleaned;
    else if (adapter[key] !== undefined) result[key] = adapter[key];
    else delete result[key];
  }
  // neverPreserveRecentTools is validated separately from the two protection
  // keys: an EMPTY ARRAY IS VALID here (max-protection escape hatch — the
  // kernel built-in list stops excluding anything), so it must not ride the
  // non-empty-array check above (bili #1277).
  if ("neverPreserveRecentTools" in user) {
    const cleaned = cleanNeverPreserveList(user.neverPreserveRecentTools);
    if (cleaned !== undefined) result.neverPreserveRecentTools = cleaned;
    else if (adapter.neverPreserveRecentTools !== undefined) result.neverPreserveRecentTools = adapter.neverPreserveRecentTools;
    else delete result.neverPreserveRecentTools;
  }
  // preserveRecentTools is the positive counterpart: patterns REMOVED from
  // the effective exclusion list (kernel >= 0.0.93). An empty array would be
  // a pure no-op — reject it like the protection keys, since a bare [] here
  // is almost certainly a typo for neverPreserveRecentTools: [] (bili #1277).
  if ("preserveRecentTools" in user) {
    const cleaned = cleanPreserveRecentList(user.preserveRecentTools);
    if (cleaned !== undefined) result.preserveRecentTools = cleaned;
    else if (adapter.preserveRecentTools !== undefined) result.preserveRecentTools = adapter.preserveRecentTools;
    else delete result.preserveRecentTools;
  }
  return result;
}

function cleanPreserveRecentList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    console.warn(`[bcp] acp.json "preserveRecentTools" must be a non-empty array of non-empty strings (an empty array is a no-op — for protect-everything use neverPreserveRecentTools: []) — ignoring the value`);
    return undefined;
  }
  return value.map((v) => v.trim());
}

function cleanNeverPreserveList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    console.warn(`[bcp] acp.json "neverPreserveRecentTools" must be an array of non-empty strings (empty array allowed — protects everything) — ignoring the value`);
    return undefined;
  }
  return value.map((v) => v.trim());
}

function cleanProtectionList(key: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    console.warn(`[bcp] acp.json "${key}" must be a non-empty array of non-empty strings — ignoring the value`);
    return undefined;
  }
  return value.map((v) => v.trim());
}
