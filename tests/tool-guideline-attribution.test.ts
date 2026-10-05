import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { makeDelegateCancelTool, makeDelegateTool, makeDelegateWaitTool } from "../src/delegate-tool.js";

// #586: pi flattens every tool's promptGuidelines into ONE global system-prompt
// list without per-tool headers (agent-session _rebuildSystemPrompt → buildSystemPrompt
// "Guidelines:" section), so each built-in guideline must identify its own tool by
// exact name — an unnamed bullet ("Call when asked about cache hits…") is
// indistinguishable across tools once merged. This pins that contract on every
// registered ACP tool so a future edit cannot silently drop the attribution.
test("every built-in promptGuideline leads with its exact tool name", () => {
  const tools: any[] = [];
  const api = {
    on() {},
    tools,
    commands: new Map<string, any>(),
    registerTool(tool: any) { tools.push(tool); },
    registerCommand(name: string, options: any) { (this.commands as Map<string, any>).set(name, options); },
  };
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  // The delegate trio registers at session_start (config-gated); construct it
  // directly so its guidelines are covered too.
  const stubPi = {} as any;
  tools.push(makeDelegateTool(stubPi), makeDelegateWaitTool(stubPi), makeDelegateCancelTool(stubPi));

  const expected = ["compress", "decompress", "search_context", "acp_status", "acp_cache", "acp_delegate", "acp_delegate_wait"];
  const names = new Set(tools.map((t) => t.name));
  for (const name of expected) {
    assert.ok(names.has(name), `expected tool ${name} to be registered`);
  }

  let checked = 0;
  for (const t of tools) {
    if (!Array.isArray(t.promptGuidelines)) continue;
    for (const g of t.promptGuidelines) {
      assert.equal(typeof g, "string", `${t.name}: guideline must be a string`);
      assert.ok(g.startsWith(`${t.name}: `), `${t.name}: guideline missing tool attribution: ${g}`);
      checked += 1;
    }
  }
  // Non-vacuity guard: the built-in default surface ships 24 attributed
  // guidelines; deleting them all must fail, not silently pass.
  assert.ok(checked >= 20, `expected >= 20 attributed built-in guidelines, got ${checked}`);
});
