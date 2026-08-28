import type { ExtensionCommandContext, RegisteredCommand, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { collectCoveredMessageIds, estimateTokens, calibrateTokens, collectImageTokens, modelSupportsImages } from "./tokens.js";
import { buildStatusPanel } from "acp-kernel/panel";
import { getDelegateUsage } from "./delegate-tool.js";
import { ensureSubagentAcpTools } from "./setup-subagent-tools.js";
import { resolveRollover } from "./config.js";
import { pendingHasWork, runRollover, rolloverReportText } from "./rollover.js";

declare const CURRENT_VERSION: string;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

/** Extract per-request prompt-cache usage from assistant messages' provider
 *  reported usage (footer of each entry). Requests without cache reporting
 *  stay 0/0 — cacheHitStats excludes them from the average. */
function cacheUsageSamples(entries: SessionEntry[]): Array<{ input: number; cacheRead: number; cacheWrite: number }> {
  const out: Array<{ input: number; cacheRead: number; cacheWrite: number }> = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
    if (m?.role !== "assistant" || !m.usage) continue;
    out.push({ input: m.usage.input ?? 0, cacheRead: m.usage.cacheRead ?? 0, cacheWrite: m.usage.cacheWrite ?? 0 });
  }
  return out;
}

export function makeCommands(runtime: AcpRuntime): Array<{ name: string; options: CommandOptions }> {
  return [
    {
      name: "acp",
      options: {
        description: "Show ACP context usage, token breakdown, and compression status.",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-status",
      options: {
        description: "Detailed ACP status (block tiers, token breakdown, delegate usage).",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-rollover",
      options: {
        description: "Apply all pending rollover work now (batch-compress + absorb pending ranges in one rewrite). Usage: /acp-rollover",
        handler: async (_args, ctx) => {
          const rollover = resolveRollover(runtime.adapter);
          if (!rollover.enabled) {
            ctx.ui.notify("Rollover mode is disabled (rollover: false). Nothing to do.");
            return;
          }
          if (!pendingHasWork(runtime.getRolloverPending(ctx))) {
            ctx.ui.notify("No pending rollover work (no recorded compressions or absorbs).");
            return;
          }
          const release = await runtime.acquireLock(ctx.sessionManager.getSessionId());
          try {
            const { state, coreMessages, entries } = await runtime.stateFor(ctx);
            const config = runtime.configFor(ctx);
            const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
            const systemPromptText = getSystemPromptText(ctx);
            const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
            const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
            const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(state), imageTokens) + systemPromptTokens;
            const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount: calibrateTokens(sentTokens, runtime.density.densityFor(modelId)) });
            const result = await runRollover({ runtime, ctx, config, coreMessages, turn, modelId, imageTokens, systemPromptTokens });
            ctx.ui.notify(result ? rolloverReportText(result) : "No pending rollover work.");
          } finally {
            release();
          }
        },
      },
    },
    {
      name: "acp-decompress",
      options: {
        description: "Restore a compressed block's content (shown here, block stays folded). Usage: /acp-decompress b3",
        handler: async (args, ctx) => {
          const blockId = parseBlockIdArg(args);
          if (!blockId) {
            ctx.ui.notify('Usage: /acp-decompress <blockId> (e.g. "b3")');
            return;
          }
          const { state, coreMessages } = await runtime.stateFor(ctx);
          const block = state.blocks.find((b) => b.blockId === blockId);
          if (!block) {
            ctx.ui.notify(`Block ${blockId} not found.`);
            return;
          }
          const { text, count } = collectBlockContent(state, block, coreMessages, { full: false });
          if (count === 0) {
            ctx.ui.notify(`Block ${blockId} has no restorable message content.`);
            return;
          }
          ctx.ui.notify(`Block ${blockId} (${count} items):\n\n${text}`);
        },
      },
    },
    {
      name: "acp-search",
      options: {
        description: "Search compressed block summaries. Usage: /acp-search auth token",
        handler: async (args, ctx) => {
          const query = args.trim();
          if (!query) {
            ctx.ui.notify("Usage: /acp-search <query>");
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const hits = runtime.core.search(query, state);
          if (hits.length === 0) {
            ctx.ui.notify("No matching blocks.");
            return;
          }
          const lines = hits.map((b) => `[${b.blockId}] (t${b.tier}) ${b.topic ?? ""}`.trim());
          ctx.ui.notify(lines.join("\n"));
        },
      },
    },
    {
      name: "acp-subagents",
      options: {
        description:
          "Add ACP context tools (compress/decompress/search_context/acp_status) to pi-subagents' builtin agents. " +
          "One-time setup — re-run after upgrading pi-subagents. Usage: /acp-subagents [installDir]",
        handler: async (args, ctx) => {
          const installDir = args.trim();
          const result = ensureSubagentAcpTools(undefined, installDir ? { installDir } : undefined);
          if (result.action === "updated") {
            ctx.ui.notify(`ACP tools enabled for pi-subagents agents in ${result.path}`);
          } else if (result.action === "skipped") {
            ctx.ui.notify(
              `Nothing to do: ${result.reason ?? ""}. ` +
                "Install pi-subagents (pi install npm:pi-subagents) or pass its directory: /acp-subagents <installDir>",
            );
          } else {
            ctx.ui.notify(`Failed to update ${result.path}: ${result.reason ?? "unknown"}`);
          }
        },
      },
    },
  ];
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages, entries } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Use pi's real context usage (anchored on provider usage) only for the
  // panel's footer-scale display line; see sentTokens below for arbitration.
  const realUsage = ctx.getContextUsage?.();

  // Nudge arbitration on the SENT-VIEW scale — must match the context
  // transform and acp_status. pi's getContextUsage is anchored on the last
  // assistant's provider-reported usage when available (≈ real sent view,
  // fine), but falls back to summing the whole session tree when providers
  // don't report usage — same class of false emergency as the omp 180K-
  // window/366K-tree report (session keeps chatting while nudge screams
  // EMERGENCY at 204%). The tree-scale number stays in the log only.
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
  const imageTokensTotal = [...imageTokens.values()].reduce((a, b) => a + b, 0);
  const sessionTokens = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n")) + imageTokensTotal;
  const coveredIds = collectCoveredMessageIds(state);
  const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
  const sentTokens = estimateTokens(coreMessages, coveredIds, imageTokens) + systemPromptTokens;
  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount: calibrateTokens(sentTokens, runtime.density.densityFor(modelId)) });

  // Shared kit surface renders the panel (dual accounting, viability
  // filtering, bars, block list with topic fallback). Host-specific inputs:
  // systemPromptTokens (measured) and unprunedTokens — the chars/4 estimate
  // of the full projection, so the kit derives Session-only on the same
  // estimation scale as the sent view (never cross-scale; omp issue #18).
  const versionStr = CURRENT_VERSION ? `billion-context-pi@${CURRENT_VERSION}` : undefined;
  let text = buildStatusPanel({
    version: versionStr,
    tokenCount: sessionTokens,
    systemPromptTokens,
    state: turn.state,
    nudge: turn.nudge,
    modelContextLimit: config.modelContextLimit,
    unprunedTokens: coreMessages.reduce((sum, m) => sum + defaultCountTokens(m.text ?? "") + (imageTokens.get(m.id) ?? 0), 0),
    cacheUsages: cacheUsageSamples(entries ?? []),
  });

  // pi-specific footer: delegate usage is tracked outside the main totals.
  const delegateUsage = getDelegateUsage();
  if (delegateUsage && delegateUsage.totalTokens > 0) {
    const cost = delegateUsage.cost.total;
    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
    text += "\n\n── Session delegate usage (excluded from main totals) ──\n";
    text += `Tokens: ${delegateUsage.input.toLocaleString()} in, ${delegateUsage.output.toLocaleString()} out (${delegateUsage.totalTokens.toLocaleString()} total)${costStr}`;
  }
  return text;
}
