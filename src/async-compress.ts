import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompressionBlock, CompressionCore, CompressionState, Config, CoreMessage } from "acp-kernel";
import { defaultCountTokens } from "acp-kernel";
import { normalizeRanges, tier3OnlyRewrite, blockSpanLabel } from "./compress-tool.js";
import { sanitizeSummary } from "./summary-sanitize.js";
import { adjustedTokenCount, collectCoveredMessageIds, collectImageTokens, estimateTokens, modelSupportsImages } from "./tokens.js";
import { getSystemPromptText } from "./compat.js";
import { logInfo, logWarn } from "./log.js";
import { ASYNC_CALL_ID_PREFIX, ASYNC_COMPRESS_CUSTOM_TYPE } from "./messages.js";

export { ASYNC_CALL_ID_PREFIX, ASYNC_COMPRESS_CUSTOM_TYPE };

export const ASYNC_FORK_TIMEOUT_MS = 5 * 60_000;
// Cancels that owe no sync nudge: main compressed itself, a newer job replaces
// this one, or the session ended.
const NO_RETRY_CANCELS: ReadonlySet<string> = new Set(["superseded-by-sync-compress", "superseded", "session-reset"]);
export const ASYNC_SUPPORTED_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "claude-bridge"]);
// No request body to replay: the provider runs the fork itself over pi.events (pi-claude-bridge isolated-fork).
const BRIDGE_FORK_APIS: ReadonlySet<string> = new Set(["claude-bridge"]);
// The bridge declines these before any model call: what the main session holds no
// longer matches the request, or is not on disk yet. The next request nudges
// synchronously; only a session that keeps declining stops trying async.
const BRIDGE_TRANSIENT_DECLINES: ReadonlySet<string> = new Set(["stale-context", "unsupported-context", "cut-timeout"]);
const BRIDGE_DECLINE_LIMIT = 3;
export const isBridgeForkApi = (api: unknown): boolean => BRIDGE_FORK_APIS.has(String(api));
export const BRIDGE_FORK_CHANNEL = "claude-bridge:isolated-fork";
// The fork's history ends at the main agent's compress({content: []}) call and
// its "queued" result; the main session carries on with the user's task.
export const ASYNC_FORK_DIRECTIVE = "Background compression pass, queued by the main conversation, which carries on with the user's task: do not continue or answer that task, and do not call any tool other than `compress`. Make exactly one `compress` call with non-empty `content`, citing only message ids already shown above, as the context notice below describes.";
export const ASYNC_QUEUED_TEXT = "Background compression queued: a separate pass chooses the ranges and writes the summaries, and the result is applied at a later request. Continue the task; do not call compress for this again.";
export const ASYNC_ALREADY_QUEUED_TEXT = "Background compression is already queued. Continue the task.";
export const ASYNC_NOTHING_TEXT = "Nothing is compressible right now, so no background compression was queued.";
export const ASYNC_NUDGE_HINT = "Background compression is on: compress({ content: [] }) queues a separate pass that picks the ranges and writes the summaries while you continue. You can still compress ranges yourself as usual.";
export const ASYNC_SYSTEM_HINT = "BACKGROUND COMPRESSION\n\ncompress({ content: [] }) queues a background pass that picks the ranges and writes the summaries while you continue; its result is applied at a later request. Use it when a context notice asks you to compress. compress with ranges works as usual.";
export const asyncSyncGuidance = (why: string): string => `Background compression is not available ${why}. Compress ranges yourself: compress({ content: [{ startId, endId, summary }] }).`;
const RESPONSES_APIS: ReadonlySet<string> = new Set(["openai-responses", "openai-codex-responses"]);

const SERVER_STATE_KEYS = ["previous_response_id", "conversation", "context_management"];

export interface AsyncRange {
  startRef: string;
  endRef: string;
  summary: string;
  topic?: string;
  summaryMaxChars?: number;
}

export interface AsyncCompressRecord {
  version: 1;
  callId: string;
  ranges: AsyncRange[];
  text: string;
}

export interface ViewSnapshot {
  count: number;
  digest: string;
  byRef: Record<string, string>;
  blocks: string[];
}

