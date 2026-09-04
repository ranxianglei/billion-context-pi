import { defaultCountTokens, type CompressionCore, type CompressionState, type Config, type CoreMessage } from "acp-kernel";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { countImageBlocks } from "./messages.js";

type AgentMessage = SessionMessageEntry["message"];

export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

// ~Anthropic screenshot cost; real per-model cost (85..2.8K) varies — flat approximation.
export const IMAGE_TOKEN_COST = 1600;

// pi-ai silently drops image blocks for non-vision models, so they cost nothing there.
export function modelSupportsImages(model: unknown): boolean {
  const input = (model as { input?: string[] } | null | undefined)?.input;
  return Array.isArray(input) && input.includes("image");
}

// Keyed by entry id — the core id of user/toolResult messages (assistant tool-call cores split as `${id}#callId` and never carry images).
export function collectImageTokens(entries: { id: string; type?: string; message?: AgentMessage }[], visionCapable: boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!visionCapable) return out;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const n = countImageBlocks((e.message as { content?: unknown } | undefined)?.content);
    if (n > 0) out.set(e.id, n * IMAGE_TOKEN_COST);
  }
  return out;
}

export function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>, imageTokensById?: Map<string, number>): number {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress") continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += defaultCountTokens(m.text ?? "");
    const img = imageTokensById?.get(m.id);
    if (img) tokens += img;
  }
  return tokens;
}

// Re-measure tokenCount on the ACTUAL sent view: run processTurn on a throwaway
// state clone (processTurn mutates state — survival counters, nudge stamps) and
// count the pruned result (covered removed + summaries injected + orphaned tool
// pairs/absorbed/filtered messages stripped). The raw-view estimate over
// coreMessages minus block coverage diverges from this sent view in long
// multi-block sessions: uncovered messages that prune strips every turn stay
// counted forever while never being sent, pinning usage in the emergency band
// and driving low/zero-yield compression loops (issue #289). Ref-tag overhead
// is included because tags ride along in the sent text.
export function sentViewTokenCount(
  core: CompressionCore,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  prelim: number,
  imageTokensById?: Map<string, number>,
  systemPromptTokens = 0,
): { viewTokens: number; drifted: boolean } {
  const probe = core.processTurn({ messages, state: structuredClone(state), config, tokenCount: prelim });
  const viewTokens = estimateTokens(probe.messages, collectCoveredMessageIds(probe.state), imageTokensById) + systemPromptTokens;
  return { viewTokens, drifted: Math.abs(viewTokens - prelim) > Math.max(1000, 0.1 * prelim) };
}

// Guarded variant for call sites that only need the final count: divergence is
// impossible without active block coverage, so skip the probe pass entirely then.
export function adjustedTokenCount(
  core: CompressionCore,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  prelim: number,
  imageTokensById?: Map<string, number>,
  systemPromptTokens = 0,
): number {
  if (!state.blocks.some((b) => b.active && b.effectiveMessageIds.length > 0)) return prelim;
  const view = sentViewTokenCount(core, messages, state, config, prelim, imageTokensById, systemPromptTokens);
  return view.drifted ? view.viewTokens : prelim;
}

/** Id of the last user-role entry — used as a per-turn key so a nudge prints at
 *  most once per turn. Returns undefined if there is no user message yet. */
export function lastUserMessageId(entries: { id: string; message?: { role?: string } }[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.message?.role === "user") return e.id;
  }
  return undefined;
}
