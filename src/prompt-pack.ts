import { readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { Prompts } from "acp-kernel";
import { createPackResolver, defaultPack, defaultPackSources, isValidPackName } from "acp-kernel";
import type { Pack, PackResolver, PackSurface } from "acp-kernel";
import type { AdapterConfig } from "./config.js";
import { resolveCompress } from "./config.js";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import { sanitizePromptSections, type PiPromptSections } from "./system-prompt.js";
import { sanitizeToolPrompts, type NudgeSectionsConfig, type ToolPromptsConfig } from "./surface.js";

// Pack layer lives in acp-kernel >=0.0.66 (#259/#260); pi-specific data rides
// opaquely under surface.adapters.pi and is validated by piExtras below.

export { builtinSource, createDirPackSource, createPackResolver, defaultPack, defaultPackSources, isValidPackName, leanPack, sanitizePackSurface } from "acp-kernel";
export type { Pack, PackResolver, PackSource, PackSurface, PromptPackFile } from "acp-kernel";

interface PiPackExtras {
  promptSections: Partial<PiPromptSections>;
  toolExtras: ToolPromptsConfig;
  delegatePrompt?: string | null;
}

function piExtras(surface: PackSurface | null | undefined): PiPackExtras {
  const raw = surface?.adapters?.pi;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { promptSections: {}, toolExtras: {} };
  const rec = raw as Record<string, unknown>;
  const out: PiPackExtras = {
    promptSections: sanitizePromptSections(rec.promptSections),
    toolExtras: sanitizeToolPrompts(rec.toolExtras),
  };
  if (typeof rec.delegatePrompt === "string" || rec.delegatePrompt === null) out.delegatePrompt = rec.delegatePrompt;
  return out;
}

function packToolPrompts(surface: PackSurface | null | undefined): ToolPromptsConfig {
  return mergeToolPrompts(surface?.toolPrompts, piExtras(surface).toolExtras);
}

export function packResolver(cwd: string): PackResolver {
  return createPackResolver(
    defaultPackSources({
      projectDir: path.join(cwd, CONFIG_DIR_NAME, "acp", "packs"),
      userDirs: [path.join(homedir(), CONFIG_DIR_NAME, "acp", "packs")],
    }),
  );
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

function mergeToolPrompts(pack?: ToolPromptsConfig, inline?: ToolPromptsConfig): ToolPromptsConfig {
  if (!pack) return inline ?? {};
  if (!inline) return pack;
  const out: ToolPromptsConfig = {};
  for (const name of new Set([...Object.keys(pack), ...Object.keys(inline)])) {
    const p = pack[name as keyof ToolPromptsConfig];
    const i = inline[name as keyof ToolPromptsConfig];
    if (!i) {
      out[name as keyof ToolPromptsConfig] = p;
      continue;
    }
    if (!p) {
      out[name as keyof ToolPromptsConfig] = i;
      continue;
    }
    out[name as keyof ToolPromptsConfig] = {
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

export function mergeSurface(pack: PackSurface | null, inline: InlineSurface): MergedSurface {
  const p = pack ?? {};
  const pi = piExtras(pack);
  const prompts: Partial<Prompts> = { ...(p.prompts ?? {}), ...(inline.prompts ?? {}) };
  return {
    prompts,
    promptSections: { ...sanitizePromptSections(p.promptSections), ...pi.promptSections, ...(inline.promptSections ?? {}) },
    nudgeSections: { ...(p.nudgeSections ?? {}), ...(inline.nudgeSections ?? {}) },
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
  return mergeToolPrompts(packToolPrompts(pack?.surface ?? null), inline);
}