type Phase = "awaiting-request" | "awaiting-response" | "running" | "ready";

interface Job {
  id: string;
  sid: string;
  phase: Phase;
  nudgeText: string;
  snapshot: ViewSnapshot;
  api: string;
  provider: string;
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: ReturnType<AsyncCompressDeps["pi"]["getThinkingLevel"]>;
  tools: StreamContext["tools"];
  headers?: HeadersLike;
  payload?: unknown;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  ranges?: AsyncRange[];
  triggerCallId: string;
  bridgeFork?: Promise<unknown>;
  bridgeDeclined?: string;
}

interface ForkMessage {
  stopReason: string;
  /** `complete` is set only by the claude-bridge fork; false means the totals are unconfirmed and output may understate. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; complete?: boolean };
  content: ReadonlyArray<{ type: string; name?: string; arguments?: unknown }>;
}

type ProviderLike = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type StreamOptions = NonNullable<Parameters<ProviderLike["streamSimple"]>[2]>;
type StreamContext = Parameters<ProviderLike["streamSimple"]>[1];
type HeadersLike = NonNullable<StreamOptions["headers"]>;

function messageDigest(messages: readonly CoreMessage[], count: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) {
    const m = messages[i]!;
    hash.update(`${m.id}\u0000${m.role}\u0000${m.contentType}\u0000${m.toolCallId ?? ""}\u0000${m.text ?? ""}\u0001`);
  }
  return hash.digest("hex");
}

function activeBlockKeys(state: CompressionState): string[] {
  return state.blocks.filter((b) => b.active).map((b) => `${b.blockId}:${b.runId}`).sort();
}

export function takeSnapshot(view: readonly CoreMessage[], state: CompressionState): ViewSnapshot {
  return {
    count: view.length,
    digest: messageDigest(view, view.length),
    byRef: { ...state.messageRefs.byRef },
    blocks: activeBlockKeys(state),
  };
}

export function snapshotStaleReason(snapshot: ViewSnapshot, view: readonly CoreMessage[], state: CompressionState, ranges: readonly AsyncRange[]): string | null {
  if (view.length < snapshot.count) return "view-shrank";
  if (messageDigest(view, snapshot.count) !== snapshot.digest) return "view-prefix-changed";
  const blocks = activeBlockKeys(state);
  if (blocks.length !== snapshot.blocks.length || blocks.some((b, i) => b !== snapshot.blocks[i])) return "blocks-changed";
  for (const r of ranges) {
    for (const ref of [r.startRef, r.endRef]) {
      if (!/^m\d+$/.test(ref)) continue;
      const then = snapshot.byRef[ref];
      if (then === undefined || state.messageRefs.byRef[ref] !== then) return `ref-rebound:${ref}`;
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function unsupportedPayloadReason(api: string, payload: unknown): string | null {
  if (!ASYNC_SUPPORTED_APIS.has(api)) return `unsupported-api:${api}`;
  if (!isRecord(payload)) return "payload-not-object";
  for (const key of SERVER_STATE_KEYS) if (key in payload) return `server-state:${key}`;
  const list = RESPONSES_APIS.has(api) ? payload.input : payload.messages;
  if (!Array.isArray(list) || list.length === 0) return "payload-shape";
  return null;
}

// The trigger's result must belong to the payload's final tool-result batch:
// nothing the assistant produced may follow it.
export function finalBatchHasResult(api: string, payload: unknown, toolCallId: string): boolean {
  if (!isRecord(payload)) return false;
  const ids = new Set([toolCallId, toolCallId.split("|")[0]!]);
  const assistantItem = (item: Record<string, unknown>) => item.role === "assistant" || item.type === "function_call" || item.type === "reasoning";
  if (RESPONSES_APIS.has(api)) {
    const input = Array.isArray(payload.input) ? payload.input.filter(isRecord) : [];
    const call = input.findIndex((i) => i.type === "function_call" && ids.has(String(i.call_id)));
    const result = input.findIndex((i) => i.type === "function_call_output" && ids.has(String(i.call_id)));
    return call >= 0 && result > call && !input.slice(result + 1).some(assistantItem);
  }
  const messages = Array.isArray(payload.messages) ? payload.messages.filter(isRecord) : [];
  const holdsCall = (m: Record<string, unknown>) =>
    m.role === "assistant" && ((Array.isArray(m.content) && m.content.some((b) => isRecord(b) && b.type === "tool_use" && ids.has(String(b.id))))
      || (Array.isArray(m.tool_calls) && m.tool_calls.some((c) => isRecord(c) && ids.has(String(c.id)))));
  const holdsResult = (m: Record<string, unknown>) =>
    (m.role === "tool" && ids.has(String(m.tool_call_id)))
    || (m.role === "user" && Array.isArray(m.content) && m.content.some((b) => isRecord(b) && b.type === "tool_result" && ids.has(String(b.tool_use_id))));
  const call = messages.findIndex(holdsCall);
  const result = messages.findIndex(holdsResult);
  return call >= 0 && result > call && !messages.slice(result + 1).some(assistantItem);
}

export function forkPayload(api: string, payload: unknown, nudgeText: string): unknown {
  const reason = unsupportedPayloadReason(api, payload);
  if (reason !== null || !isRecord(payload)) throw new Error(reason ?? "payload-not-object");
  const body = structuredClone(payload);
  if (RESPONSES_APIS.has(api)) {
    body.input = [...(body.input as unknown[]), { role: "user", content: [{ type: "input_text", text: nudgeText }] }];
  } else {
    body.messages = [...(body.messages as unknown[]), { role: "user", content: [{ type: "text", text: nudgeText }] }];
  }
  return body;
}

export function rangesFromToolArgs(args: unknown): AsyncRange[] | string {
  if (!isRecord(args)) return "compress arguments are not an object";
  const content = args.content;
  if (typeof content !== "string" && !Array.isArray(content)) return "compress arguments have no content";
  const topic = typeof args.topic === "string" ? args.topic : undefined;
  const summaryMaxChars = typeof args.summaryMaxChars === "number" ? args.summaryMaxChars : undefined;
  const parsed = normalizeRanges({ content: typeof content === "string" ? content : JSON.stringify(content), topic, summaryMaxChars });
  if (typeof parsed === "string") return parsed;
  if (parsed.length === 0) return "no ranges";
  return parsed.map((r) => ({
    startRef: r.startId,
    endRef: r.endId,
    summary: sanitizeSummary(r.summary).text,
    ...(r.topic ?? topic ? { topic: r.topic ?? topic } : {}),
    ...(summaryMaxChars !== undefined ? { summaryMaxChars } : {}),
  }));
}

export type AsyncApplyOutcome =
  | { ok: true; state: CompressionState; newBlocks: CompressionBlock[] }
  | { ok: false; kind: "stale" | "invalid" | "refold"; reason: string };

export function applyAsyncRanges(input: {
  core: CompressionCore;
  view: CoreMessage[];
  state: CompressionState;
  config: Config;
  tokenCount: number;
  snapshot: ViewSnapshot;
  ranges: AsyncRange[];
  callId: string;
}): AsyncApplyOutcome {
  const stale = snapshotStaleReason(input.snapshot, input.view, input.state, input.ranges);
  if (stale !== null) return { ok: false, kind: "stale", reason: stale };
  const probe = input.core.processTurn({ messages: input.view, state: structuredClone(input.state), config: input.config, tokenCount: input.tokenCount });
  const beforeRunIds = new Map(probe.state.blocks.map((b) => [b.blockId, b.runId]));
  const applied = input.core.applyCompression({
    ranges: input.ranges.map((r) => ({ ...r, compressCallId: input.callId })),
    messages: probe.messages,
    state: probe.state,
    config: input.config,
  });
  if (applied.result.errors.length > 0) return { ok: false, kind: "invalid", reason: applied.result.errors.slice(0, 3).join("; ") };
  if (applied.result.blocksCreated === 0) return { ok: false, kind: "invalid", reason: "no blocks created" };
  const newBlocks = applied.state.blocks.filter((b) => beforeRunIds.get(b.blockId) !== b.runId);
  // Kernel in-place refolds keep the block's original compressCallId, so the
  // async record could never be matched to the block again.
  const refolded = newBlocks.filter((b) => beforeRunIds.has(b.blockId));
  if (refolded.length > 0) return { ok: false, kind: "refold", reason: `in-place refold of ${refolded.map((b) => b.blockId).join(", ")}` };
  const rewrite = tier3OnlyRewrite(newBlocks, applied.state.blocks);
  if (rewrite) return { ok: false, kind: "invalid", reason: `tier-3-only rewrite ${rewrite.join(", ")}` };
  return { ok: true, state: applied.state, newBlocks };
}

export function isAsyncBlock(block: CompressionBlock): boolean {
  return block.compressCallId?.startsWith(ASYNC_CALL_ID_PREFIX) === true;
}

export function asyncCarriers(state: CompressionState): Map<string, { label: string; timestamp: number }> {
  const out = new Map<string, { label: string; timestamp: number }>();
  for (const b of state.blocks) {
    if (b.active && isAsyncBlock(b)) out.set(b.blockId, { label: blockSpanLabel(b, state), timestamp: b.createdAt });
  }
  return out;
}

export function asyncEnabledValue(value: unknown, warn: (v: unknown) => void): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  warn(value);
  return false;
}

export interface AsyncCompressDeps {
  pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel" | "getActiveTools" | "getAllTools" | "events">;
  now?: () => number;
  timeoutMs?: number;
}

export class AsyncCompressor {
  private readonly jobs = new Map<string, Job>();
  private readonly triggers = new Map<string, string>();
  private readonly retryReasons = new Map<string, string>();
  private readonly syncRetry = new Set<string>();
  private readonly fallback = new Map<string, string>();
  private readonly notified = new Set<string>();
  private readonly bridgeDeclines = new Map<string, number>();
  private readonly epochs = new Map<string, number>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: AsyncCompressDeps) {
    this.timeoutMs = deps.timeoutMs ?? ASYNC_FORK_TIMEOUT_MS;
  }

  isActive(sid: string): boolean {
    return this.jobs.has(sid) || this.triggers.has(sid);
  }

  /** Changes whenever the session's queued work is cancelled or reset. */
  epoch(sid: string): number {
    return this.epochs.get(sid) ?? 0;
  }

