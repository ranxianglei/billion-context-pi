import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { logInfo, logThrow, logWarn } from "./log.js";
import { parseAbsorbInput, applyAbsorb } from "acp-kernel";

const AbsorbParams = Type.Object({
  ref: Type.String({ description: 'Ref of the tool result being absorbed, e.g. "m00042" (the mNNNNN from its acp tag).' }),
  summary: Type.String({ description: "Distilled key results that REPLACE the tool output in context. Keep: outcome, key data/values, exact paths:lines, errors verbatim, decisions. You will NOT see the original again." }),
});

type AbsorbArgs = Static<typeof AbsorbParams>;

export function makeAbsorbTool(runtime: AcpRuntime, name = "absorb"): ToolDefinition<typeof AbsorbParams> {
  return {
    name,
    label: "Absorb",
    description:
      'Distill a large tool result you just read into a compact summary. Once absorbed, the original tool output is removed from context and only your summary remains. Call as: absorb({ ref: "m00042", summary: "..." }).',
    promptSnippet: 'absorb({ ref: "m00042", summary: "key results" }) — checkpoint a big tool result',
    promptGuidelines: [
      "When a tool result carries a forced [ACP absorb] prompt, call absorb with its ref IMMEDIATELY, before any other tool call.",
      "The summary must be self-contained — the original output disappears from context after absorption.",
    ],
    parameters: AbsorbParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: string;
      try {
        result = await handleAbsorb(params as AbsorbArgs, runtime, ctx, toolCallId);
      } catch (e) {
        logThrow("absorb", e, { sid: ctx.sessionManager.getSessionId(), ref: String((params as AbsorbArgs).ref ?? "") });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleAbsorb(args: AbsorbArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
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
