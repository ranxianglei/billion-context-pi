import type { ExtensionCommandContext, RegisteredCommand, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { collectCoveredMessageIds, estimateTokens, calibrateTokens, collectImageTokens, modelSupportsImages } from "./tokens.js";
import { buildStatusPanel } from "acp-kernel/panel";
import { getDelegateUsage } from "./delegate-tool.js";
import { ensureSubagentAcpTools } from "./setup-subagent-tools.js";
import { SESSION_MODEL_REF } from "./compress-model.js";

declare const CURRENT_VERSION: string;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

/** Command handlers are typed `(args: string, ...)`. Real pi passes a string;
 *  some tests pass an array. Normalize both to a string. */
function commandArgString(args: string): string {
  const a: unknown = args;
  if (typeof a === "string") return a;
  if (Array.isArray(a)) return (a as string[]).join(" ");
  return "";
}

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
        description:
          "Show ACP context usage, token breakdown, and compression status. " +
          "Subcommand: /acp compact [session|model-id|reset] to manage the dedicated compression model.",
        handler: async (args, ctx) => {
          const argStr = commandArgString(args);
          const first = argStr.trim().split(/\s+/)[0];
          if (first === "compact") {
            ctx.ui.notify(await handleCompact(argStr, runtime, ctx));
            return;
          }
          ctx.ui.notify(await statusReport(runtime, ctx));
        },
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

/** `/acp compact [model-id|reset]` — manage the dedicated compression model.
 *  No arg: show status + list models.json. `reset`: clear. `<id>`: set (validated). */
async function handleCompact(args: string, runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const rest = parts.slice(1); // drop leading "compact"
  const client = runtime.compressionModel;

  if (rest.length === 0) {
    const current = runtime.getCompressionModelRef();
    if (!current) {
      const models = await client.listModels();
      const list = models.length > 0
        ? models.map((m) => `  ${m.provider}/${m.id}${m.name ? ` — ${m.name}` : ""}`).join("\n")
        : "  (no models found in models.json)";
      return (
        "Compression model: NOT SET — the main model writes summaries (default).\n\n" +
        "Options:\n" +
        `  /acp compact ${SESSION_MODEL_REF}   — use the session's own model, reusing its prompt prefix (prompt-cache friendly)\n` +
        `Available models in models.json:\n${list}\n\n` +
        "Set one with: /acp compact <model-id>"
      );
    }
    if (current === SESSION_MODEL_REF) {
      return "Compression model: session — the session's own model writes summaries, reusing its prompt prefix (prompt-cache friendly). Falls back to the main model on error.\nReset with: /acp compact reset";
    }
    const resolved = await client.resolveModel(current);
    if (resolved.model) {
      return `Compression model: ${resolved.model.provider}/${resolved.model.id} — a dedicated model writes summaries (falls back to the main model on error).\nReset with: /acp compact reset`;
    }
    return `Compression model: ${current} — configured but NOT resolvable in models.json, so compress will fall back to the main model.\nReset with: /acp compact reset`;
  }

  const target = rest.join(" ");
  if (target === "reset") {
    await runtime.setCompressionModelRef(null);
    return "Compression model cleared — reverting to main-model compression.";
  }
  if (target === SESSION_MODEL_REF) {
    await runtime.setCompressionModelRef(SESSION_MODEL_REF);
    return "Compression model set to session — the session's own model writes summaries, reusing its prompt prefix (prompt-cache friendly). Falls back to the main model on error.";
  }

  const resolved = await client.resolveModel(target);
  if (resolved.ambiguous.length > 0) {
    return (
      `Ambiguous model id "${target}". Use "provider/id" instead:\n` +
      resolved.ambiguous.map((m) => `  ${m.provider}/${m.id}`).join("\n")
    );
  }
  if (!resolved.model) {
    const models = await client.listModels();
    const list = models.length > 0
      ? models.map((m) => `  ${m.provider}/${m.id}`).join("\n")
      : "  (no models found in models.json)";
    return `Model "${target}" not found in models.json.\nAvailable:\n${list}`;
  }
  const canonical = `${resolved.model.provider}/${resolved.model.id}`;
  await runtime.setCompressionModelRef(canonical);
  return `Compression model set to ${canonical}. Compress summaries will now be written by this model (falls back to the main model on error).`;
}