  /** Records the main agent's compress({content: []}); the next request starts the job. */
  trigger(sid: string, toolCallId: string): void {
    this.triggers.set(sid, toolCallId);
    logInfo("async-compress", { sid, event: "triggered", toolCallId });
  }

  takeTrigger(sid: string): string | undefined {
    const id = this.triggers.get(sid);
    this.triggers.delete(sid);
    return id;
  }

  dropTrigger(sid: string, reason: string): void {
    const id = this.takeTrigger(sid);
    if (id === undefined) return;
    this.syncRetry.add(sid);
    this.retryReasons.set(sid, reason);
    logInfo("async-compress", { sid, event: "trigger-dropped", toolCallId: id, reason });
  }

  /** Why the last job handed its nudge back to the sync path, read once. */
  takeRetryReason(sid: string): string | undefined {
    const reason = this.retryReasons.get(sid);
    this.retryReasons.delete(sid);
    return reason;
  }

  jobApi(sid: string): string | undefined {
    return this.jobs.get(sid)?.api;
  }

  fallbackReason(sid: string): string | undefined {
    return this.fallback.get(sid);
  }

  requestSyncRetry(sid: string, reason?: string): void {
    this.syncRetry.add(sid);
    if (reason !== undefined) this.retryReasons.set(sid, reason);
  }

