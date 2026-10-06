import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";

// issue #624, session level: project acp.json + project packs must propagate
// through session_start / context events only for trusted projects; trust
// flips must reload the effective configuration. Mirrors the F05 handoff
// harness shape (untrusted project tried to set autoUpdate, override
// promptSections, bump toolOutputMaxBytes, and inject a pack).

setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;

const GLOBAL_MARKER = "GLOBAL-MARKER-SECTION";
const PROJECT_MARKER = "OVERRIDDEN-BY-UNTRUSTED-PROJECT";
const PACK_MARKER = "EVIL PACK SECTION";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

interface CtxOpts { cwd: string; trusted: boolean; stateFile: string }

function ctxOf(opts: CtxOpts) {
  return {
    mode: "rpc",
    hasUI: true,
    cwd: opts.cwd,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "pi-trust-session",
      getSessionFile: () => opts.stateFile,
    },
    isProjectTrusted: () => opts.trusted,
  };
}

function fixtures(globalJson: unknown, projectJson: unknown, projectPack?: unknown) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bcp-trust-sess-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const stateFile = path.join(root, "state.json");
  mkdirSync(path.join(home, ".pi"), { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  if (globalJson !== undefined) writeFileSync(path.join(home, ".pi", "acp.json"), JSON.stringify(globalJson));
  if (projectJson !== undefined) writeFileSync(path.join(cwd, ".pi", "acp.json"), JSON.stringify(projectJson));
  if (projectPack !== undefined) {
    mkdirSync(path.join(cwd, ".pi", "acp", "packs"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi", "acp", "packs", "evil-pack.json"), JSON.stringify(projectPack));
  }
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root, cwd, stateFile,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const PROJECT_JSON = {
  promptSections: { whenToCompress: PROJECT_MARKER },
  toolOutputMaxBytes: 123456,
  autoUpdate: false,
  compress: { promptPack: "evil-pack" },
};
const GLOBAL_JSON = { promptSections: { whenToCompress: GLOBAL_MARKER }, toolOutputMaxBytes: 111 };
// Pack sections rendered into Pi's system prompt live under the opaque
// adapters.pi surface (mergeSurface takes them from piAdapterSurface, not the
// kernel-generic top-level promptSections).
const EVIL_PACK = { name: "evil-pack", adapters: { pi: { promptSections: { whenNotToCompress: PACK_MARKER } } } };

async function boot(fx: { cwd: string; stateFile: string }, trusted: boolean) {
  const { api, handlers } = captureApi();
  createAcpExtension({})(api as any);
  await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctxOf({ cwd: fx.cwd, trusted, stateFile: fx.stateFile }));
  return { api, handlers };
}

test("untrusted session_start: project config and pack skipped, global stays active", async () => {
  const fx = fixtures(GLOBAL_JSON, PROJECT_JSON, EVIL_PACK);
  try {
    const { handlers } = await boot(fx, false);
    const sp = (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctxOf({ cwd: fx.cwd, trusted: false, stateFile: fx.stateFile })) as { systemPrompt: string }).systemPrompt;
    assert.ok(sp.includes(GLOBAL_MARKER), "global config marker reaches the prompt");
    assert.ok(!sp.includes(PROJECT_MARKER), "untrusted project promptSections must not reach the prompt");
    assert.ok(!sp.includes(PACK_MARKER), "untrusted project pack must not be injected");
  } finally {
    fx.restore();
  }
});

test("trusted session_start: project config and pack apply over global", async () => {
  const fx = fixtures(GLOBAL_JSON, PROJECT_JSON, EVIL_PACK);
  try {
    const { handlers } = await boot(fx, true);
    const sp = (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctxOf({ cwd: fx.cwd, trusted: true, stateFile: fx.stateFile })) as { systemPrompt: string }).systemPrompt;
    assert.ok(sp.includes(PROJECT_MARKER), "trusted project promptSections apply");
    assert.ok(sp.includes(PACK_MARKER), "trusted project pack injected");
  } finally {
    fx.restore();
  }
});

test("trust flips propagate on subsequent session_start events", async () => {
  const fx = fixtures(GLOBAL_JSON, PROJECT_JSON, EVIL_PACK);
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({})(api as any);
    const untrustedCtx = () => ctxOf({ cwd: fx.cwd, trusted: false, stateFile: fx.stateFile });
    const trustedCtx = () => ctxOf({ cwd: fx.cwd, trusted: true, stateFile: fx.stateFile });
    const start = (ctx: ReturnType<typeof untrustedCtx>) =>
      handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    const prompt = (ctx: ReturnType<typeof untrustedCtx>) =>
      (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctx) as { systemPrompt: string }).systemPrompt;

    await start(untrustedCtx());
    assert.ok(prompt(untrustedCtx()).includes(GLOBAL_MARKER), "start untrusted: global active");
    assert.ok(!prompt(untrustedCtx()).includes(PROJECT_MARKER), "start untrusted: project skipped");

    await start(trustedCtx());
    assert.ok(prompt(trustedCtx()).includes(PROJECT_MARKER), "flip to trusted: project applies");

    await start(untrustedCtx());
    assert.ok(prompt(untrustedCtx()).includes(GLOBAL_MARKER), "flip back: global restored");
    assert.ok(!prompt(untrustedCtx()).includes(PROJECT_MARKER), "flip back: project gone again");
  } finally {
    fx.restore();
  }
});

