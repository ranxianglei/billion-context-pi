import { readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import type { AdapterConfig } from "./config.js";
import { sanitizePromptSections, type PiPromptSections } from "./system-prompt.js";

export interface ToolPromptOverrides {
  description?: string;
  paramDescriptions?: Record<string, string>;
  promptSnippet?: string;
  promptGuidelines?: string | string[];
}

export type AcpToolName = "compress" | "decompress" | "search_context" | "acp_status" | "absorb";

export type ToolPromptsConfig = Partial<Record<AcpToolName, ToolPromptOverrides>>;

export type NudgeSectionsConfig = Partial<Record<"efficiencyNote" | "emergencyHeader" | "t2Guidance" | "t3Guidance", string | null>>;

const TOOL_NAMES: ReadonlySet<string> = new Set(["compress", "decompress", "search_context", "acp_status", "absorb"]);

const NUDGE_KEYS: ReadonlySet<string> = new Set(["efficiencyNote", "emergencyHeader", "t2Guidance", "t3Guidance"]);

function normalizeGuidelines(g: string | string[]): string[] {
  return Array.isArray(g) ? g : [g];
}

export function sanitizeToolPrompts(raw: unknown): ToolPromptsConfig {
  const out: ToolPromptsConfig = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!TOOL_NAMES.has(tool) || !value || typeof value !== "object") continue;
    const src = value as Record<string, unknown>;
    const entry: ToolPromptOverrides = {};
    if (typeof src.description === "string") entry.description = src.description;
    if (typeof src.promptSnippet === "string") entry.promptSnippet = src.promptSnippet;
    if (typeof src.promptGuidelines === "string" || Array.isArray(src.promptGuidelines)) {
      if (Array.isArray(src.promptGuidelines) ? src.promptGuidelines.every((g) => typeof g === "string") : true) {
        entry.promptGuidelines = src.promptGuidelines as string | string[];
      }
    }
    if (src.paramDescriptions && typeof src.paramDescriptions === "object" && !Array.isArray(src.paramDescriptions)) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(src.paramDescriptions as Record<string, unknown>)) {
        if (typeof v === "string") params[k] = v;
      }
      if (Object.keys(params).length > 0) entry.paramDescriptions = params;
    }
    if (Object.keys(entry).length > 0) out[tool as AcpToolName] = entry;
  }
  return out;
}

export function sanitizeNudgeSections(raw: unknown): NudgeSectionsConfig {
  const out: NudgeSectionsConfig = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (NUDGE_KEYS.has(k) && (typeof v === "string" || v === null)) {
      (out as Record<string, string | null>)[k] = v;
    }
  }
  return out;
}

function withParamDescriptions<S>(schema: S, descriptions: Record<string, string>): S {
  const src = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    const d = descriptions[k];
    properties[k] = d !== undefined && v && typeof v === "object" ? { ...(v as Record<string, unknown>), description: d } : v;
  }
  return { ...(schema as object), properties } as S;
}

export function applyToolPromptOverrides<TParams extends TSchema>(def: ToolDefinition<TParams>, overrides?: ToolPromptOverrides): ToolDefinition<TParams> {
  if (!overrides) return def;
  return {
    ...def,
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.promptSnippet !== undefined ? { promptSnippet: overrides.promptSnippet } : {}),
    ...(overrides.promptGuidelines !== undefined ? { promptGuidelines: normalizeGuidelines(overrides.promptGuidelines) } : {}),
    ...(overrides.paramDescriptions !== undefined ? { parameters: withParamDescriptions(def.parameters, overrides.paramDescriptions) } : {}),
  };
}

export function readToolSurfaceSync(cwd: string): ToolPromptsConfig {
  const home = homedir();
  let out: ToolPromptsConfig = {};
  for (const base of [path.join(home, CONFIG_DIR_NAME), path.join(cwd, CONFIG_DIR_NAME)]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(base, "acp.json"), "utf8"));
      if (parsed && typeof parsed === "object") {
        const tp = (parsed as Record<string, unknown>).toolPrompts;
        if (tp) out = sanitizeToolPrompts(tp);
      }
    } catch {
      // missing file or bad JSON — keep prior
    }
  }
  return out;
}

export function sanitizeSurfaceConfig(adapter: AdapterConfig): AdapterConfig {
  return {
    ...adapter,
    promptSections: sanitizePromptSections(adapter.promptSections),
    nudgeSections: sanitizeNudgeSections(adapter.nudgeSections),
    toolPrompts: sanitizeToolPrompts(adapter.toolPrompts),
    delegatePrompt: typeof adapter.delegatePrompt === "string" || adapter.delegatePrompt === null ? adapter.delegatePrompt : undefined,
  };
}
