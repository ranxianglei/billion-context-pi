import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readProjectTrusted } from "../src/project-trust.js";
import { loadUserConfig } from "../src/user-config.js";
import { createRuntime } from "../src/runtime.js";
import {
  resolveActivePack,
  resolveSurfaceMeta,
  discoverPack,
  packResolver,
  readToolSurfaceWithPacks,
} from "../src/prompt-pack.js";
import type { AdapterConfig } from "../src/config.js";

// issue #624: project .pi/acp.json keys and project prompt packs must only
// apply when Pi reports the project trusted (ctx.isProjectTrusted()); fail
// closed when the signal is unavailable. Global config + global packs stay.

// ─── readProjectTrusted: fail-closed feature detection ──────────────────────

test("readProjectTrusted: true only when the host explicitly reports true", () => {
  assert.equal(readProjectTrusted({ isProjectTrusted: () => true }), true);
  assert.equal(readProjectTrusted({ isProjectTrusted: () => false }), false);
  assert.equal(readProjectTrusted({}), false);
  assert.equal(readProjectTrusted(null), false);
  assert.equal(readProjectTrusted(undefined), false);
  assert.equal(readProjectTrusted("ctx"), false);
});

test("readProjectTrusted: throwing or non-boolean results fail closed", () => {
  assert.equal(readProjectTrusted({ isProjectTrusted: () => { throw new Error("boom"); } }), false);
  assert.equal(readProjectTrusted({ isProjectTrusted: () => "yes" }), false);
  assert.equal(readProjectTrusted({ isProjectTrusted: () => undefined }), false);
  assert.equal(readProjectTrusted({ isProjectTrusted: true }), false);
});

// ─── fixture helpers ─────────────────────────────────────────────────────────

function cfgFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bcp-trust-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(path.join(home, ".pi"), { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "acp.json"), JSON.stringify({ autoUpdate: false, toolOutputMaxBytes: 111 }));
  writeFileSync(
    path.join(cwd, ".pi", "acp.json"),
    JSON.stringify({ toolOutputMaxBytes: 123456, promptSections: { whenToCompress: "OVERRIDDEN-BY-UNTRUSTED-PROJECT" } }),
  );
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root, home, cwd,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function packFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bcp-trust-pack-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(path.join(home, ".pi", "acp", "packs"), { recursive: true });
  mkdirSync(path.join(cwd, ".pi", "acp", "packs"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "acp", "packs", "globalpack.json"), JSON.stringify({ name: "globalpack", promptSections: { acpTags: "GLOBAL PACK" } }));
  writeFileSync(path.join(cwd, ".pi", "acp", "packs", "evilpack.json"), JSON.stringify({ name: "evilpack", promptSections: { acpTags: "EVIL PACK" } }));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root, home, cwd,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ─── loadUserConfig: project base gated by includeProject ───────────────────

test("loadUserConfig: untrusted skips project acp.json, global stays active", async () => {
  const fx = cfgFixture();
  try {
    const trusted = await loadUserConfig(fx.cwd, true);
    assert.equal(trusted.toolOutputMaxBytes, 123456, "trusted: project value wins");
    assert.equal(trusted.promptSections?.whenToCompress, "OVERRIDDEN-BY-UNTRUSTED-PROJECT");
    assert.equal(trusted.autoUpdate, false, "global key still merged");
    const untrusted = await loadUserConfig(fx.cwd, false);
    assert.equal(untrusted.toolOutputMaxBytes, 111, "untrusted: project override skipped");
    assert.equal(untrusted.promptSections, undefined, "untrusted: project-only key absent");
    assert.equal(untrusted.autoUpdate, false, "untrusted: global config stays active");
    const legacy = await loadUserConfig(fx.cwd);
    assert.equal(legacy.toolOutputMaxBytes, 123456, "legacy callers keep including project config");
  } finally {
    fx.restore();
  }
});

// ─── pack resolution: project dir gated, user dir + builtins stay ───────────

test("resolveActivePack/discoverPack/packResolver: project packs only when trusted", async () => {
  const fx = packFixture();
  try {
    const adapter: AdapterConfig = { compress: { promptPack: "evilpack" } };
    const trusted = resolveActivePack(adapter, fx.cwd, undefined, undefined, undefined, true);
    assert.equal(trusted.name, "evilpack");
    const untrusted = resolveActivePack(adapter, fx.cwd, undefined, undefined, undefined, false);
    assert.equal(untrusted.name, "default", "untrusted: project pack falls back to default");
    assert.ok(discoverPack("evilpack", fx.cwd), "trusted discovery finds the project pack");
    assert.equal(discoverPack("evilpack", fx.cwd, false), null, "untrusted discovery misses the project pack");
    assert.equal(packResolver(fx.cwd, false).resolve("evilpack"), null);
  } finally {
    fx.restore();
  }
});

