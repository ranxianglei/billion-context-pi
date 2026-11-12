import type { CompressionCore, CompressionState } from "acp-kernel";
import { estimateTokensFast } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { logWarn } from "./log.js";
import { entriesToCoreMessages } from "./messages.js";
import { sanitizeSummary } from "./summary-sanitize.js";

/**
 * Issue #299 (ranxianglei/billion-context-pi#299) last-resort state recovery.
 *
 * pi's `importFromJsonl` copies only the `.jsonl` file, so the
 * `${sessionFile}.acp.json` sidecar never travels with an imported session and
 * compression state silently resets to empty (the adapter then re-compresses
 * already-compressed content from scratch). Parent-session inheritance
 * (SessionStateStore.load) covers clones, but an imported session has no
 * parent sidecar next to it either.
 *
 * The session log itself, however, contains every successful compress call:
 * the assistant toolCall arguments (ranges + summaries) and the toolResult
 * panel. Replaying those calls through the kernel's applyCompression on an
 * empty state reproduces the block structure without any host support.
 * Decompress calls are read-only for state (they restore content to a
 * file/inline and never mutate blocks), so compress calls alone are enough.
 */

interface CompressCall {
  entryIndex: number;
  toolCallId: string;
  ranges: Array<{ startRef: string; endRef: string; summary: string; topic?: string; summaryMaxChars?: number }>;
}

type ApplyInput = Parameters<CompressionCore["applyCompression"]>[0];

export interface RebuildReport {
  blocks: number;
  callsApplied: number;
  callsSkipped: number;
  errors: string[];
}

export interface RebuildResult {
  state: CompressionState;
  report: RebuildReport;
}

function toolCallsOf(message: unknown): Array<{ name?: string; id?: string; arguments?: unknown }> {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const calls: Array<{ name?: string; id?: string; arguments?: unknown }> = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type === "toolCall" && b.name && b.id) calls.push({ name: b.name, id: b.id, arguments: b.arguments });
  }
  return calls;
}

function entryMessage(entry: SessionEntry): { role?: string; toolName?: string; toolCallId?: string; isError?: boolean } | undefined {
  if (entry.type !== "message") return undefined;
  return (entry as { message?: { role?: string; toolName?: string; toolCallId?: string; isError?: boolean } }).message;
}

/** Cheap scan: does this log contain at least one non-error compress toolResult? */
export function hasCompressHistory(entries: SessionEntry[]): boolean {
  for (const entry of entries) {
    const m = entryMessage(entry);
    if (!m || m.role !== "toolResult" || m.toolName !== "compress" || !m.toolCallId) continue;
    if (m.isError !== true) return true;
  }
  return false;
}

function parseCompressCall(toolCallId: string, arguments_: unknown, entryIndex: number): CompressCall | null {
  // Mirror handleCompress's arg surface: { content: [{startId, endId, summary,
  // topic?}], topic?, summaryMaxChars? }. Anything else is treated as
  // unparseable and skipped rather than replayed with guessed ranges.
  const args = arguments_ as { content?: unknown; topic?: unknown; summaryMaxChars?: unknown } | null | undefined;
  if (!args || !Array.isArray(args.content) || args.content.length === 0) return null;
  const topLevelTopic = typeof args.topic === "string" ? args.topic : undefined;
  const summaryMaxChars = typeof args.summaryMaxChars === "number" ? args.summaryMaxChars : undefined;
  const ranges: CompressCall["ranges"] = [];
  for (const r of args.content) {
    const item = r as { startId?: unknown; endId?: unknown; summary?: unknown; topic?: unknown };
    if (typeof item.startId !== "string" || typeof item.endId !== "string" || typeof item.summary !== "string") return null;
    ranges.push({
      startRef: item.startId,
      endRef: item.endId,
      summary: sanitizeSummary(item.summary).text,
      topic: typeof item.topic === "string" ? item.topic : topLevelTopic,
      summaryMaxChars,
    });
  }
  return { entryIndex, toolCallId, ranges };
}

/**
 * Replay successful compress calls from the session log against `state`
 * (normally a fresh createInitialState()). Failed, errored, no-op and
 * unparseable calls are skipped — applyCompression batches are atomic, so a
 * rejected call leaves state untouched. `report.blocks` tells the caller
 * whether anything was actually rebuilt (state is returned unchanged when
 * nothing applied).
 */
export function rebuildStateFromLog(input: {
  entries: SessionEntry[];
  state: CompressionState;
  config: ApplyInput["config"];
  core: CompressionCore;
}): RebuildResult {
  const { entries, core } = input;
  const errored = new Set<string>();
  const succeeded = new Set<string>();
  for (const entry of entries) {
    const m = entryMessage(entry);
    if (!m || m.role !== "toolResult" || m.toolName !== "compress" || !m.toolCallId) continue;
    if (m.isError === true) errored.add(m.toolCallId);
    else succeeded.add(m.toolCallId);
  }

  const calls: CompressCall[] = [];
  entries.forEach((entry, entryIndex) => {
    const m = entryMessage(entry);
    if (!m || m.role !== "assistant") return;
    for (const call of toolCallsOf(m as unknown as { content?: unknown })) {
      if (call.name !== "compress" || !call.id || !succeeded.has(call.id)) continue;
      const parsed = parseCompressCall(call.id, call.arguments, entryIndex);
      if (parsed) calls.push(parsed);
      else logWarn("state-rebuild", { event: "unparseable-compress-call", toolCallId: call.id });
    }
  });
  if (calls.length === 0) return { state: input.state, report: { blocks: input.state.blocks.length, callsApplied: 0, callsSkipped: 0, errors: [] } };

  let state = input.state;
  const report: RebuildReport = { blocks: 0, callsApplied: 0, callsSkipped: 0, errors: [] };
  for (const call of calls) {
    let applied: ReturnType<CompressionCore["applyCompression"]>;
    try {
      // Live pipeline order: the context event first runs processTurn (which
      // assigns refs into state.messageRefs — applyCompression resolves
      // startRef/endRef against that map), and only then does the model call
      // compress. Replay mirrors that: processTurn on the prefix up to and
      // including the assistant toolCall entry (the toolResult comes after,
      // exactly like the live path), then applyCompression on the turn output.
      const messages = entriesToCoreMessages(entries.slice(0, call.entryIndex + 1)) as ApplyInput["messages"];
      const tokenCount = messages.reduce((sum, m) => sum + estimateTokensFast(String((m as { text?: unknown }).text ?? "")), 0);
      const turn = core.processTurn({ messages, state, config: input.config, tokenCount });
      state = turn.state;
      applied = core.applyCompression({
        ranges: call.ranges.map((r) => ({ ...r, compressCallId: call.toolCallId })),
        messages: turn.messages as ApplyInput["messages"],
        state,
        config: input.config,
      });
    } catch (e) {
      report.callsSkipped += 1;
      report.errors.push(`throw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const result = applied.result as { blocksCreated?: number; errors?: string[] };
    if ((result.errors?.length ?? 0) > 0 || (result.blocksCreated ?? 0) === 0) {
      report.callsSkipped += 1;
      for (const err of result.errors ?? []) report.errors.push(err);
      continue;
    }
    state = applied.state;
    report.callsApplied += 1;
  }
  report.blocks = state.blocks.length;
  return { state, report };
}
