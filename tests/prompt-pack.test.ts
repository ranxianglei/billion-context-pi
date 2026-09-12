import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { builtinSource, createDirPackSource, defaultPack, leanPack, sanitizePackSurface } from "acp-kernel";
import type { Pack, PackSource } from "acp-kernel";
import { defaultPrompts } from "acp-kernel";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "../src/index.js";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";
import {
  isValidPackName,
  discoverPack,
  resolvePackName,
  resolveActivePack,
  mergeSurface,
  readToolSurfaceWithPacks,
  createPackResolver,
  defaultPackSources,
  packResolver,
} from "../src/prompt-pack.js";
import type { AdapterConfig } from "../src/config.js";

function adapter(compress?: AdapterConfig["compress"]): AdapterConfig {
  return { ...(compress ? { compress } : {}) };
}

test("lean pack is a standalone Pack with a clean surface (pi extras under adapters.pi)", () => {
  assert.equal(leanPack.name, "lean");
  assert.equal(leanPack.source, "builtin:lean");
  const s = leanPack.surface;
  assert.equal(s.prompts, undefined);
  const pi = s.adapters?.pi as {
    promptSections?: Record<string, unknown>;
    toolExtras?: Record<string, { promptSnippet?: string; promptGuidelines?: string[] }>;
  } | undefined;
  assert.ok(pi, "pi extras present under surface.adapters.pi");
  const sections = pi!.promptSections ?? {};
  assert.equal(typeof sections.acpTags, "string");
  assert.ok((sections.acpTags as string).includes("Never echo the XML tags"));
  for (const k of ["summariesInContext", "tools", "philosophy", "howToCompress", "tier2", "tier3", "multiTierIntro", "decompressPhilosophy", "contextBreakdown", "throttleRetry", "whenToCompress", "whenNotToCompress"]) {
    assert.equal(sections[k], null, `${k} should be null`);
  }
  for (const t of ["compress", "decompress", "search_context", "acp_status"]) {
    assert.equal(pi!.toolExtras?.[t]?.promptSnippet, "", `${t} snippet should be empty`);
    assert.deepEqual(pi!.toolExtras?.[t]?.promptGuidelines, [], `${t} guidelines should be []`);
  }
  assert.deepEqual(Object.keys(s.toolPrompts ?? {}).sort(), ["acp_status", "compress", "decompress", "search_context"]);
  assert.equal(typeof s.toolPrompts?.compress?.description, "string");
  for (const t of ["compress", "decompress", "search_context", "acp_status"] as const) {
    assert.equal((s.toolPrompts?.[t] as { promptSnippet?: string } | undefined)?.promptSnippet, undefined, `${t} has no top-level extras`);
  }
});

test("lean pack system prompt collapses to header + lean bullets", () => {
  const merged = mergeSurface(leanPack.surface, {});
  const text = buildAcpSystemPrompt(defaultPrompts, merged.promptSections);
  assert.ok(text.startsWith("\nACP context management\n\n"));
  assert.ok(text.includes("Never echo the XML tags"));
  assert.ok(!text.includes("ACP TAGS"));
  assert.ok(!text.includes("COMPRESSION SUMMARIES IN CONTEXT"));
  assert.ok(!text.includes("Compression Philosophy"));
  assert.ok(!text.includes("WHEN TO COMPRESS"));
  assert.ok(!text.includes("Compress by need, not by percentage"));
  assert.ok(!text.includes("TIER 2 COMPRESSION"));
});

test("resolvePackName walks the three compress levels, model wins", () => {
  const a = adapter({ promptPack: "lean" });
  assert.equal(resolvePackName(a), "lean");
  const b = adapter({ promptPack: "default", providers: { openai: { promptPack: "lean" } } });
  assert.equal(resolvePackName(b, "openai", "gpt-4o"), "lean");
  assert.equal(resolvePackName(b, "anthropic", "claude"), "default");
  const c = adapter({ promptPack: "lean", providers: { openai: { promptPack: "default", models: { "gpt-4o-mini": { promptPack: "lean" } } } } });
  assert.equal(resolvePackName(c, "openai", "gpt-4o-mini"), "lean");
  assert.equal(resolvePackName(c, "openai", "gpt-4o"), "default");
  assert.equal(resolvePackName(c), "lean");
});

