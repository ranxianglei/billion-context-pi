import { readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  builtinSource,
  createDirPackSource,
  createPackResolver,
  defaultPack,
  defaultPackSources as kernelPackSources,
  isValidPackName,
  leanPack,
  sanitizePackSurface,
} from "acp-kernel";
import type { Pack, PackResolver, PackSource, PackSurface, PromptPackFile, Prompts } from "acp-kernel";
import type { AdapterConfig } from "./config.js";
import { resolveCompress } from "./config.js";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import { sanitizePromptSections, type PiPromptSections } from "./system-prompt.js";
import { sanitizeToolPrompts, type AcpToolName, type NudgeSectionsConfig, type ToolPromptsConfig } from "./surface.js";

export { builtinSource, createDirPackSource, createPackResolver, defaultPack, isValidPackName, leanPack, sanitizePackSurface };
export type { Pack, PackResolver, PackSource, PackSurface, PromptPackFile };

export function defaultPackSources(cwd: string): PackSource[] {
  return kernelPackSources({
    projectDir: path.join(cwd, CONFIG_DIR_NAME, "acp", "packs"),
    userDirs: [path.join(homedir(), CONFIG_DIR_NAME, "acp", "packs")],
  });
}

export function packResolver(cwd: string): PackResolver {
  return createPackResolver(defaultPackSources(cwd));
}

export function discoverPack(name: string, cwd: string): Pack | null {
  return packResolver(cwd).resolve(name);
}

export function resolvePackName(adapter: AdapterConfig, provider?: string, modelId?: string): string {
  const raw = resolveCompress(adapter.compress, provider, modelId).promptPack;
  return typeof raw === "string" && isValidPackName(raw) ? raw : "default";
}

export function resolveActivePack(
  adapter: AdapterConfig,
  cwd: string,
  provider?: string,
  modelId?: string,
  resolver?: PackResolver,
): Pack {
  const name = resolvePackName(adapter, provider, modelId);
  if (name === "default") return defaultPack;
  const r = resolver ?? packResolver(cwd);
  return r.resolve(name) ?? defaultPack;
}

const ACP_TOOLS: ReadonlySet<string> = new Set(["compress", "decompress", "search_context", "acp_status"]);

