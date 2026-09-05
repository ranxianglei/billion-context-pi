import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { ACP_STATUS_CUSTOM_TYPE } from "./messages.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { collectCoveredMessageIds, estimateTokens, collectImageTokens, modelSupportsImages } from "./tokens.js";
import { usageAnchorPredatesCompression } from "./floor-stale.js";
import { buildStatusPanel } from "acp-kernel/panel";
import { getDelegateUsage } from "./delegate-tool.js";
import { openFleetInspector } from "./fleet-inspector.js";
import { resolveDelegate } from "./config.js";
import { ensureSubagentAcpTools } from "./setup-subagent-tools.js";

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

export function makeCommands(runtime: AcpRuntime, pi?: ExtensionAPI): Array<{ name: string; options: CommandOptions }> {
  // Persistent transcript output (rendered by TUI and web hosts like pi-web);
  // notify() is a transient toast and only the fallback for hosts without
  // sendMessage (issue #255).
  const statusHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const text = await statusReport(runtime, ctx);
    if (typeof pi?.sendMessage === "function") {
      pi.sendMessage({ customType: ACP_STATUS_CUSTOM_TYPE, content: text, display: true });
      return;
    }
    ctx.ui.notify(text);
  };
  return [
    {
      name: "acp",
      options: {
        description: "Show ACP context usage, token breakdown, and compression status.",
        handler: statusHandler,
      },
    },
    {
      name: "acp-status",
      options: {
        description: "Detailed ACP status (block tiers, token breakdown, delegate usage).",
        handler: statusHandler,
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
    {
      name: "acp-fleet",
      options: {
        description: "Inspect acp_delegate sub-agent runs: live list + transcript overlay (TUI), text snapshot elsewhere.",
        handler: async (_args, ctx) => {
          if (!resolveDelegate(runtime.adapter).enabled) {
            ctx.ui.notify("acp_delegate is not enabled in this session's config.");
            return;
          }
          await openFleetInspector(ctx);
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
  const anchorStale = usageAnchorPredatesCompression(entries ?? []);

  // Nudge arbitration on the SENT-VIEW scale — must match the context
  // transform and acp_status: sent-view estimate floored at the host's real
  // context usage (issue #257).
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
  const imageTokensTotal = [...imageTokens.values()].reduce((a, b) => a + b, 0);
  const sessionTokens = !anchorStale && realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n")) + imageTokensTotal;
  const coveredIds = collectCoveredMessageIds(state);
  const sentTokens = estimateTokens(coreMessages, coveredIds, imageTokens) + systemPromptTokens;
  // issue #257: floor the meter at the host's real context usage so the
  // panel's nudge matches the real decision (same as src/index.ts).
  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount: anchorStale ? sentTokens : Math.max(sentTokens, realUsage?.tokens ?? 0) });

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