test("resolveActivePack: default pack for no selection; project file discovered; project shadows builtin", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-pack-"));
  try {
    assert.equal(resolveActivePack(adapter(), dir).name, "default");
    assert.deepEqual(resolveActivePack(adapter(), dir).surface, {});
    assert.equal(resolveActivePack(adapter({ promptPack: "default" }), dir).name, "default");
    assert.equal(resolveActivePack(adapter({ promptPack: "lean" }), dir).name, "lean");
    assert.equal(resolveActivePack(adapter({ promptPack: "lean" }), dir).source, "builtin:lean");

    await mkdir(path.join(dir, ".pi/acp/packs"), { recursive: true });
    await writeFile(path.join(dir, ".pi/acp/packs/my-pack.json"), JSON.stringify({ name: "my-pack", promptSections: { acpTags: "PROJECT PACK" } }), "utf8");
    const found = resolveActivePack(adapter({ promptPack: "my-pack" }), dir);
    assert.equal(found?.name, "my-pack");
    assert.match(found.source, /^file:.*my-pack\.json$/);

    await writeFile(path.join(dir, ".pi/acp/packs/lean.json"), JSON.stringify({ name: "lean", promptSections: { acpTags: "SHADOW LEAN" } }), "utf8");
    const shadow = resolveActivePack(adapter({ promptPack: "lean" }), dir);
    assert.equal((shadow?.surface.promptSections as Record<string, unknown>)?.acpTags, "SHADOW LEAN");

    assert.equal(resolveActivePack(adapter({ promptPack: "no-such-pack" }), dir).name, "default");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverPack rejects path traversal names", () => {
  assert.equal(isValidPackName("../etc"), false);
  assert.equal(isValidPackName("a/b"), false);
  assert.equal(isValidPackName(".."), false);
  assert.equal(isValidPackName("my-pack.v2"), true);
  assert.equal(discoverPack("../etc", process.cwd()), null);
});

test("mergeSurface: inline wins per field, pack fills the rest", () => {
  const pack = sanitizePackSurface({
    promptSections: { acpTags: "PACK TAGS", tools: "PACK TOOLS" },
    nudgeSections: { efficiencyNote: "PACK NOTE" },
    toolPrompts: { compress: { description: "PACK DESC", paramDescriptions: { startId: "pack-start", endId: "pack-end" } } },
    adapters: { pi: { delegatePrompt: "PACK DELEGATE" } },
    prompts: { compressPhilosophy: "PACK PHILO" },
  });
  const merged = mergeSurface(pack, {
    promptSections: { acpTags: null },
    toolPrompts: { compress: { paramDescriptions: { startId: "inline-start" } } },
    prompts: { compressPhilosophy: "INLINE PHILO" },
  });
  assert.equal((merged.promptSections as Record<string, unknown>).acpTags, null);
  assert.equal((merged.promptSections as Record<string, unknown>).tools, "PACK TOOLS");
  assert.equal((merged.nudgeSections as Record<string, unknown>).efficiencyNote, "PACK NOTE");
  assert.equal(merged.toolPrompts.compress?.description, "PACK DESC");
  assert.equal(merged.toolPrompts.compress?.paramDescriptions?.startId, "inline-start");
  assert.equal(merged.toolPrompts.compress?.paramDescriptions?.endId, "pack-end");
  assert.equal(merged.delegatePrompt, "PACK DELEGATE");
  assert.equal((merged.prompts as Record<string, string>).compressPhilosophy, "INLINE PHILO");
});

test("mergeSurface: inline delegatePrompt (incl. null) beats pack", () => {
  const pack = sanitizePackSurface({ adapters: { pi: { delegatePrompt: "PACK DELEGATE" } } });
  assert.equal(mergeSurface(pack, {}).delegatePrompt, "PACK DELEGATE");
  assert.equal(mergeSurface(pack, { delegatePrompt: "INLINE" }).delegatePrompt, "INLINE");
  assert.equal(mergeSurface(pack, { delegatePrompt: null }).delegatePrompt, null);
});

test("sanitizePackSurface sanitizes junk: bad types dropped, only 4 rule keys kept for prompts", () => {
  const s = sanitizePackSurface({
    prompts: { compressPhilosophy: "ok", bogus: "x", howToCompressRules: 7 },
    promptSections: { acpTags: 42, tools: null },
    nudgeSections: { t2Guidance: "t" },
    toolPrompts: { bash: { description: "nope" } },
    adapters: { pi: { delegatePrompt: "D" } },
  });
  assert.deepEqual(s.prompts, { compressPhilosophy: "ok" });
  assert.deepEqual(s.promptSections, { tools: null });
  assert.deepEqual(s.nudgeSections, { t2Guidance: "t" });
  assert.deepEqual(s.toolPrompts, { bash: { description: "nope" } });
  assert.deepEqual(s.adapters, { pi: { delegatePrompt: "D" } });
});