  takeSyncRetry(sid: string): boolean {
    return this.syncRetry.delete(sid);
  }

  phase(sid: string): Phase | undefined {
    return this.jobs.get(sid)?.phase;
  }

  start(sid: string, init: { nudgeText: string; snapshot: ViewSnapshot; model: NonNullable<ExtensionContext["model"]>; triggerCallId: string }): string {
    this.cancel(sid, "superseded");
    const id = randomUUID();
    this.jobs.set(sid, {
      id,
      sid,
      phase: "awaiting-request",
      nudgeText: init.nudgeText,
      snapshot: init.snapshot,
      triggerCallId: init.triggerCallId,
      api: String(init.model.api),
      provider: String(init.model.provider),
      model: { ...init.model },
      thinkingLevel: this.deps.pi.getThinkingLevel(),
      tools: this.activeTools(),
      controller: new AbortController(),
    });
    logInfo("async-compress", { sid, event: "job-created", job: id, api: init.model.api, view: init.snapshot.count });
    return id;
  }

  onHeaders(sid: string, headers: HeadersLike): void {
    const job = this.jobs.get(sid);
    if (job && job.phase === "awaiting-request" && job.headers === undefined) job.headers = headers;
  }

  onPayload(sid: string, payload: unknown, ctx: ExtensionContext): void {
    const job = this.jobs.get(sid);
    if (!job || job.phase !== "awaiting-request" || BRIDGE_FORK_APIS.has(job.api)) return;
    const reason = unsupportedPayloadReason(job.api, payload);
    if (reason !== null) {
      this.abandon(job, `capture:${reason}`, true);
      this.markFallback(sid, reason, ctx);
      return;
    }
    if (!finalBatchHasResult(job.api, payload, job.triggerCallId)) {
      this.abandon(job, "capture:trigger-missing", true);
      return;
    }
    job.payload = payload;
    job.phase = "awaiting-response";
  }

