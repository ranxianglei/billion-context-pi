import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { logInfo, logThrow } from "./log.js";
import { UNSUPPORTED_HOST_MESSAGE } from "./omp.js";
import { RULE_TOOL_NAME, addRule, clearRules, formatRulesList, listRules, removeRule, resolveRuleLimits } from "acp-kernel";

// #433 introduced the record/list half of this tool with zero system-prompt
// surface (no promptSnippet/promptGuidelines — usage guidance lives in the
// description). #555 completes the CRUD surface: record/list/delete/clear.
// Description and parameter shape are byte-identical to billion-context's
// RULE_TOOL/RULE_PARAM_SCHEMA (its src/compress-tool.ts) so the model sees one
// acp_rule under both hosts; execution mirrors its executeRule: one operation
// per call, kernel validation failures returned verbatim (informative outcomes,
// not errors). Durability is the kernel's ALWAYS_PROTECTED_TOOLS, not here.
const RuleParams = Type.Object({
  rule: Type.Optional(Type.String({ description: "Short principle-level reminder to record. Omit to list recorded rules." })),
  delete: Type.Optional(Type.String({ description: 'Id of a recorded rule to remove (e.g. "rule3"). Mutually exclusive with rule and clear.' })),
  clear: Type.Optional(Type.Boolean({ description: "Remove every recorded rule at once. Mutually exclusive with rule and delete." })),
});

const ONE_OP_PER_CALL = "Use one operation per call: record (rule), remove one (delete), remove all (clear: true), or list (no arguments).";

export function makeRuleTool(runtime: AcpRuntime): ToolDefinition<typeof RuleParams> {
  return {
    name: RULE_TOOL_NAME,
    label: "ACP Rule",
    description:
      "Record a short, principle-level reminder so it survives context compression — the call and its result are protected and stay in context. Record when: the user calls out or repeatedly emphasizes a lesson; the user asks you to remember or follow a behavior; you personally hit a major pitfall worth remembering long-term. Keep each rule to one short line. Omit the rule argument to list recorded rules. To remove a recorded rule pass delete with its id (e.g. \"rule3\"); to remove every recorded rule pass clear: true. delete and clear are mutually exclusive with each other and with rule — use one operation per call.",
    parameters: RuleParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? UNSUPPORTED_HOST_MESSAGE }] };
      try {
        const text = await handleRule(params.rule, params.delete, params.clear, runtime, ctx);
        return { details: undefined, content: [{ type: "text", text }] };
      } catch (e) {
        logThrow("rule", e, { sid: ctx.sessionManager.getSessionId() });
        throw e;
      }
    },
  };
}

async function handleRule(rule: string | undefined, del: string | undefined, clear: boolean | undefined, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const sid = ctx.sessionManager.getSessionId();
  const { state } = await runtime.stateFor(ctx);
  const text = typeof rule === "string" ? rule.trim() : "";
  const delId = typeof del === "string" ? del.trim() : "";
  const wantsClear = clear === true;
  const ops = [delId.length > 0, wantsClear, text.length > 0].filter(Boolean).length;
  if (ops > 1) return ONE_OP_PER_CALL;
  if (wantsClear) {
    const result = clearRules(state);
    await runtime.save(state, ctx);
    logInfo("rule", { sid, event: "cleared", count: result.count });
    return result.count === 0 ? "No rules to clear." : `Cleared ${result.count} rule(s).`;
  }
  if (delId.length > 0) {
    // Return kernel validation errors verbatim instead of throwing (same as
    // record): they are informative outcomes ("no change"), not failures.
    const result = removeRule(state, delId);
    if (!result.ok) return result.error;
    await runtime.save(state, ctx);
    logInfo("rule", { sid, event: "removed", id: result.rule.id, remaining: listRules(state).length });
    return `Removed ${result.rule.id}: ${result.rule.text}`;
  }
  if (text.length === 0) {
    const rules = listRules(state);
    return rules.length === 0 ? "No rules recorded." : formatRulesList(rules);
  }
  const result = addRule(state, text, resolveRuleLimits(runtime.configFor(ctx)));
  if (!result.ok) return result.error;
  await runtime.save(state, ctx);
  logInfo("rule", { sid, event: "recorded", id: result.rule.id, chars: result.rule.text.length, total: listRules(state).length });
  return `Recorded ${result.rule.id}: ${result.rule.text}`;
}