test("readToolSurfaceWithPacks applies base pack under inline (per-field, per-param)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-toolsurf-"));
  try {
    await mkdir(path.join(dir, ".pi"), { recursive: true });
    await writeFile(
      path.join(dir, ".pi/acp.json"),
      JSON.stringify({
        toolPrompts: { compress: { promptSnippet: "inline-snip", paramDescriptions: { startId: "inline-start" } } },
        compress: { promptPack: "lean" },
      }),
      "utf8",
    );
    const out = readToolSurfaceWithPacks(dir);
    assert.equal(out.compress?.promptSnippet, "inline-snip");
    assert.equal(out.compress?.description, "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.");
    assert.equal(out.compress?.paramDescriptions?.startId, "inline-start");
    assert.equal(out.compress?.paramDescriptions?.endId, "Inclusive last mNNNNN or bN ref.");
    assert.deepEqual(out.compress?.promptGuidelines, []);
    assert.equal(out.decompress?.promptSnippet, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeSurface sanitizes adapters.pi extras: bad types dropped, unknown tools dropped", () => {
  const surface = sanitizePackSurface({
    adapters: {
      pi: {
        promptSections: { acpTags: 42, tools: null, whenToCompress: "keep", philosophy: "no" },
        toolExtras: {
          compress: { promptSnippet: 7, promptGuidelines: "single" },
          bash: { promptSnippet: "nope" },
          acp_status: { promptSnippet: "s", promptGuidelines: [1, "ok"] },
          decompress: { promptGuidelines: ["fine"] },
        },
        delegatePrompt: "D",
      },
    },
  });
  const merged = mergeSurface(surface, {});
  assert.deepEqual(merged.promptSections, { tools: null, whenToCompress: "keep" });
  assert.deepEqual(merged.toolPrompts, {
    compress: { promptGuidelines: "single" },
    acp_status: { promptSnippet: "s" },
    decompress: { promptGuidelines: ["fine"] },
  });
  assert.equal(merged.delegatePrompt, "D");
});