  onResponse(sid: string, status: number, ctx: ExtensionContext): void {
    const job = this.jobs.get(sid);
    if (!job || job.phase !== "awaiting-response") return;
    if (status >= 400) {
      this.abandon(job, `main-request-status:${status}`, true);
      return;
    }
    this.launch(job, ctx);
  }

  onStreamStart(sid: string, ctx: ExtensionContext): void {
    const job = this.jobs.get(sid);
    if (!job) return;
    if (job.phase === "awaiting-response" && job.api === "openai-codex-responses") this.launch(job, ctx);
    else if (job.phase === "awaiting-request" && BRIDGE_FORK_APIS.has(job.api)) this.launchBridge(job, ctx);
  }

  private launch(job: Job, ctx: ExtensionContext): void {
    job.phase = "running";
    void this.run(job, ctx);
  }

  // The provider snapshots the request it is serving when it accepts, so this must
  // run while that request is still the one streaming.
  private launchBridge(job: Job, ctx: ExtensionContext): void {
    let accepted: Promise<unknown> | undefined;
    let accepts = 0;
    try {
      this.deps.pi.events.emit(BRIDGE_FORK_CHANNEL, {
        version: 1,
        piSessionId: job.sid,
        prompt: `${ASYNC_FORK_DIRECTIVE}\n\n${job.nudgeText}`,
        captureTool: "compress",
        cutAfterToolResult: job.triggerCallId,
        signal: job.controller.signal,
        // Returns whether this acceptance was taken, so a later acceptor can skip the work.
        accept: (result: unknown): boolean => {
          accepts++;
          if (!isRecord(result) || typeof result.then !== "function") return false;
          const promise = Promise.resolve(result);
          promise.catch(() => {});
          if (accepted) return false;
          accepted = promise;
          return true;
        },
      });
    } catch {
      logWarn("async-compress", { sid: job.sid, event: "bridge-fork-listener-threw", job: job.id });
    }
    if (accepts > 1) logWarn("async-compress", { sid: job.sid, event: "bridge-fork-extra-accept", job: job.id, accepts });
    if (!accepted) {
      this.abandon(job, "bridge-fork-unavailable", true);
      this.markFallback(job.sid, "bridge-fork-unavailable", ctx);
      return;
    }
    job.bridgeFork = accepted;
    this.launch(job, ctx);
  }

  onMainFailed(sid: string, reason: string, aborted = false): void {
    this.dropTrigger(sid, reason);
    const job = this.jobs.get(sid);
    if (!job) return;
    if (job.phase === "awaiting-request" || job.phase === "awaiting-response") {
      this.abandon(job, reason, true);
    } else if (aborted && job.phase === "running") {
      this.abandon(job, reason, true);
    }
  }

