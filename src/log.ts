import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 10 * 1024 * 1024;

const ENV_DEBUG =
  process.env.ACP_DEBUG === "1" || process.env.ACP_DEBUG === "true";

function resolveLogFile(): string {
  return process.env.ACP_LOG_FILE ?? path.join(homedir(), CONFIG_DIR_NAME, "acp.log");
}

let runtimeDebug: boolean | null = null;

export function setDebugEnabled(enabled: boolean): void {
  runtimeDebug = enabled;
}

function debugOn(): boolean {
  return runtimeDebug ?? ENV_DEBUG;
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function ts(): string {
  return new Date().toISOString();
}

function writeLine(level: string, scope: string, fields: Record<string, unknown>): void {
  const file = resolveLogFile();
  try {
    if (existsSync(file) && statSync(file).size >= MAX_BYTES) {
      const old = file + ".old";
      // Keep the previous generation instead of silently overwriting it.
      if (existsSync(old)) renameSync(old, `${old}.${Date.now()}`);
      renameSync(file, old);
    }
  } catch {
  }
  const body = Object.keys(fields)
    .map((k) => `${k}=${fmt(fields[k])}`)
    .join(" ");
  const line = `${ts()} [${level}] [${scope}] ${body}\n`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, line);
  } catch {
  }
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export function closeLogStream(): void {
}

export function logError(scope: string, fields: Record<string, unknown>): void {
  writeLine("error", scope, fields);
}

export function logWarn(scope: string, fields: Record<string, unknown>): void {
  writeLine("warn", scope, fields);
}

export function logInfo(scope: string, fields: Record<string, unknown>): void {
  writeLine("info", scope, fields);
}

export function logThrow(scope: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const fields: Record<string, unknown> = { ...extra };
  if (err instanceof Error) {
    fields.error = err.message;
    fields.stack = err.stack ?? "";
  } else {
    fields.error = String(err);
  }
  writeLine("error", scope, fields);
}

export const debug = {
  get enabled(): boolean {
    return debugOn();
  },
  get logFile(): string {
    return resolveLogFile();
  },
  event(scope: string, fields: Record<string, unknown>): void {
    if (debugOn()) writeLine("debug", scope, fields);
  },
};