test("user-dir packs stay resolvable for untrusted projects", async () => {
  const fx = packFixture();
  try {
    const adapter: AdapterConfig = { compress: { promptPack: "globalpack" } };
    const untrusted = resolveActivePack(adapter, fx.cwd, undefined, undefined, undefined, false);
    assert.equal(untrusted.name, "globalpack", "untrusted: user-dir packs remain active");
    assert.equal((untrusted.surface.promptSections as Record<string, unknown>)?.acpTags, "GLOBAL PACK");
    const metaUntrusted = resolveSurfaceMeta(adapter, fx.cwd, undefined, undefined, undefined, false);
    assert.equal(metaUntrusted.pack, "globalpack");
    const evilAdapter: AdapterConfig = { compress: { promptPack: "evilpack" } };
    const metaEvilUntrusted = resolveSurfaceMeta(evilAdapter, fx.cwd, undefined, undefined, undefined, false);
    assert.equal(metaEvilUntrusted.pack, "default", "status display must not claim an inactive project pack");
    const metaEvilTrusted = resolveSurfaceMeta(evilAdapter, fx.cwd, undefined, undefined, undefined, true);
    assert.equal(metaEvilTrusted.pack, "evilpack");
  } finally {
    fx.restore();
  }
});

test("readToolSurfaceWithPacks: untrusted ignores project toolPrompts and project packs", async () => {
  const fx = packFixture();
  try {
    writeFileSync(
      path.join(fx.home, ".pi", "acp.json"),
      JSON.stringify({ toolPrompts: { compress: { promptSnippet: "global-snip" } } }),
    );
    writeFileSync(
      path.join(fx.cwd, ".pi", "acp.json"),
      JSON.stringify({ toolPrompts: { compress: { promptSnippet: "project-snip" } }, compress: { promptPack: "evilpack" } }),
    );
    writeFileSync(
      path.join(fx.cwd, ".pi", "acp", "packs", "evilpack.json"),
      JSON.stringify({ name: "evilpack", toolPrompts: { decompress: { description: "EVIL DESC" } } }),
    );
    const untrusted = readToolSurfaceWithPacks(fx.cwd, false);
    assert.equal(untrusted.compress?.promptSnippet, "global-snip", "untrusted: project inline ignored, global kept");
    assert.notEqual(untrusted.decompress?.description, "EVIL DESC", "untrusted: project pack tool prompts excluded");
    const trusted = readToolSurfaceWithPacks(fx.cwd, true);
    assert.equal(trusted.compress?.promptSnippet, "project-snip", "trusted: project inline wins");
  } finally {
    fx.restore();
  }
});

// ─── runtime reload: trust participates in the cache identity ───────────────

test("reloadConfig: trust flips re-derive even with unchanged files", async () => {
  const fx = cfgFixture();
  try {
    const rt = createRuntime({});
    await rt.reloadConfig(fx.cwd, false);
    assert.equal(rt.adapter.toolOutputMaxBytes, 111, "untrusted: global value");
    assert.equal(rt.adapter.autoUpdate, false, "untrusted: global value");
    assert.equal(rt.adapter.promptSections?.whenToCompress, undefined);

    await rt.reloadConfig(fx.cwd, true);
    assert.equal(rt.adapter.toolOutputMaxBytes, 123456, "trusted: project override applied");
    assert.equal(rt.adapter.promptSections?.whenToCompress, "OVERRIDDEN-BY-UNTRUSTED-PROJECT");

    await rt.reloadConfig(fx.cwd, true);
    assert.equal(rt.adapter.toolOutputMaxBytes, 123456, "same trust state: cached, still correct");

    await rt.reloadConfig(fx.cwd, false);
    assert.equal(rt.adapter.toolOutputMaxBytes, 111, "flip back: re-derived despite identical file contents");
    assert.equal(rt.adapter.promptSections?.whenToCompress, undefined);

    await rt.reloadConfig(fx.cwd);
    assert.equal(rt.adapter.toolOutputMaxBytes, 123456, "legacy call (no trust arg) keeps project config for external hosts");
  } finally {
    fx.restore();
  }
});