  cancel(sid: string, reason: string): void {
    this.epochs.set(sid, this.epoch(sid) + 1);
    const owe = !NO_RETRY_CANCELS.has(reason);
    if (this.triggers.delete(sid)) {
      if (owe) this.requestSyncRetry(sid, reason);
      logInfo("async-compress", { sid, event: "trigger-dropped", reason });
    }
    const job = this.jobs.get(sid);
    if (!job) return;
    this.abandon(job, reason, owe);
  }

  resetSession(sid: string): void {
    // The epoch is kept: a queue awaiting its decision across a reset must still see it changed.
    this.cancel(sid, "session-reset");
    this.syncRetry.delete(sid);
    this.fallback.delete(sid);
    this.notified.delete(sid);
    this.bridgeDeclines.delete(sid);
    this.retryReasons.delete(sid);
  }

  takeReady(sid: string): { id: string; ranges: AsyncRange[]; snapshot: ViewSnapshot } | undefined {
    const job = this.jobs.get(sid);
    if (!job || job.phase !== "ready" || !job.ranges) return undefined;
    this.jobs.delete(sid);
    return { id: job.id, ranges: job.ranges, snapshot: job.snapshot };
  }

  markFallback(sid: string, reason: string, ctx: ExtensionContext | undefined): void {
    if (!this.fallback.has(sid)) this.fallback.set(sid, reason);
    logWarn("async-compress", { sid, event: "sync-fallback", reason });
    if (!this.notified.has(sid)) {
      this.notified.add(sid);
      if (ctx?.hasUI) ctx.ui.notify(`[ACP] async compression unavailable (${reason}) — falling back to synchronous nudges for this session.`, "warning");
    }
  }

  private abandon(job: Job, reason: string, retrySync: boolean): void {
    if (this.jobs.get(job.sid) === job) this.jobs.delete(job.sid);
    if (job.timer) clearTimeout(job.timer);
    job.controller.abort();
    if (retrySync) {
      this.syncRetry.add(job.sid);
      this.retryReasons.set(job.sid, reason);
    }
    logInfo("async-compress", { sid: job.sid, event: "job-dropped", job: job.id, phase: job.phase, reason, syncRetry: retrySync });
  }