test("readToolSurfaceWithPacks: home config fills, cwd config wins", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "acp-home-"));
  const dir = await mkdtemp(path.join(tmpdir(), "acp-cwd-"));
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  try {
    // os.homedir() resolves USERPROFILE on Windows, HOME elsewhere — set both.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await mkdir(path.join(home, ".pi"), { recursive: true });
    await writeFile(path.join(home, ".pi/acp.json"), JSON.stringify({ toolPrompts: { compress: { promptSnippet: "home-snip", description: "HOME DESC" } } }), "utf8");
    await mkdir(path.join(dir, ".pi"), { recursive: true });
    await writeFile(path.join(dir, ".pi/acp.json"), JSON.stringify({ compress: { promptPack: "default" } }), "utf8");
    let out = readToolSurfaceWithPacks(dir);
    assert.equal(out.compress?.promptSnippet, "home-snip");
    assert.equal(out.compress?.description, "HOME DESC");

    await writeFile(path.join(dir, ".pi/acp.json"), JSON.stringify({ toolPrompts: { compress: { description: "CWD DESC" } } }), "utf8");
    out = readToolSurfaceWithPacks(dir);
    assert.equal(out.compress?.description, "CWD DESC");
    assert.equal(out.compress?.promptSnippet, undefined);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

type BeforeAgentStartHandler = (event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string };

function wireBeforeAgentStart(adapter: AdapterConfig): BeforeAgentStartHandler {
  let handler: BeforeAgentStartHandler | null = null;
  const api = {
    on: (event: string, h: unknown): void => {
      if (event === "before_agent_start") handler = h as BeforeAgentStartHandler;
    },
    tools: [] as unknown[],
    commands: new Map<string, unknown>(),
    registerTool: (_tool: unknown): void => {},
    registerCommand: (_name: string, _options: unknown): void => {},
  };
  createAcpExtension(adapter)(api as ExtensionAPI);
  assert.ok(handler, "before_agent_start wired");
  return handler!;
}

test("before_agent_start applies pack prompts per model and resets to defaults when switching away", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-pack-wire-"));
  try {
    await mkdir(path.join(dir, ".pi/acp/packs"), { recursive: true });
    await writeFile(
      path.join(dir, ".pi/acp/packs/mypack.json"),
      JSON.stringify({ name: "mypack", prompts: { compressPhilosophy: "PACK PHILO RULE" } }),
      "utf8",
    );
    const adapter = {
      acknowledgePromptsRisk: true,
      compress: { providers: { openai: { promptPack: "mypack" } } },
    } satisfies AdapterConfig;
    const beforeAgentStart = wireBeforeAgentStart(adapter);
    const defaultPhilo = defaultPrompts.compressPhilosophy.slice(0, 40);

    const packed = beforeAgentStart({ systemPrompt: "" }, { model: { provider: "openai", id: "gpt-x" }, cwd: dir });
    assert.ok(packed.systemPrompt.includes("PACK PHILO RULE"), "pack rules reach the system prompt for the pack's model");
    assert.ok(!packed.systemPrompt.includes(defaultPhilo), "pack replaces the default philosophy");

    const reset = beforeAgentStart({ systemPrompt: "" }, { model: { provider: "anthropic", id: "claude-x" }, cwd: dir });
    assert.ok(!reset.systemPrompt.includes("PACK PHILO RULE"), "switching to a model without the pack must drop its rules");
    assert.ok(reset.systemPrompt.includes(defaultPhilo), "kernel default rules restored after switch-away");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom PackSource prepended to the chain wins over files and builtins (installer pattern)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-packsrc-"));
  try {
    await mkdir(path.join(dir, ".pi/acp/packs"), { recursive: true });
    await writeFile(path.join(dir, ".pi/acp/packs/lean.json"), JSON.stringify({ name: "lean", promptSections: { acpTags: "FILE LEAN" } }), "utf8");

    const managedPack: Pack = { name: "team-pack", surface: { promptSections: { acpTags: "TEAM PACK" } }, source: "managed:team-pack" };
    const managed: PackSource = {
      id: "managed",
      resolve(name: string): Pack | null {
        return name === "team-pack" ? managedPack : null;
      },
      list(): Pack[] {
        return [managedPack];
      },
    };
    const resolver = createPackResolver([managed, ...defaultPackSources({ projectDir: path.join(dir, ".pi/acp/packs"), userDirs: [] })]);

    assert.equal(resolver.resolve("team-pack")?.source, "managed:team-pack");
    assert.equal(resolver.resolve("nope"), null);
    assert.equal((resolver.resolve("lean")?.surface.promptSections as Record<string, unknown>)?.acpTags, "FILE LEAN");
    assert.equal(packResolver(dir).resolve("team-pack"), null);

    const names = resolver.listPacks().map((p) => `${p.name}@${p.source}`);
    assert.ok(names.some((n) => n.startsWith("team-pack@managed:")));
    assert.ok(names.some((n) => n.startsWith("lean@file:")));
    assert.ok(names.some((n) => n.startsWith("default@builtin:")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("before_agent_start risk-gates pack prompts without acknowledgePromptsRisk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-pack-gate-"));
  try {
    await mkdir(path.join(dir, ".pi/acp/packs"), { recursive: true });
    await writeFile(
      path.join(dir, ".pi/acp/packs/gated.json"),
      JSON.stringify({ name: "gated", prompts: { compressPhilosophy: "GATED PHILO RULE" } }),
      "utf8",
    );
    const adapter = {
      compress: { promptPack: "gated" },
    } satisfies AdapterConfig;
    const beforeAgentStart = wireBeforeAgentStart(adapter);
    const result = beforeAgentStart({ systemPrompt: "" }, { model: { provider: "openai", id: "gpt-x" }, cwd: dir });
    assert.ok(!result.systemPrompt.includes("GATED PHILO RULE"), "ungated pack prompts are dropped");
    assert.ok(result.systemPrompt.includes(defaultPrompts.compressPhilosophy.slice(0, 40)), "defaults stay in force");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dir source list() survives missing directory; builtin source lists default+lean", async () => {
  const missing = createDirPackSource("missing", path.join(tmpdir(), "acp-no-such-dir-xyz"));
  assert.deepEqual(missing.list(), []);
  const names = builtinSource.list().map((p) => p.name);
  assert.ok(names.includes("default"));
  assert.ok(names.includes("lean"));
  assert.equal(defaultPack.surface, defaultPack.surface);
});
