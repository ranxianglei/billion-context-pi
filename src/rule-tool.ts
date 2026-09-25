import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { logInfo, logThrow } from "./log.js";
import { UNSUPPORTED_HOST_MESSAGE } from "./omp.js";
import { RULE_TOOL_NAME, addRule, formatRulesList, listRules, resolveRuleLimits } from "acp-kernel";

const RuleParams = Type.Object({
  rule: Type.Optional(Type.String({ description: "The reminder to record — short and principle-level. Omit this argument to list all recorded rules instead." })),
});

// #433: record/list tool. No promptSnippet/promptGuidelines on purpose — pi
// renders those into the system prompt and the design constraint is zero
// system-prompt changes; usage guidance lives in the description. Durability
// is the kernel's ALWAYS_PROTECTED_TOOLS, not anything in this file.
export function makeRuleTool(runtime: AcpRuntime): ToolDefinition<typeof RuleParams> {
  return {
    name: RULE_TOOL_NAME,
    label: "ACP Rule",
    description:
      "Record a short, principle-level reminder that must survive context compression. Use it for behavioral corrections the user has had to repeat more than once, project invariants the user explicitly asked you to remember, and pitfalls you ran into once and must not run into again. Keep each rule short and principle-level. Recorded rules are hard-protected from compression and stay visible in the conversation. Omit the rule argument to list recorded rules.",
    parameters: RuleParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? UNSUPPORTED_HOST_MESSAGE }] };
      try {
        const text = await handleRule(params.rule, runtime, ctx);
        return { details: undefined, content: [{ type: "text", text }] };
      } catch (e) {
        logThrow("rule", e, { sid: ctx.sessionManager.getSessionId() });
        throw e;
      }
    },
  };
}

async function handleRule(rule: string | undefined, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const sid = ctx.sessionManager.getSessionId();
  const { state } = await runtime.stateFor(ctx);
  if (rule === undefined) {
    const rules = listRules(state);
    if (rules.length === 0) return "No rules recorded.";
    return formatRulesList(rules);
  }
  // Return kernel validation errors verbatim instead of throwing (unlike
  // compress): they are informative outcomes ("no change"), not failures.
  const result = addRule(state, rule, resolveRuleLimits(runtime.configFor(ctx)));
  if (!result.ok) return result.error;
  await runtime.save(state, ctx);
  logInfo("rule", { sid, event: "recorded", id: result.rule.id, chars: result.rule.text.length, total: listRules(state).length });
  return `Recorded ${result.rule.id}: ${result.rule.text}`;
}