  private async run(job: Job, ctx: ExtensionContext): Promise<void> {
    const started = (this.deps.now ?? Date.now)();
    let timedOut = false;
    const deadline = new Promise<"deadline">((resolve) => {
      job.timer = setTimeout(() => {
        timedOut = true;
        job.controller.abort();
        resolve("deadline");
      }, this.timeoutMs);
    });
    const fork = job.bridgeFork
      ? job.bridgeFork.then((result) => {
          const message = bridgeForkMessage(result);
          if (message.stopReason === "error") {
            const reason = bridgeFailureReason(result);
            logWarn("async-compress", { sid: job.sid, event: "bridge-fork-declined", job: job.id, reason });
            if (isRecord(result) && result.ok === false) job.bridgeDeclined = reason;
          }
          return message;
        })
      : this.fork(job, ctx);
    fork.catch(() => {});
    try {
      // Settles even when the provider or auth lookup ignores the abort signal.
      const message = await Promise.race([fork, deadline]);
      if (this.jobs.get(job.sid) !== job) return;
      if (message === "deadline") {
        this.abandon(job, "fork-timeout", true);
        this.markFallback(job.sid, "fork-timeout", ctx);
        return;
      }
      const usage = message.usage;
      logInfo("async-compress", {
        sid: job.sid,
        event: "fork-finished",
        job: job.id,
        stopReason: message.stopReason,
        ms: (this.deps.now ?? Date.now)() - started,
        input: usage?.input ?? null,
        output: usage?.output ?? null,
        cacheRead: usage?.cacheRead ?? null,
        cacheWrite: usage?.cacheWrite ?? null,
        usageComplete: usage?.complete ?? null,
      });
      if (job.bridgeDeclined !== undefined && BRIDGE_TRANSIENT_DECLINES.has(job.bridgeDeclined)) {
        this.abandon(job, `bridge-declined:${job.bridgeDeclined}`, true);
        const declines = (this.bridgeDeclines.get(job.sid) ?? 0) + 1;
        this.bridgeDeclines.set(job.sid, declines);
        if (declines >= BRIDGE_DECLINE_LIMIT) this.markFallback(job.sid, "bridge-fork-declined", ctx);
        return;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        this.abandon(job, job.bridgeDeclined !== undefined ? `bridge-declined:${job.bridgeDeclined}` : `fork-${message.stopReason}`, true);
        this.markFallback(job.sid, timedOut ? "fork-timeout" : "fork-error", ctx);
        return;
      }
      const call = message.content.find((c) => c.type === "toolCall" && c.name === "compress");
      const content = call && isRecord(call.arguments) ? call.arguments.content : undefined;
      if (!call || (Array.isArray(content) && content.length === 0)) {
        this.abandon(job, "fork-no-compress-call", true);
        return;
      }
      const ranges = rangesFromToolArgs(call.arguments);
      if (typeof ranges === "string") {
        this.abandon(job, "fork-invalid-args", true);
        this.markFallback(job.sid, "invalid-compress-args", ctx);
        return;
      }
      job.ranges = ranges;
      job.phase = "ready";
      this.bridgeDeclines.delete(job.sid);
      logInfo("async-compress", { sid: job.sid, event: "result-ready", job: job.id, ranges: ranges.length });
    } catch (e) {
      if (this.jobs.get(job.sid) !== job) return;
      // Provider error text can echo credentials: log the error class only.
      logWarn("async-compress", { sid: job.sid, event: "fork-threw", job: job.id, errorKind: e instanceof Error ? e.name : typeof e });
      this.abandon(job, "fork-threw", true);
      this.markFallback(job.sid, "fork-error", ctx);
    } finally {
      if (job.timer) clearTimeout(job.timer);
    }
  }

