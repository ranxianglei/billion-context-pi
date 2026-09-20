import { Type } from "typebox";
import { applyAbsorb, parseAbsorbInput, ABSORB_TOOL, ABSORB_TOOL_DESCRIPTION, ABSORB_TOOL_NAME } from "acp-kernel";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { applyToolPromptOverrides, type ToolPromptOverrides } from "./surface.js";
import { logInfo, logThrow, logWarn } from "./log.js";
import { UNSUPPORTED_HOST_MESSAGE } from "./omp.js";

// pi's ToolDefinition requires a typebox schema; the kernel publishes plain JSON.
// Mirror it 1:1 and take the field descriptions straight from the kernel schema so
// the model-facing wording stays single-sourced (acp-kernel#139).
const AbsorbParams = Type.Object({
  ref: Type.String({ description: ABSORB_TOOL.input_schema.properties.ref.description }),
  summary: Type.String({ description: ABSORB_TOOL.input_schema.properties.summary.description }),
});

export function makeAbsorbTool(runtime: AcpRuntime, name: string = ABSORB_TOOL_NAME, overrides?: ToolPromptOverrides): ToolDefinition<typeof AbsorbParams> {
  return applyToolPromptOverrides({
    name,
    label: "Absorb",
    description: ABSORB_TOOL_DESCRIPTION,
    promptSnippet: 'absorb({ ref: "m00042", summary: "key results" }) — checkpoint a big tool result',
    promptGuidelines: [
      "When a tool result carries a forced [ACP absorb] prompt, call absorb with its ref IMMEDIATELY, before any other tool call.",
      "The summary must be self-contained — the original output disappears from context after absorption.",
    ],
    parameters: AbsorbParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? UNSUPPORTED_HOST_MESSAGE }] };
      let result: string;
      try {
        result = await handleAbsorb(params, runtime, ctx, toolCallId);
      } catch (e) {
        logThrow("absorb", e, { sid: ctx.sessionManager.getSessionId() });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  }, overrides);
}

async function handleAbsorb(args: unknown, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
  const parsed = parseAbsorbInput(args, toolCallId, (message) => logWarn("absorb", { sid: ctx.sessionManager.getSessionId(), event: "lenient-parse", message }));
  if (!parsed || !parsed.ref || !parsed.summary.trim()) {
    throw new Error(
      "Invalid absorb arguments: provide ref (the mNNNNN from the tool result's acp tag) and summary (the distilled key results that replace it). " +
        `Example: absorb({ ref: "m00042", summary: "..." })`,
    );
  }
  const { state: initialState, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  if (!config.absorb?.enabled) return "absorb is disabled — nothing changed.";
  const turn = runtime.core.processTurn({ messages: coreMessages, state: initialState, config, tokenCount: 0 });
  const outcome = applyAbsorb({
    ref: parsed.ref,
    summary: parsed.summary,
    absorbCallId: toolCallId,
    messages: turn.messages,
    state: turn.state,
    config,
  });
  if (!outcome.ok) throw new Error(outcome.resultText);
  await runtime.save(outcome.state, ctx);
  const record = outcome.state.absorbed?.[outcome.state.absorbed.length - 1];
  logInfo("absorb", {
    sid: ctx.sessionManager.getSessionId(),
    event: "applied",
    ref: parsed.ref,
    summaryLen: parsed.summary.length,
    tokensReclaimed: record?.tokensReclaimed ?? null,
    totalAbsorbed: outcome.state.stats?.absorbedTokens ?? null,
  });
  return outcome.resultText;
}
