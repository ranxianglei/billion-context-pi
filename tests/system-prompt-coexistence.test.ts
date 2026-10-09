import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { injectAcpSystemPrompt, appendOptionFeedsRenderedPrompt } from "../src/compat.js";

// #630: returning { systemPrompt } from before_agent_start maps to pi's
// forceSystemPrompt, which replaces the structured sections and drops other
// extensions' appendSystemPrompt addendum when load order flips. The fix must
// contribute via the appendable option on live hosts while keeping the legacy
// return path for snapshot hosts. These tests pin both branches against the
// exact semantics observed in @earendil-works/pi-coding-agent 1.x
// (runner.emitBeforeAgentStart re-renders event.systemPrompt from mutable
// options; buildSystemPromptState short-circuits to force content only).

const ACP_MARKER = "ACP context management";

function captureBeforeAgentStart() {
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
  createAcpExtension()(api as any);
  const handler = handlers.get("before_agent_start")![0]!;
  assert.ok(handler, "before_agent_start wired");
  return handler;
}

/**
 * Faithful stand-in for a pi 1.x before_agent_start event: `systemPrompt` is a
 * live getter re-rendered from `options.appendSystemPrompt`, and a forced
 * prompt (set by an earlier extension's returned replacement) short-circuits
 * the structured sections exactly like buildSystemPromptState does.
 */
function makeLiveEvent(opts: { initialAppend?: string; forced?: string } = {}) {
  const options: { appendSystemPrompt?: string } = { appendSystemPrompt: opts.initialAppend ?? "" };
  const base = "BASE PROMPT";
  const event: any = { type: "before_agent_start", prompt: "hi", systemPromptOptions: options };
  Object.defineProperty(event, "systemPrompt", {
    enumerable: true,
    configurable: true,
    get() {
      if (opts.forced !== undefined) return opts.forced;
      const append = options.appendSystemPrompt ?? "";
      return append ? `${base}\n\n${append}` : base;
    },
  });
  return { event, options };
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

test("live host: appends into appendSystemPrompt without forcing, preserving a preceding extension's addendum", () => {
  const handler = captureBeforeAgentStart();
  const { event, options } = makeLiveEvent({ initialAppend: "GENTLE SHELL HARNESS CONTRACT" });
  const result = handler(event, {});
  assert.equal(result, undefined, "must not return a forced replacement on a live host");
  assert.ok(options.appendSystemPrompt!.includes("GENTLE SHELL HARNESS CONTRACT"), "other extension's addendum survives");
  assert.ok(options.appendSystemPrompt!.includes(ACP_MARKER), "ACP prompt is injected via the appendable option");
});

test("live host: injects the ACP prompt when appendSystemPrompt starts empty", () => {
  const handler = captureBeforeAgentStart();
  const { event, options } = makeLiveEvent({});
  const result = handler(event, {});
  assert.equal(result, undefined, "must not return a forced replacement");
  assert.ok(options.appendSystemPrompt!.includes(ACP_MARKER), "ACP prompt present");
});

test("live host: injection is idempotent across repeated handler invocations", () => {
  const handler = captureBeforeAgentStart();
  const { event, options } = makeLiveEvent({});
  handler(event, {});
  const first = options.appendSystemPrompt!;
  handler(event, {});
  assert.equal(options.appendSystemPrompt, first, "second invocation must not duplicate the block");
  assert.equal(count(options.appendSystemPrompt!, ACP_MARKER), 1, "exactly one ACP block");
});

test("legacy host: still returns the composed replacement (snapshot model)", () => {
  const handler = captureBeforeAgentStart();
  const result = handler({ systemPrompt: "BASE PROMPT" }, {}) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("BASE PROMPT"), "preserves the base prompt");
  assert.ok(result.systemPrompt.includes(ACP_MARKER), "ACP prompt appended");
});

test("live host with a prior forced prompt: chains onto the forced value instead of dropping its own prompt", () => {
  const handler = captureBeforeAgentStart();
  const { event, options } = makeLiveEvent({ forced: "OTHER EXTENSION FORCED CONTENT" });
  const result = handler(event, {}) as { systemPrompt: string };
  assert.ok(result.systemPrompt.includes("OTHER EXTENSION FORCED CONTENT"), "keeps the earlier extension's forced content");
  assert.ok(result.systemPrompt.includes(ACP_MARKER), "ACP prompt still reaches the model via chaining");
  assert.equal(options.appendSystemPrompt, "", "probe restores the option; no stray append on the fallback path");
});

test("injectAcpSystemPrompt: live path mutates the option and returns nothing", () => {
  const { event, options } = makeLiveEvent({ initialAppend: "PRE" });
  const out = injectAcpSystemPrompt(event, "BLOCK_XYZ");
  assert.equal(out, undefined);
  assert.equal(options.appendSystemPrompt, "PRE\n\nBLOCK_XYZ");
});

test("injectAcpSystemPrompt: legacy path returns the composed replacement and leaves options alone", () => {
  const out = injectAcpSystemPrompt({ systemPrompt: "B" }, "BLOCK_XYZ");
  assert.deepEqual(out, { systemPrompt: "B\n\nBLOCK_XYZ" });
});

test("appendOptionFeedsRenderedPrompt: distinguishes live render from snapshot/forced/no-options", () => {
  const live = makeLiveEvent({}).event;
  assert.equal(appendOptionFeedsRenderedPrompt(live), true, "live getter reflects the option");
  const forced = makeLiveEvent({ forced: "F" }).event;
  assert.equal(appendOptionFeedsRenderedPrompt(forced), false, "forced prompt ignores the option");
  const snapshot = { systemPrompt: "B", systemPromptOptions: { appendSystemPrompt: "" } };
  assert.equal(appendOptionFeedsRenderedPrompt(snapshot), false, "static snapshot ignores the option");
  assert.equal(appendOptionFeedsRenderedPrompt({ systemPrompt: "B" }), false, "no option object");
});
