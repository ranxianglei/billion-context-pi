/**
 * One-shot setup: inject ACP context tools into pi-subagents' agent overrides.
 * Invoked explicitly via the `/acp-subagents` command — never at session
 * start, so global settings.json is only ever touched on user request.
 *
 * pi-subagents' agentOverrides merge semantics REPLACE the frontmatter
 * `tools` list, so an override without ACP tools strips them from the
 * builtin agents. This module detects an installed pi-subagents package,
 * discovers each builtin agent's frontmatter tools, and writes
 * `subagents.agentOverrides[name].tools = frontmatter tools + ACP tools`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "./config-dir.js";

/** The four ACP tools to ensure on every pi-subagents builtin agent. */
export const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"] as const;

export interface SetupResult {
  path: string;
  action: "skipped" | "updated" | "failed";
  reason?: string;
}

export interface SetupOptions {
  /** Injectable agent directory (defaults to env PI_CODING_AGENT_DIR or ~/.pi/agent). */
  agentDir?: string;
  /** Injectable cwd for project-scope detection (defaults to process.cwd()). */
  cwd?: string;
  /** Explicit install directory (skips detection; for git installs or forks). */
  installDir?: string;
}

/**
 * Resolve the pi agent config directory (e.g. ~/.pi/agent), honoring the
 * PI_CODING_AGENT_DIR environment variable (mirroring pi's own resolution).
 */
export function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return os.homedir();
    if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

interface AgentOverride {
  model?: string;
  tools?: string[];
  thinking?: string;
}

interface ParsedBuiltin {
  name: string;
  /** Frontmatter `tools` list; undefined when the agent is unrestricted. */
  tools?: string[];
}

function parseFrontmatterTools(content: string): ParsedBuiltin | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const body = match[1];
  if (!body) return null;
  let name: string | undefined;
  let tools: string[] | undefined;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("name:")) {
      name = line.slice(5).trim().replace(/^["']|["']$/g, "");
    } else if (line.startsWith("tools:")) {
      const value = line.slice(6).trim();
      if (value) {
        tools = value.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      }
    }
  }
  if (!name) return null;
  return tools ? { name, tools } : { name };
}

/**
 * Detect an installed pi-subagents package and return its directory, or null
 * when no installation is found.
 *
 * Checked in priority order:
 *  1. user-scope npm install:    <agentDir>/npm/node_modules/pi-subagents
 *  2. project-scope npm install: <cwd>/.pi/npm/node_modules/pi-subagents
 *  3. user-scope extension dir:  <agentDir>/extensions/<name>/package.json where name === "pi-subagents"
 *  4. project-scope extension dir: <cwd>/.pi/extensions/<name>/package.json
 *
 * Git installs and the legacy global npm location are intentionally not
 * checked: a miss there is a safe no-op (ACP tools stay un-injected).
 */
export function findPiSubagentsInstall(agentDir: string, cwd: string): string | null {
  const candidates: string[] = [
    path.join(agentDir, "npm", "node_modules", "pi-subagents"),
    path.join(cwd, CONFIG_DIR_NAME, "npm", "node_modules", "pi-subagents"),
  ];
  const extensionRoots = [
    path.join(agentDir, "extensions"),
    path.join(cwd, CONFIG_DIR_NAME, "extensions"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  for (const root of extensionRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(root, entry.name, "package.json");
      try {
        if (JSON.parse(fs.readFileSync(pkgPath, "utf-8")).name === "pi-subagents") {
          return path.join(root, entry.name);
        }
      } catch {
        // Not a readable package — keep scanning.
      }
    }
  }
  return null;
}

/**
 * Discover the builtin agents shipped by the detected pi-subagents package
 * from its agents/*.md frontmatter (name + tools). Returns an empty list
 * when the package ships no agents directory.
 */
export function discoverBuiltinAgents(installDir: string): ParsedBuiltin[] {
  const agentsDir = path.join(installDir, "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const parsed: ParsedBuiltin[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const result = parseFrontmatterTools(fs.readFileSync(path.join(agentsDir, entry.name), "utf-8"));
      if (result) parsed.push(result);
    } catch {
      // Unreadable agent file — skip it.
    }
  }
  return parsed;
}