  private async fork(job: Job, ctx: ExtensionContext): Promise<ForkMessage> {
    const provider = ctx.modelRegistry.getProvider(job.provider);
    if (!provider) throw new Error("unknown provider");
    const auth = await ctx.modelRegistry.getProviderAuth(job.provider);
    if (job.controller.signal.aborted) throw new Error("cancelled before transport");
    const payload = forkPayload(job.api, job.payload, `${ASYNC_FORK_DIRECTIVE}\n\n${job.nudgeText}`);
    const options: StreamOptions = {
      apiKey: auth?.auth.apiKey,
      env: auth?.env,
      headers: job.headers ? structuredClone(job.headers) : undefined,
      sessionId: job.sid,
      signal: job.controller.signal,
      onPayload: () => payload,
      // Codex WebSockets are cached per session id with continuation state; the fork must not share them.
      ...(job.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
      ...(job.thinkingLevel !== "off" ? { reasoning: job.thinkingLevel } : {}),
    };
    const requestModel = auth?.auth.baseUrl ? { ...job.model, baseUrl: auth.auth.baseUrl } : job.model;
    const context: StreamContext = { systemPrompt: "", messages: [], tools: job.tools };
    return provider.streamSimple(requestModel, context, options).result();
  }

  private activeTools(): StreamContext["tools"] {
    const active = new Set(this.deps.pi.getActiveTools());
    return this.deps.pi.getAllTools()
      .filter((t) => active.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }
}

function isUsage(v: unknown): v is NonNullable<ForkMessage["usage"]> {
  return isRecord(v) && ["input", "output", "cacheRead", "cacheWrite"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= 0);
}

function bridgeUsage(v: unknown): ForkMessage["usage"] {
  if (!isUsage(v)) return undefined;
  const { input, output, cacheRead, cacheWrite, complete } = v;
  return { input, output, cacheRead, cacheWrite, ...(typeof complete === "boolean" ? { complete } : {}) };
}

function bridgeFailureReason(result: unknown): string {
  const reason = isRecord(result) ? result.reason : undefined;
  return typeof reason === "string" && /^[a-z-]{1,40}$/.test(reason) ? reason : "malformed";
}

/** Maps the bridge's fork result onto the shape a provider fork returns; anything malformed is an error. */
export function bridgeForkMessage(result: unknown): ForkMessage {
  if (!isRecord(result) || typeof result.ok !== "boolean") return { stopReason: "error", content: [] };
  const usage = bridgeUsage(result.usage);
  if (result.ok) {
    if (!isRecord(result.args)) return { stopReason: "error", content: [] };
    return { stopReason: "toolUse", ...(usage ? { usage } : {}), content: [{ type: "toolCall", name: "compress", arguments: result.args }] };
  }
  if (result.reason === "no-capture") return { stopReason: "stop", ...(usage ? { usage } : {}), content: [] };
  if (result.reason === "aborted") return { stopReason: "aborted", ...(usage ? { usage } : {}), content: [] };
  return { stopReason: "error", ...(usage ? { usage } : {}), content: [] };
}

/** Caller holds the session lock. Order: validate → append replay record
 *  (failure discards the result) → save sidecar → adopt state. */
export async function applyReadyAsyncResult(input: {
  compressor: AsyncCompressor;
  pi: Pick<ExtensionAPI, "appendEntry">;
  ctx: ExtensionContext;
  core: CompressionCore;
  config: Config;
  view: CoreMessage[];
  state: CompressionState;
  entries: Parameters<typeof collectImageTokens>[0];
  save: (state: CompressionState) => Promise<void>;
  enabled: boolean;
}): Promise<{ state: CompressionState; record: AsyncCompressRecord } | undefined> {
  const { compressor, ctx } = input;
  const sid = ctx.sessionManager.getSessionId();
  if (!input.enabled) {
    compressor.cancel(sid, "disabled");
    return undefined;
  }
  const ready = compressor.takeReady(sid);
  if (!ready) return undefined;
  const callId = `${ASYNC_CALL_ID_PREFIX}${ready.id}`;
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const imageTokens = collectImageTokens(input.entries, modelSupportsImages(ctx.model));
  const prelim = estimateTokens(input.view, collectCoveredMessageIds(input.state), imageTokens) + systemPromptTokens;
  const tokenCount = adjustedTokenCount(input.core, input.view, input.state, input.config, prelim, imageTokens, systemPromptTokens);
  let outcome: AsyncApplyOutcome;
  try {
    outcome = applyAsyncRanges({ core: input.core, view: input.view, state: input.state, config: input.config, tokenCount, snapshot: ready.snapshot, ranges: ready.ranges, callId });
  } catch (e) {
    outcome = { ok: false, kind: "invalid", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!outcome.ok) {
    logInfo("async-compress", { sid, event: "result-discarded", job: ready.id, kind: outcome.kind, reason: outcome.reason });
    if (outcome.kind === "invalid") compressor.markFallback(sid, "invalid-result", ctx);
    compressor.requestSyncRetry(sid, `result-${outcome.kind}`);
    return undefined;
  }
  const label = outcome.newBlocks.map((b) => blockSpanLabel(b, outcome.state)).join(", ");
  const record: AsyncCompressRecord = { version: 1, callId, ranges: ready.ranges, text: `▣ ACP async compress | blocks: ${label}` };
  try {
    if (typeof input.pi.appendEntry !== "function") throw new Error("appendEntry unavailable");
    input.pi.appendEntry(ASYNC_COMPRESS_CUSTOM_TYPE, record);
  } catch (e) {
    logWarn("async-compress", { sid, event: "record-append-failed", job: ready.id, error: e instanceof Error ? e.message : String(e) });
    compressor.markFallback(sid, "record-append-failed", ctx);
    compressor.requestSyncRetry(sid, "record-append-failed");
    return undefined;
  }
  await input.save(outcome.state);
  logInfo("async-compress", { sid, event: "applied", job: ready.id, callId, blocks: outcome.newBlocks.map((b) => b.blockId) });
  if (ctx.hasUI) ctx.ui.notify(`[ACP] ${record.text}`);
  return { state: outcome.state, record };
}