test("trust state propagates through context events too", async () => {
  const fx = fixtures(GLOBAL_JSON, PROJECT_JSON, EVIL_PACK);
  try {
    const { handlers } = await boot(fx, false);
    let sp = (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctxOf({ cwd: fx.cwd, trusted: false, stateFile: fx.stateFile })) as { systemPrompt: string }).systemPrompt;
    assert.ok(!sp.includes(PROJECT_MARKER), "untrusted at startup: project skipped");

    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctxOf({ cwd: fx.cwd, trusted: true, stateFile: fx.stateFile }));
    sp = (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctxOf({ cwd: fx.cwd, trusted: true, stateFile: fx.stateFile })) as { systemPrompt: string }).systemPrompt;
    assert.ok(sp.includes(PROJECT_MARKER), "context event under trusted ctx re-applies project config");

    await handlers.get("context")![0]!({ type: "context", messages: [] }, ctxOf({ cwd: fx.cwd, trusted: false, stateFile: fx.stateFile }));
    sp = (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctxOf({ cwd: fx.cwd, trusted: false, stateFile: fx.stateFile })) as { systemPrompt: string }).systemPrompt;
    assert.ok(!sp.includes(PROJECT_MARKER), "context event under untrusted ctx revokes project config");
  } finally {
    fx.restore();
  }
});

test("trusted project enabled:false stands down at session_start", async () => {
  const fx = fixtures(undefined, { enabled: false, promptSections: { whenToCompress: PROJECT_MARKER } });
  try {
    const { api, handlers } = await boot(fx, true);
    assert.ok(api.tools.length > 0, "tools registered at load (trust unknown then)");
    const ctx = ctxOf({ cwd: fx.cwd, trusted: true, stateFile: fx.stateFile });
    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const res = await compressTool.execute("t1", {}, undefined, undefined, ctx);
    const text = res.content[0].text as string;
    assert.match(text, /disabled by acp\.json/, `refusal message surfaced: ${text}`);
    assert.equal(handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctx), undefined, "no ACP prompt when stood down");
    assert.equal(handlers.get("session_before_compact")![0]!({}, {}), undefined, "Pi native compaction stays in control");
  } finally {
    fx.restore();
  }
});

test("untrusted project enabled:false is ignored — adapter stays active", async () => {
  const fx = fixtures(GLOBAL_JSON, { enabled: false, promptSections: { whenToCompress: PROJECT_MARKER } });
  try {
    const { handlers } = await boot(fx, false);
    const ctx = ctxOf({ cwd: fx.cwd, trusted: false, stateFile: fx.stateFile });
    const sp = (handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctx) as { systemPrompt: string }).systemPrompt;
    assert.ok(sp.includes(GLOBAL_MARKER), "adapter active despite untrusted project enabled:false");
    assert.deepEqual(handlers.get("session_before_compact")![0]!({}, {}), { cancel: true }, "compaction cancellation still wired");
  } finally {
    fx.restore();
  }
});

test("untrusted project enabled:true cannot override a disabled global", () => {
  const fx = fixtures({ enabled: false }, { enabled: true });
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({})(api as any);
    assert.equal(api.tools.length, 0, "global enabled:false wins at load");
    assert.equal(handlers.size, 0, "no handlers wired");
  } finally {
    fx.restore();
  }
});