/** Frontmatter tools + ACP tools, preserving order and removing duplicates. */
function desiredTools(baseTools: string[] | undefined): string[] {
  const tools = baseTools ? [...baseTools] : [];
  for (const tool of ACP_TOOLS) {
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools;
}

/**
 * Ensure ACP context tools are present in pi-subagents' agent overrides.
 * No-op (skipped) unless a pi-subagents installation is detected.
 */
export function ensureSubagentAcpTools(settingsPath?: string, options?: SetupOptions): SetupResult {
  const agentDir = options?.agentDir ?? resolveAgentDir();
  const cwd = options?.cwd ?? process.cwd();
  const path_ = settingsPath ?? path.join(agentDir, "settings.json");

  let installDir: string;
  if (options?.installDir) {
    installDir = path.resolve(options.installDir);
    if (!fs.existsSync(path.join(installDir, "package.json"))) {
      return { path: path_, action: "failed", reason: `not a package: ${installDir}` };
    }
  } else {
    const detected = findPiSubagentsInstall(agentDir, cwd);
    if (!detected) {
      return { path: path_, action: "skipped", reason: "pi-subagents not installed" };
    }
    installDir = detected;
  }
  const builtins = discoverBuiltinAgents(installDir);
  if (builtins.length === 0) {
    return { path: path_, action: "skipped", reason: "pi-subagents ships no agents/*.md" };
  }

  let settingsRaw: string;
  try {
    settingsRaw = fs.readFileSync(path_, "utf-8");
  } catch {
    return { path: path_, action: "skipped", reason: "not found" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(settingsRaw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      return { path: path_, action: "failed", reason: "settings.json root is not an object" };
    }
  } catch {
    return { path: path_, action: "failed", reason: "settings.json is not valid JSON" };
  }

  const subagents = (typeof settings.subagents === "object" && settings.subagents !== null
    ? settings.subagents
    : {}) as Record<string, unknown>;
  const existingOverrides = (typeof subagents.agentOverrides === "object" && subagents.agentOverrides !== null
    ? subagents.agentOverrides
    : {}) as Record<string, AgentOverride | undefined>;

  let changed = false;
  const overrides: Record<string, AgentOverride> = {};
  for (const [name, existing] of Object.entries(existingOverrides)) overrides[name] = existing ?? {};

  // Only patch agents the installed pi-subagents actually ships. Agents that
  // are unrestricted (no frontmatter tools) already have every tool — skip.
  const frontmatterByName = new Map(builtins.map((b) => [b.name, b.tools]));
  for (const name of builtins.map((b) => b.name)) {
    const existing = overrides[name];
    const baseTools =
      existing?.tools && Array.isArray(existing.tools) && existing.tools.length > 0
        ? existing.tools
        : frontmatterByName.get(name);
    if (baseTools === undefined) continue; // Unrestricted agent — nothing to grant.
    const wanted = desiredTools(baseTools);
    const current = existing?.tools;
    if (
      Array.isArray(current) &&
      current.length > 0 &&
      wanted.every((tool) => current.includes(tool))
    ) {
      continue; // Already complete — keep the existing list untouched.
    }
    overrides[name] = { ...existing, tools: wanted };
    changed = true;
  }

  if (!changed) {
    return { path: path_, action: "skipped", reason: "already have ACP tools" };
  }

  subagents.agentOverrides = overrides;
  settings.subagents = subagents;

  // Write with backup + verify, never leaving settings.json invalid.
  const backupPath = `${path_}.acp-bak`;
  try {
    if (!fs.existsSync(backupPath)) fs.copyFileSync(path_, backupPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: path_, action: "failed", reason: `backup failed: ${message}` };
  }

  const expectedMtimeMs = fs.statSync(path_).mtimeMs;
  const tmpPath = `${path_}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    // Guard against concurrent modification between read and write.
    if (fs.statSync(path_).mtimeMs !== expectedMtimeMs) {
      fs.unlinkSync(tmpPath);
      return { path: path_, action: "failed", reason: "settings.json changed during write" };
    }
    fs.renameSync(tmpPath, path_);

    // Post-write sanity check: settings.json still valid and overrides intact.
    const written = JSON.parse(fs.readFileSync(path_, "utf-8")) as Record<string, unknown>;
    const writtenSub = written.subagents as Record<string, unknown> | undefined;
    const writtenOverrides = (writtenSub?.agentOverrides ?? {}) as Record<string, AgentOverride | undefined>;
    for (const b of builtins) {
      const entry = writtenOverrides[b.name];
      const tools = entry?.tools ?? [];
      if (frontmatterByName.get(b.name) !== undefined && !ACP_TOOLS.every((t) => tools.includes(t))) {
        fs.copyFileSync(backupPath, path_);
        return { path: path_, action: "failed", reason: "post-write verification failed" };
      }
    }
    return { path: path_, action: "updated" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (fs.existsSync(backupPath)) {
      try { fs.copyFileSync(backupPath, path_); } catch { /* ignore restore failure */ }
    }
    return { path: path_, action: "failed", reason: message };
  }
}
