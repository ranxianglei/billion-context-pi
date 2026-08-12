import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AdapterConfig } from "./config.js";
import { debug, logWarn } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  delegate?: boolean;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
/** 上下文水位触发压缩提示的百分比（0-100，默认 25，0=禁用）——见 AdapterConfig.usageTriggerPercent */
  usageTriggerPercent?: number;
  /** 界面语言（slash 命令输出 / nudge 附加文本）："zh" | "en"，缺省按 LANG 检测 */
  language?: "zh" | "en";
}

/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const merged: UserAcpConfig = {};
  for (const base of [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(merged, pickKnown(parsed));
        debug.event("config-loaded", { file });
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

function join(... parts: string[]): string {
  return path.join(...parts);
}

const KNOWN: Record<string, "boolean" | "number" | "string"> = {
  debug: "boolean",
  autoUpdate: "boolean",
  modelContextLimit: "number",
  delegate: "boolean",
  toolBashDefaultTimeout: "number",
  toolOutputMaxBytes: "number",
  usageTriggerPercent: "number",
  language: "string",
};

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    // Type-check known keys: {"debug": "false"} is a string and must not
    // truthily enable debug, and a string modelContextLimit would leak into
    // the kernel's Config untouched.
    const t = KNOWN[k];
    if (t && typeof v === t) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  return {
    ...adapter,
    ...user,
    // coreOverrides / protectedTools / preserveRecentMessages are not overridable
    // from acp.json (keep them from the factory config).
    coreOverrides: adapter.coreOverrides,
    protectedTools: adapter.protectedTools,
    preserveRecentMessages: adapter.preserveRecentMessages,
  };
}