export interface PiToolExtras {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export type PiToolExtrasConfig = Partial<Record<AcpToolName, PiToolExtras>>;

export interface PiAdapterSurface {
  promptSections: Partial<PiPromptSections>;
  toolExtras: PiToolExtrasConfig;
  delegatePrompt?: string | null;
}

/**
 * Pi-specific part of a pack. `surface.adapters.pi` is opaque to the kernel,
 * so the adapter sanitizes it here: tri-state prompt sections restricted to
 * pi's section keys, per-tool extras with malformed fields dropped.
 */
export function piAdapterSurface(pack: Pack): PiAdapterSurface {
  const raw = pack.surface.adapters?.pi;
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const toolExtras: PiToolExtrasConfig = {};
  const extrasRaw = rec.toolExtras;
  if (extrasRaw && typeof extrasRaw === "object" && !Array.isArray(extrasRaw)) {
    for (const [tool, value] of Object.entries(extrasRaw as Record<string, unknown>)) {
      if (!ACP_TOOLS.has(tool) || !value || typeof value !== "object") continue;
      const src = value as Record<string, unknown>;
      const entry: PiToolExtras = {};
      if (typeof src.promptSnippet === "string") entry.promptSnippet = src.promptSnippet;
      if (typeof src.promptGuidelines === "string") {
        entry.promptGuidelines = [src.promptGuidelines];
      } else if (Array.isArray(src.promptGuidelines)) {
        const guidelines = src.promptGuidelines.filter((g): g is string => typeof g === "string");
        if (guidelines.length === src.promptGuidelines.length) entry.promptGuidelines = guidelines;
      }
      if (Object.keys(entry).length > 0) toolExtras[tool as AcpToolName] = entry;
    }
  }
  const surface: PiAdapterSurface = {
    promptSections: sanitizePromptSections(rec.promptSections),
    toolExtras,
  };
  if (typeof rec.delegatePrompt === "string" || rec.delegatePrompt === null) {
    surface.delegatePrompt = rec.delegatePrompt;
  }
  return surface;
}

function packToolPrompts(pack: Pack | null): ToolPromptsConfig {
  const out: ToolPromptsConfig = {};
  const toolPrompts = pack?.surface.toolPrompts;
  if (toolPrompts) {
    for (const [tool, overrides] of Object.entries(toolPrompts)) {
      if (ACP_TOOLS.has(tool)) out[tool as AcpToolName] = { ...overrides };
    }
  }
  if (pack) {
    for (const [tool, extras] of Object.entries(piAdapterSurface(pack).toolExtras)) {
      out[tool as AcpToolName] = { ...out[tool as AcpToolName], ...extras };
    }
  }
  return out;
}

function mergeToolPrompts(pack?: ToolPromptsConfig, inline?: ToolPromptsConfig): ToolPromptsConfig {
  if (!pack) return inline ?? {};
  if (!inline) return pack;
  const out: ToolPromptsConfig = {};
  for (const name of new Set([...Object.keys(pack), ...Object.keys(inline)])) {
    const p = pack[name as AcpToolName];
    const i = inline[name as AcpToolName];
    if (!i) {
      out[name as AcpToolName] = p;
      continue;
    }
    if (!p) {
      out[name as AcpToolName] = i;
      continue;
    }
    out[name as AcpToolName] = {
      ...p,
      ...i,
      paramDescriptions: { ...p.paramDescriptions, ...i.paramDescriptions },
    };
  }
  return out;
}

export interface InlineSurface {
  prompts?: Partial<Prompts>;
  promptSections?: Partial<PiPromptSections>;
  nudgeSections?: NudgeSectionsConfig;
  toolPrompts?: ToolPromptsConfig;
  delegatePrompt?: string | null;
}

export interface MergedSurface {
  prompts: Partial<Prompts>;
  promptSections: Partial<PiPromptSections>;
  nudgeSections: NudgeSectionsConfig;
  toolPrompts: ToolPromptsConfig;
  delegatePrompt?: string | null;
}

export function mergeSurface(pack: Pack | null, inline: InlineSurface): MergedSurface {
  const s = pack?.surface ?? {};
  const pi = pack ? piAdapterSurface(pack) : { promptSections: {}, toolExtras: {} };
  return {
    prompts: { ...(s.prompts ?? {}), ...(inline.prompts ?? {}) },
    promptSections: { ...pi.promptSections, ...(inline.promptSections ?? {}) },
    nudgeSections: { ...(s.nudgeSections ?? {}), ...(inline.nudgeSections ?? {}) },
    toolPrompts: mergeToolPrompts(packToolPrompts(pack), inline.toolPrompts),
    delegatePrompt: inline.delegatePrompt !== undefined ? inline.delegatePrompt : pi.delegatePrompt,
  };
}

export function readToolSurfaceWithPacks(cwd: string): ToolPromptsConfig {
  const home = homedir();
  let inline: ToolPromptsConfig = {};
  let packName = "default";
  for (const base of [path.join(home, CONFIG_DIR_NAME), path.join(cwd, CONFIG_DIR_NAME)]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(base, "acp.json"), "utf8"));
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        if (rec.toolPrompts) inline = sanitizeToolPrompts(rec.toolPrompts);
        const c = rec.compress;
        if (c && typeof c === "object" && typeof (c as Record<string, unknown>).promptPack === "string") {
          packName = (c as Record<string, unknown>).promptPack as string;
        }
      }
    } catch {
      // missing file or bad JSON — keep prior
    }
  }
  const pack = packName === "default" || !isValidPackName(packName) ? null : packResolver(cwd).resolve(packName);
  return mergeToolPrompts(packToolPrompts(pack), inline);
}
