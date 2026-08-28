import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { applyAbsorb, defaultCountTokens } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { logThrow } from "./log.js";
import { estimateTokens, collectCoveredMessageIds, calibrateTokens } from "./tokens.js";
import { getSystemPromptText } from "./compat.js";
import { emptyPending } from "./rollover.js";

const AbsorbParams = Type.Object({
  ref: Type.String({ description: 'Message ref of the tool result to distill, e.g. "m00012" (from its acp tag).' }),
  summary: Type.String({ description: "Distilled essentials of the tool result: outcome, key values, paths:lines, errors, decisions. Dense and self-contained." }),
});

type AbsorbArgs = Static<typeof AbsorbParams>;

export function makeAbsorbTool(runtime: AcpRuntime): ToolDefinition<typeof AbsorbParams> {
  return {
    name: "absorb",
    label: "Absorb",
    description:
      "Distill a large tool result into a compact summary you write. The original output is marked pending drop and removed from context at the next rollover (when usage crosses the rollover threshold, or via /acp rollover) — until then it stays visible, keeping the prompt-cache prefix stable. Use for large tool outputs you have already used.",
    promptSnippet: 'absorb({ ref: "m00012", summary: "..." })',
    promptGuidelines: [
      "Only tool results are absorbable (not user or assistant messages).",
      "The original stays visible until the next rollover — absorb when you are done with the output.",
      "Write dense summaries: keep paths, exact values, errors, and decisions.",
    ],
    parameters: AbsorbParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: string;
      try {
        result = await handleAbsorb(params as AbsorbArgs, runtime, ctx, toolCallId);
      } catch (e) {
        logThrow("absorb", e, { sid: ctx.sessionManager.getSessionId() });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleAbsorb(args: AbsorbArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
  const { state: initialState, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(initialState)) + systemPromptTokens;
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state: initialState,
    config,
    tokenCount: calibrateTokens(sentTokens, runtime.density.densityFor(modelId)),
  });
  const ref = args.ref.trim();
  const pending = runtime.getRolloverPending(ctx);
  const rawId = turn.state.messageRefs.byRef[ref];
  if (rawId && pending?.absorbs.some((a) => a.resultMessageId === rawId)) {
    return `already recorded for rollover (${ref}) — no change.`;
  }
  const outcome = applyAbsorb({
    ref,
    summary: args.summary,
    absorbCallId: toolCallId,
    messages: turn.messages,
    state: turn.state,
    config,
    countTokens: defaultCountTokens,
  });
  if (!outcome.ok) throw new Error(outcome.resultText);
  const prevCount = turn.state.absorbed?.length ?? 0;
  const newCount = outcome.state.absorbed?.length ?? 0;
  if (newCount <= prevCount) return outcome.resultText;
  const newRecord = outcome.state.absorbed![newCount - 1]!;
  const existing = pending ?? emptyPending();
  runtime.setRolloverPending(ctx, { compressions: existing.compressions, absorbs: [...existing.absorbs, newRecord] });
  await runtime.save(turn.state, ctx);
  return outcome.resultText.replace("is now hidden", "is recorded for the next rollover and stays visible until then");
}
