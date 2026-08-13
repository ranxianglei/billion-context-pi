import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { Type, type Static } from "typebox";
import { delegateStatusWidget } from "./fleet-widget.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { debug, logError, logInfo, logWarn } from "./log.js";
import { attachWatchdogs } from "./delegate-watchdog.js";
import { parseEventLine, activityLines, newPortion, ThinkingCollector, type Usage } from "./delegate-events.js";
import { isPiHost } from "./runtime.js";

const MAX_DEPTH = 2;
const SYNC_TIMEOUT_MS = 5 * 60_000;
const EOF_GRACE_MS = 10_000;
const SETTLED_GRACE_MS = 10_000;
const IDLE_GRACE_MS = 5 * 60_000;
const ASYNC_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const RESULT_SUMMARY_CHARS = 500;
const OUT_DIR = join(tmpdir(), "acp-delegate");

export function delegateSpawnOptions(cwd: string, env: NodeJS.ProcessEnv): SpawnOptions {
  return {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  };
}

const PI_CLI_ENTRY_RE = /[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/;
const PI_PACKAGE_REL = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");

function probeUpFromArgv(argv1: string): string | null {
  let dir = resolvePath(dirname(argv1) || process.cwd());
  for (;;) {
    const candidate = join(dir, "node_modules", PI_PACKAGE_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function piCliGlobalCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    if (env.APPDATA) candidates.push(join(env.APPDATA, "npm", "node_modules", PI_PACKAGE_REL));
  } else {
    const home = env.HOME ?? env.USERPROFILE;
    if (home) candidates.push(join(home, ".local", "lib", "node_modules", PI_PACKAGE_REL));
    candidates.push(join("/usr/local", "lib", "node_modules", PI_PACKAGE_REL));
    candidates.push(join("/usr", "lib", "node_modules", PI_PACKAGE_REL));
  }
  return candidates;
}

/** Resolve the pi CLI entry for delegate child processes.
 *  argv[1] is only the pi CLI under a CLI host; embedded hosts (e.g. pi-web)
 *  run the SDK inside another node process, so probe instead. Non-pi hosts
 *  (omp) keep argv[1] untouched. */
export function resolvePiCliEntry(
  argv1: string,
  env: NodeJS.ProcessEnv = process.env,
  piHost = true,
): string {
  const explicit = env.PI_CLI_PATH;
  if (explicit) return explicit;
  if (argv1 && PI_CLI_ENTRY_RE.test(argv1)) return argv1;
  if (piHost) {
    const probed = probeUpFromArgv(argv1);
    if (probed) return probed;
    for (const candidate of piCliGlobalCandidates(env)) {
      if (existsSync(candidate)) return candidate;
    }
    logWarn("delegate", { event: "cli-entry-unresolved", argv1, fallback: "argv[1]" });
  }
  return argv1;
}

/** ACP context-management tools that every restricted delegate must retain
 *  so it can manage its own context under billion-context-pi. */
const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"] as const;

/** Roles that receive a restricted tool allowlist. Worker is intentionally
 *  absent - it runs on Pi's full default toolset (all extension/custom tools
 *  stay active) so primary-task delegation is not degraded. */
const RESTRICTED_TOOLS = "read,bash,grep,find,ls";

interface AgentDef {
  prompt: string;
  tools: string;
  /** When true, the role's `tools` are passed as a `--tools` allowlist to the
   *  child process, and ACP context tools are automatically appended. When
   *  absent/false, the child runs on Pi's full default toolset. */
  restricted?: boolean;
}

// Minimal roster. The tool description lists these so the model knows how to
// pick one — no separate prompt injection needed (keeps fixed cost tiny).
const AGENTS: Record<string, AgentDef> = {
  reviewer: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a senior code reviewer with read-only access.
Read the given code and report: bugs, security/safety risks, correctness issues, and concrete improvement suggestions.
Be specific — cite file:line for every finding. Do NOT modify any files; only read and report.`,
  },
  researcher: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a code researcher with read-only access.
Investigate the codebase to answer the question thoroughly. Report findings with exact file:line references, function/type signatures, and relevant code snippets.
Do NOT modify any files; only read and report.`,
  },
  worker: {
    tools: "read,edit,write,bash",
    prompt: `You are a precise implementer.
Make exactly the requested code changes — minimal, focused, following existing project conventions (check AGENTS.md first if present).
After editing, briefly summarize what you changed and why. Do not expand scope.`,
  },
  planner: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a technical planner with read-only access.
Analyze the task and produce a concrete, ordered step-by-step implementation plan with rationale for each step.
Cite file:line for code you reference. Do NOT modify any files; only read and propose.`,
  },
  oracle: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are an expert advisor with read-only access.
Answer the question concisely with clear reasoning. Cite file:line when referencing code. Do NOT modify any files.`,
  },
};

const AGENT_NAMES = Object.keys(AGENTS);

// ─── Run registry (module-level, shared across tools) ───────────────────────

type RunStatus = "running" | "completed" | "failed" | "cancelled";

interface DelegateRun {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  exitCode?: number | null;
  child?: ChildProcess;
  result?: { code: number | null; file: string; body: string };
  consumed?: boolean;
  /** True once the close handler injected the result as a system
   *  notification (sendUserMessage succeeded). Lets a later wait() avoid
   *  re-delivering the same payload. */
  injected?: boolean;
  /** Watchdog reason string when the run was force-terminated ("no output for
   *  5m", "30m limit"); surfaced in completion headers as "(timed out: ...)". */
  timedOut?: string;
  waiter?: () => void;
  /** Accumulated LLM usage from the delegate (from message_end events). */
  usage?: Usage;
  /** True once a wait/cancel tool has returned usage — prevents double-count. */
  usageReported?: boolean;
  /** True once agent_settled fired; a watchdog kill after this is stuck teardown, not a timeout. */
  agentSettled?: boolean;
}
const runs = new Map<string, DelegateRun>();

/** Cumulative delegate usage across the session (separate display mode). */
let delegateUsageTotal: Usage | undefined;

export function addDelegateUsage(u: Usage): void {
  delegateUsageTotal = delegateUsageTotal
    ? accumulateUsage(delegateUsageTotal, u)
    : u;
}

export function getDelegateUsage(): Usage | undefined {
  return delegateUsageTotal;
}

export function resetDelegateUsage(): void {
  delegateUsageTotal = undefined;
}

let delegateDisplayUsage: "merged" | "separate" = "separate";

export function setDelegateDisplayUsage(mode: "merged" | "separate"): void {
  delegateDisplayUsage = mode;
}


/** Snapshot of currently-running delegate runs, for the TUI status widget. */
export function runningRunsSnapshot(): { runId: string; agent: string; task: string; startedAt: number }[] {
  const out: { runId: string; agent: string; task: string; startedAt: number }[] = [];
  for (const r of runs.values()) {
    if (r.status === "running") out.push({ runId: r.runId, agent: r.agent, task: r.task, startedAt: r.startedAt });
  }
  return out;
}

/** Minimal writable surface accepted by makeEventApplier — real WriteStreams
 *  in production, in-memory collectors in tests. */
export interface EventApplierWriters {
  reply: { write(chunk: string): void };
  activity: { write(chunk: string): void } | null;
}

export interface EventApplier {
  handleEventLine(line: string): void;
  getReplyText(): string;
  /** omp fallback: `-p` prints the plain reply as raw stdout; append it
   *  straight through (no event parsing). */
  appendRaw(text: string): void;
}

/** Applies parsed delegate JSON-event lines to the live reply/activity files.
 *  Extracted from the spawn closure so the write logic is unit-testable.
 *
 *  reply-delta (text_delta) is streamed to the reply file as it arrives;
 *  reply-complete (text_end) carries the authoritative full content of the
 *  text block — any portion not already written is appended (tracked via
 *  msgWritten) so a final answer that arrives without preceding deltas is
 *  never lost from the file. */
export function makeEventApplier(
  opts: { showThinking: boolean; onUsage?: (usage: Usage) => void; onSettled?: () => void },
  writers: EventApplierWriters,
): EventApplier {
  let replyText = "";
  let msgWritten = 0;
  const lastToolText = new Map<string, string>();
  const thinking = new ThinkingCollector(opts.showThinking);
  const flushThinking = (): void => {
    const line = thinking.flush();
    if (line) writers.activity?.write(line);
  };
  const handleEventLine = (line: string): void => {
    const ev = parseEventLine(line);
    if (!ev) return;
    if (ev.kind === "usage-update") {
      opts.onUsage?.(ev.usage);
      return;
    }
    if (ev.kind === "thinking-delta") {
      thinking.push(ev.delta);
      return;
    }
    if (ev.kind === "thinking-end") {
      flushThinking();
      return;
    }
    if (ev.kind === "agent-settled") {
      flushThinking();
      opts.onSettled?.();
      return;
    }
    if (ev.kind === "reply-delta") {
      flushThinking();
      replyText += ev.delta;
      msgWritten += ev.delta.length;
      writers.reply.write(ev.delta);
      return;
    }
    if (ev.kind === "reply-complete") {
      flushThinking();
      const tail = ev.content.slice(msgWritten);
      if (tail) {
        writers.reply.write(tail);
        debug.event("reply-complete-tail", { tailLen: tail.length, contentLen: ev.content.length });
      }
      if (ev.content.length < msgWritten) {
        logWarn("delegate", { event: "reply-content-shorter-than-delta", contentLen: ev.content.length, written: msgWritten });
      }
      msgWritten = 0;
      replyText = ev.content;
      return;
    }
    if (ev.kind === "tool-update") {
      flushThinking();
      const prev = lastToolText.get(ev.toolCallId) ?? "";
      const add = newPortion(ev.text, prev);
      lastToolText.set(ev.toolCallId, ev.text);
      if (add) writers.activity?.write(add.endsWith("\n") ? add : `${add}\n`);
      return;
    }
    flushThinking();
    const lines = activityLines(ev, { showThinking: opts.showThinking });
    if (lines.length) writers.activity?.write(lines.join(""));
  };
  return {
    handleEventLine,
    getReplyText: () => replyText,
    appendRaw(text: string) {
      replyText += text;
      writers.reply.write(text);
    },
  };
}

const WAIT_TIMEOUT_MS_DEFAULT = 10_000;
const WAIT_TIMEOUT_MS_MAX = 300_000;

const DelegateParams = Type.Object({
  agent: Type.String({
    description: `Role of the delegate. One of: ${AGENT_NAMES.join(", ")}. See tool description for what each does.`,
  }),
  task: Type.String({
    description: "The self-contained task to hand off. State purpose, scope, and any constraints explicitly.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the delegate (default: current project dir)." }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Model override as "provider/id" (default: inherit current model).' }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description: "If true (default), return immediately with a runId. In long-lived sessions (interactive/rpc) a short notification is injected into chat when the delegate finishes; in one-shot sessions (print/json, e.g. `pi -p` / SDK) async auto-downgrades to sync and the result is returned here. If false, always block and return the output here.",
    }),
  ),
  showThinking: Type.Optional(
    Type.Boolean({
      description: "If true, the delegate's thinking deltas are also written to the live activity file (default: false — only tool activity is shown).",
    }),
  ),
});

type DelegateArgs = Static<typeof DelegateParams>;

const CancelParams = Type.Object({
  runId: Type.String({ description: "The runId returned by acp_delegate to cancel." }),
});

const WaitParams = Type.Object({
  runId: Type.String({ description: "The runId returned by acp_delegate to wait for." }),
  timeout: Type.Optional(
    Type.Integer({
      description: `Maximum milliseconds to block waiting for the result. Default ${WAIT_TIMEOUT_MS_DEFAULT} (10s); max ${WAIT_TIMEOUT_MS_MAX} (300s). If the delegate does not finish in time, returns "failed (not ready)" — do NOT keep waiting or retry; go do other work, and a completion notification will still be injected when it completes.`,
    }),
  ),
});

/** Extract non-negative cost values from a Usage.cost object. Returns undefined
 *  if all cost fields are 0 or negative. */
function safeCost(u: Usage): Usage["cost"] | undefined {
  if (u.cost.input > 0 || u.cost.output > 0 || u.cost.cacheRead > 0 || u.cost.cacheWrite > 0 || u.cost.total > 0) {
    return {
      input: u.cost.input > 0 ? u.cost.input : 0,
      output: u.cost.output > 0 ? u.cost.output : 0,
      cacheRead: u.cost.cacheRead > 0 ? u.cost.cacheRead : 0,
      cacheWrite: u.cost.cacheWrite > 0 ? u.cost.cacheWrite : 0,
      total: u.cost.total > 0 ? u.cost.total : 0,
    };
  }
  return undefined;
}

export function accumulateUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}


const agentListLine = (name: string): string => {
  const def = AGENTS[name];
  if (!def) return "";
  const blurb: Record<string, string> = {
    reviewer: "read-only code review (bugs/risks, file:line)",
    researcher: "read-only codebase investigation",
    worker: "make code changes (read+edit+write)",
    planner: "analyze + propose step-by-step plan (read-only)",
    oracle: "answer questions / advise (read-only)",
  };
  return `  • ${name} - ${blurb[name]} [tools: ${def.tools}${def.restricted ? " + ACP context tools" : ""}]`;
};

export function makeDelegateTool(pi: ExtensionAPI): ToolDefinition<typeof DelegateParams> {
  return {
    name: "acp_delegate",
    label: "ACP Delegate",
    description: `Hand a self-contained task to a fresh sub-agent running in a clean context (its own pi process). Use to get focused review/investigation/implementation without polluting the main context, or to run several tasks concurrently.

Agents (pick by name):
${AGENT_NAMES.map(agentListLine).join("\n")}

Behavior:
• async=true (default): returns immediately with a runId. The delegate runs in the background. Call acp_delegate_wait({ runId }) to block for its result (up to a timeout); if you let the timeout lapse, or never call wait, a short completion notification (status + file path) is still injected into this chat when it finishes. In one-shot sessions (print/json) async auto-downgrades to sync so the result is returned inline within the same turn. Call acp_delegate again to launch more runs in parallel.
• async=false: blocks until the delegate finishes. The full output is saved to a file; the tool result contains the path. Use the \`read\` tool to open the file for the complete content.

There is NO non-blocking status tool. To get a delegate's result, call acp_delegate_wait with the runId — it blocks until the run finishes or the timeout elapses. Use acp_delegate_cancel only to stop a run you no longer want.

The delegate runs in its own clean pi process — it does NOT see this conversation's context. Give it everything it needs (paths, goals, constraints). Full results always go to a file so the chat context stays small.`,
    promptSnippet:
      'acp_delegate({ agent: "reviewer", task: "Review src/index.ts for race conditions" })',
    promptGuidelines: [
      "Delegate to get a focused result in a clean context, or to parallelize independent work.",
      "The sub-agent has NO access to this conversation — write a fully self-contained task.",
      "Prefer async=true and launch several; results arrive back automatically when each finishes.",
      "For changes you must apply yourself, delegate read-only investigation (reviewer/researcher/oracle) and keep the main context as the sole writer.",
    ],
    parameters: DelegateParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const args = params as DelegateArgs;
      const outcome = await runDelegate(pi, args, ctx, signal);
      return { details: undefined, content: [{ type: "text", text: outcome }] };
    },
  };
}

function formatRunResult(run: DelegateRun): string {
  const timeoutNote = run.timedOut ? ` (timed out: ${run.timedOut})` : "";
  const header =
    run.status === "completed"
      ? `Delegate **${run.agent}** (runId \`${run.runId}\`) completed (exit ${run.exitCode ?? "?"})${timeoutNote}${remainingLineForWait(run.runId)}`
      : `Delegate **${run.agent}** (runId \`${run.runId}\`) ${run.status} (exit ${run.exitCode ?? "?"})${timeoutNote}${remainingLineForWait(run.runId)}`;
  return formatPayload(header, run.result?.file ?? "", run.task, run.result?.body);
}

/** Count of OTHER delegates still running (excludes self), for wait-path results. */
function remainingLineForWait(selfRunId: string): string {
  const remaining = Array.from(runs.values()).filter((r) => r.status === "running" && r.runId !== selfRunId).length;
  return remaining > 0 ? ` ${remaining} delegate${remaining === 1 ? " is" : "s are"} still running.` : "";
}

/** If the delegate already delivered its result via a system notification
 *  (the close handler injected before this wait was called), return a short
 *  "already delivered" message pointing at the result file, so the model
 *  never sees the same result twice (once via the injected notification,
 *  once via this tool result). Returns null when the run was NOT injected,
 *  in which case the caller delivers the full payload via formatRunResult(). */
export function injectedWaitMessage(
  run: { injected?: boolean; result?: { file: string } },
  runId: string,
  remainingLine: string,
): string | null {
  if (!run.injected) return null;
  const file = run.result?.file;
  const fileLine = file ? ` If you need details, read the result file: \`${file}\`.` : "";
  return `Delegate \`${runId}\` already delivered its result via a system notification when it finished — no need to wait on it again.${remainingLine}${fileLine}`;
}

/** Build usage-aware return payload. Sets usageReported=true so subsequent
 *  waits on the same run skip usage. */
export function buildWaitResult(
  run: DelegateRun,
  content: string,
  mode: "merged" | "separate" = "separate",
  contentType = "text" as const,
): { details: undefined; content: { type: "text"; text: string }[]; usage?: AgentToolResult<unknown>["usage"] } {
  if (run.usage && !run.usageReported) {
    run.usageReported = true;
    if (mode === "merged") {
      const cost = safeCost(run.usage);
      return {
        details: undefined,
        content: [{ type: contentType, text: content }],
        usage: { ...run.usage, cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as AgentToolResult<unknown>["usage"],
      };
    } else {
      addDelegateUsage(run.usage);
    }
  }
  return { details: undefined, content: [{ type: contentType, text: content }] };
}

/** Build usage-aware result for cancel tool. */
export function buildCancelResult(
  run: DelegateRun,
  content: string,
  mode: "merged" | "separate" = "separate",
): { details: undefined; content: { type: "text"; text: string }[]; usage?: AgentToolResult<unknown>["usage"] } {
  if (run.usage && !run.usageReported) {
    run.usageReported = true;
    if (mode === "merged") {
      const cost = safeCost(run.usage);
      return {
        details: undefined,
        content: [{ type: "text", text: content }],
        usage: { ...run.usage, cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as AgentToolResult<unknown>["usage"],
      };
    } else {
      addDelegateUsage(run.usage);
    }
  }
  return { details: undefined, content: [{ type: "text", text: content }] };
}

export function makeDelegateWaitTool(_pi: ExtensionAPI): ToolDefinition<typeof WaitParams> {
  return {
    name: "acp_delegate_wait",
    label: "ACP Delegate Wait",
    description:
      "Block until an acp_delegate async run finishes, then return its result (status + file path). This is the ONLY way to fetch a delegate's result — there is no non-blocking status tool, so you cannot poll. Default timeout is 10s (max 300s). If the delegate finishes within the timeout, its result is returned here (same format as a sync delegate). If it times out, the run keeps going in the background and you should STOP waiting — do not retry in a loop; go do other work, and a completion notification will still be injected into the chat when it finishes.",
    promptSnippet: 'acp_delegate_wait({ runId: "del_..." })',
    promptGuidelines: [
      "Use this to fetch a delegate's result instead of polling a status tool.",
      "If it times out, do NOT retry — go do other work and let the background notification reach you.",
    ],
    parameters: WaitParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const args = params as { runId: string; timeout?: number };
      const run = runs.get(args.runId);
      if (!run) {
        return { details: undefined, content: [{ type: "text" as const, text: `No delegate run with runId \`${args.runId}\`. It may have already been reported or never existed.` }] };
      }
      // Already finished (e.g. the model calls wait after the injected
      // notification, or the run was cancelled).
      const displayMode = delegateDisplayUsage;
      if (run.status === "cancelled") {
        run.consumed = true;
        return buildWaitResult(run, `Delegate \`${args.runId}\` was cancelled (no result).${remainingLineForWait(args.runId)}`, displayMode);
      }
      if (run.status !== "running") {
        // The delegate already finished. If the close handler already injected
        // its result as a system notification (it fired before this wait was
        // called), don't re-deliver the full payload — point at the file
        // instead, so the model never sees the same result twice.
        const dedup = injectedWaitMessage(run, args.runId, remainingLineForWait(args.runId));
        if (dedup) {
          run.consumed = true;
          return buildWaitResult(run, dedup, displayMode);
        }
        // status is only flipped together with result (see close handler), so
        // a non-running, non-cancelled run always has a result. Guard anyway.
        run.consumed = true;
        if (!run.result) {
          return buildWaitResult(run, `Delegate \`${args.runId}\` finished but no result is available (persist error).`, displayMode);
        }
        return buildWaitResult(run, formatRunResult(run), displayMode);
      }
      const timeoutMs = Math.min(
        Math.max(args.timeout ?? WAIT_TIMEOUT_MS_DEFAULT, 1_000),
        WAIT_TIMEOUT_MS_MAX,
      );
      // Refuse to park a second waiter on the same run: a second wait would
      // overwrite run.waiter and orphan the first wait's listener/timer.
      if (run.waiter) {
        return { details: undefined, content: [{ type: "text", text: `Delegate \`${args.runId}\` already has a wait in progress; do not wait on it twice.` }] };
      }
      // Park a waiter; the close handler resolves it (and the result is owned
      // by this tool, so no injection duplicates it).
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: { details: undefined; content: { type: "text"; text: string }[]; usage?: AgentToolResult<unknown>["usage"] }) => {
          if (settled) return;
          settled = true;
          run.waiter = undefined;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => {
          finish({ details: undefined, content: [{ type: "text", text: `Aborted; delegate \`${args.runId}\` is still running in the background. A notification will be injected when it finishes.` }] });
        };
        run.waiter = () => {
          run.consumed = true; // we own the result; suppress injection
          if (run.status === "cancelled") {
            // Same message as the cancel-then-wait early-return path, for consistency.
            // Don't go through formatRunResult — cancelled runs have no result, and
            // formatPayload would render a misleading "could not be persisted" line.
            // Partial usage (if any) is accumulated per displayMode like the
            // early-return path.
            finish(buildWaitResult(run, `Delegate \`${run.runId}\` was cancelled (no result).${remainingLineForWait(run.runId)}`, displayMode));
            return;
          }
          finish(buildWaitResult(run, formatRunResult(run), displayMode));
        };
        signal?.addEventListener("abort", onAbort);
        timer = setTimeout(
          () => finish({ details: undefined, content: [{ type: "text", text: `Failed: delegate \`${args.runId}\` result not ready after ${Math.round(timeoutMs / 1000)}s. Do NOT keep waiting or retry — go do other work now. The run continues in the background and a completion notification (with the result file path) will be injected into the chat when it finishes.` }] }),
          timeoutMs,
        );
      });
    },
  };
}

export function makeDelegateCancelTool(_pi: ExtensionAPI): ToolDefinition<typeof CancelParams> {
  return {
    name: "acp_delegate_cancel",
    label: "ACP Delegate Cancel",
    description:
      "Cancel a background delegate (acp_delegate async run) by runId. Sends SIGTERM to the sub-agent process.",
    promptSnippet: 'acp_delegate_cancel({ runId: "del_..." })',
    promptGuidelines: [],
    parameters: CancelParams,
    async execute(toolCallId, params): Promise<AgentToolResult<unknown>> {
      const { runId } = params as Static<typeof CancelParams>;
      const run = runs.get(runId);
      if (!run) {
        return { details: undefined, content: [{ type: "text", text: `Unknown runId "${runId}".` }] };
      }
      if (run.status !== "running") {
        return buildCancelResult(run, `Run ${runId} already ${run.status} (no action).`);
      }
      run.status = "cancelled";
      run.consumed = true; // suppress injection; the waiter (if any) gets cancelled status
      try {
        run.child?.kill("SIGTERM");
      } catch (err) {
        debug.event("delegate-cancel-kill-error", { runId, error: String(err) });
        logError("delegate", { event: "cancel-kill-error", runId, error: String(err) });
      }
      delegateStatusWidget.poke();
      const displayMode = delegateDisplayUsage;
      return buildCancelResult(run, `Cancelled ${runId} (${run.agent}).`, displayMode);
    },
  };
}

async function runDelegate(
  pi: ExtensionAPI,
  args: DelegateArgs,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const agent = AGENTS[args.agent];
  if (!agent) {
    return `Unknown agent "${args.agent}". Choose one of: ${AGENT_NAMES.join(", ")}.`;
  }
  const parentDepth = Number(process.env.PI_ACP_DELEGATE_DEPTH ?? "0");
  if (Number.isNaN(parentDepth) || parentDepth >= MAX_DEPTH) {
    return `Delegate nesting limit reached (depth ${parentDepth}, max ${MAX_DEPTH}). The delegate cannot spawn further delegates.`;
  }
  if (!args.task || !args.task.trim()) {
    return `Task must be a non-empty string. Got: ${JSON.stringify(args.task).slice(0, 60)}`;
  }

  const cwd = args.cwd && args.cwd.trim() ? args.cwd : ctx.cwd;
  const childEnv = {
    ...process.env,
    PI_ACP_DELEGATE_DEPTH: String(parentDepth + 1),
  };
  const { cliArgs, tmpDir, isAsync, useJsonStream } = await buildChildArgs(args, agent.prompt, ctx);
  // One-shot modes (print/json = `pi -p` / SDK) exit after one turn, so async
  // injection (a follow-up turn) is never observed. Downgrade to sync there:
  // the result returns as the tool result within the same turn. Long-lived
  // modes (tui/rpc) keep true async + injection (consumed by the main loop).
  const requestedAsync = args.async !== false;
  if (requestedAsync && !isAsync) {
    debug.event("delegate-async-downgraded", { reason: `mode=${ctx.mode}` });
    logInfo("delegate", { event: "async-downgraded", reason: `mode=${ctx.mode}` });
  }
  const runId = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  debug.event("delegate-spawn", { agent: args.agent, runId, cwd, async: isAsync, useJsonStream, cliArgs });
  logInfo("delegate", { event: "spawn", agent: args.agent, runId, cwd, async: isAsync, useJsonStream, mode: ctx.mode, parentDepth });

  const child = spawn(
    process.execPath,
    [resolvePiCliEntry(process.argv[1] ?? "", process.env, isPiHost(ctx.sessionManager)), ...cliArgs],
    delegateSpawnOptions(cwd, childEnv),
  ) as ChildProcess;
  child.stdin?.once("error", (e: Error) => {
    debug.event("delegate-stdin-error", { runId: "pre-spawn", error: String(e) });
    logError("delegate", { event: "stdin-error", runId, error: String(e) });
  });
  child.stdin?.end(args.task);

  let stderrText = "";

  const startedAt = Date.now();

  if (isAsync) {
    let settled = false;
    // Watchdogs: idle (no output), EOF grace, hard limit. A stuck child holds
    // its stdout fd open so stdout EOF never fires — idle is the main defense.
    const watchdog = attachWatchdogs(
      child,
      {
        isSettled: () => settled || run.status !== "running",
        onKill: (reason) => {
          if (!run.agentSettled) run.timedOut = reason;
          debug.event("delegate-watchdog", { runId, reason });
        },
        onEofGrace: () => {
          if (!run.agentSettled) run.timedOut = "output ended but process did not exit";
          debug.event("delegate-eof-grace", { runId, ms: EOF_GRACE_MS });
        },
      },
      { eofGraceMs: EOF_GRACE_MS, idleMs: IDLE_GRACE_MS, timeoutMs: ASYNC_TIMEOUT_MS, killGraceMs: KILL_GRACE_MS },
    );
    // Two stream files are fed from the --mode json event stream: text_delta
    // tokens go to the reply stream (.out), tool activity (and optionally
    // thinking) goes to the activity stream (.activity). The agent is told
    // only about the activity file; the .out path arrives with the result.
    // omp has no json mode, so async delegates run plain `-p` — stdout IS the
    // reply and there is no tool activity to stream, so no .activity file.
    const replyFile = join(OUT_DIR, `${runId}.out`);
    const activityFile = join(OUT_DIR, `${runId}.activity`);
    await mkdir(OUT_DIR, { recursive: true });
    const replyStream = createWriteStream(replyFile, { flags: "a" });
    const activityStream = useJsonStream ? createWriteStream(activityFile, { flags: "a" }) : null;
    const endStream = (s: WriteStream | null): Promise<void> =>
      new Promise((resolve) => {
        if (!s || s.destroyed || s.closed) return resolve();
        s.end(() => resolve());
      });
    let stdoutBuf = "";
    const applier = makeEventApplier(
      {
        showThinking: args.showThinking === true,
        onUsage: (u) => {
          run.usage = accumulateUsage(run.usage, u);
        },
        onSettled: () => {
          run.agentSettled = true;
          watchdog.settledGrace(SETTLED_GRACE_MS, KILL_GRACE_MS, "agent settled but process did not exit");
        },
      },
      { reply: replyStream, activity: activityStream },
    );
    child.stdout?.on("data", (c: Buffer) => {
      watchdog.poke();
      if (useJsonStream) {
        stdoutBuf += c.toString("utf8");
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          applier.handleEventLine(line);
        }
      } else {
        // omp fallback: `-p` prints the plain reply, so stdout IS the reply —
        // stream it straight through (no line buffering, so a trailing chunk
        // without a newline is kept too).
        const text = c.toString("utf8");
        applier.appendRaw(text);
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });
    const run: DelegateRun = {
      runId,
      agent: args.agent,
      task: args.task,
      cwd,
      startedAt,
      status: "running",
      child,
    };
    runs.set(runId, run);
    delegateStatusWidget.poke();

    const finalize = (code: number | null): void => {
      void (async () => {
        if (settled) return;
        settled = true;
        watchdog.dispose();
        void cleanupTmp(tmpDir);
        await Promise.all([endStream(replyStream), endStream(activityStream)]);
        run.exitCode = code;
        const output = applier.getReplyText().trim();
        const body = code === 0 ? (output || "(no output)") : (stderrText.trim() || output || "(no output)");
        // N2: cancelled runs never persist a result — wake a parked waiter (if any)
        // and stop. status stays "cancelled" (set by cancel), so wait cannot
        // mistake it for a finished-with-result run.
        if (run.status === "cancelled") {
          await Promise.all([rm(replyFile, { force: true }), rm(activityFile, { force: true })]);
          run.finishedAt = Date.now();
          debug.event("delegate-done", { runId, code, status: run.status, injected: false, outLen: output.length });
          run.waiter?.();
          delegateStatusWidget.poke();
          return;
        }
        try {
          // The reply stream is the result file; backfill stderr or a placeholder
          // when the reply text is empty so the delivered file is never blank.
          const file = replyFile;
          if (output === "") {
            const fallback = stderrText.trim();
            await appendFile(file, fallback ? `${fallback}\n` : "(no output)\n");
          }
          // EOF-watchdog finalize has no exit code; if the output was delivered,
          // treat it as a completed result (the process is killed afterwards).
          const effectiveCode = code ?? (output || stderrText ? 0 : null);
          // Atomically flip status + result together: until this point the run
          // is still "running" to any observer, so a concurrent wait cannot
          // see "finished but result missing".
          run.result = { code, file, body };
          run.status = effectiveCode === 0 ? "completed" : "failed";
          run.finishedAt = Date.now();
          // If a wait is parked on this run, wake it — it owns the result now
          // (and marks consumed so we don't double-deliver by injecting).
          if (run.waiter) {
            debug.event("delegate-done", { runId, code, status: run.status, injected: false, via: "wait", outLen: output.length, file });
            logInfo("delegate", { event: "done", runId, agent: args.agent, code, status: run.status, injected: false, via: "wait", outLen: output.length, file });
            run.waiter();
            delegateStatusWidget.poke();
            return;
          }
          if (run.consumed) {
            debug.event("delegate-done", { runId, code, status: run.status, injected: false, via: "consumed", outLen: output.length, file });
            logInfo("delegate", { event: "done", runId, agent: args.agent, code, status: run.status, injected: false, via: "consumed", outLen: output.length, file });
            delegateStatusWidget.poke();
            return;
          }
          const mode = delegateDisplayUsage;
          const injected = injectResult(pi, args.agent, runId, args.task, code, file, run.timedOut, run.usage, mode, run.usageReported);
          if (run.usage && !run.usageReported && (mode === "separate" || injected)) {
            run.usageReported = true;
          }
          run.injected = injected;
          debug.event("delegate-done", { runId, code, status: run.status, injected, outLen: output.length, file });
          logInfo("delegate", { event: "done", runId, agent: args.agent, code, status: run.status, injected, outLen: output.length, file });
          delegateStatusWidget.poke();
        } catch (err) {
          run.status = "failed";
          run.finishedAt = Date.now();
          debug.event("delegate-done-error", { runId, error: String(err) });
          logError("delegate", { event: "done-error", runId, agent: args.agent, error: String(err) });
          run.waiter?.();
          delegateStatusWidget.poke();
        }
      })();
    };

    child.on("close", (code) => finalize(code));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      watchdog.dispose();
      void cleanupTmp(tmpDir);
      void replyStream.destroy();
      void activityStream?.destroy();
      void rm(replyFile, { force: true });
      void rm(activityFile, { force: true });
      // Spawn-level error (e.g. EPIPE on a fast-exiting child, ENOENT).
      // Node does not guarantee a follow-up close, so finalize here too:
      // atomically set status + a synthetic result, and wake a parked waiter.
      // The settled guard in close (if it does fire) prevents double-finalize.
      if (run.status === "running" || run.status === "cancelled") {
        run.status = run.status === "cancelled" ? "cancelled" : "failed";
        run.finishedAt = Date.now();
        run.result = { code: null, file: "", body: `spawn error: ${String(err)}` };
        debug.event("delegate-spawn-error", { runId, error: String(err) });
        logError("delegate", { event: "spawn-error", runId, agent: args.agent, error: String(err) });
        run.waiter?.();
        delegateStatusWidget.poke();
      }
    });
    // Detach so the child survives the tool returning. Injection is best-effort:
    // the close handler calls sendUserMessage (fire-and-forget) to notify the
    // parent chat; interactive/rpc sessions consume it via their main loop.
    child.unref();
    return [
      `Delegated to **${args.agent}** (runId \`${runId}\`).`,
      `Task: ${truncate(args.task, 160)}`,
      `Running in the background at \`${cwd}\`.`,
      useJsonStream
        ? `Live activity is streaming to \`${activityFile}\` — read it anytime to watch the delegate work (tool calls and their output${args.showThinking ? ", plus thinking" : ""}).`
        : `The reply is streaming to \`${replyFile}\` — read it anytime to see partial output (this host has no json event mode, so tool activity is not visible).`,
      `A watchdog force-finishes a hung run: no output for ${IDLE_GRACE_MS / 60_000}m, 10s after output ends, or a ${ASYNC_TIMEOUT_MS / 60_000}m hard limit — the result reflects whatever was produced.`,
      ``,
      `Call acp_delegate_wait({ runId: "${runId}" }) to block for the result (default 10s timeout). If the wait times out, or you skip it, a completion notification (with the result file path) is still injected here automatically when the delegate finishes — so you may also just continue other work now and let the result find you.`,
    ].join("\n");
  }

  // Sync: block until the child finishes (bounded by a timeout).
  const result = await waitForChild(child, signal);
  void cleanupTmp(tmpDir);
  const body =
    result.timedOut || result.code !== 0
      ? (result.stderr.trim() || "(no stderr)")
      : (result.stdout || "(no output)");
  const file = await persistResult(runId, body);
  return formatSyncResult(args.agent, runId, args.task, result, file);
}

export async function buildChildArgs(
  args: DelegateArgs,
  rolePrompt: string,
  ctx: ExtensionContext,
): Promise<{ cliArgs: string[]; tmpDir: string; isAsync: boolean; useJsonStream: boolean }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "acp-delegate-"));
  // Combine the role prompt with a small framing instruction so the child
  // treats the positional message as the task to execute.
  const promptFile = join(tmpDir, "role.md");
  await writeFile(promptFile, `${rolePrompt}\n\n---\n\nComplete the task below.`, "utf8");

  // Async delegates run in JSON Event Stream Mode so the host can parse tool
  // activity (activity file) and reply tokens (.out) from the event stream.
  // `--mode json` is pi-only: omp (oh-my-pi) has no json mode, so async
  // delegates there fall back to `-p` (plain reply on stdout, no activity
  // file). Sync delegates always keep print mode: they return a single text
  // result, no streaming, and the async auto-downgrade (print/json host) must
  // stay safe.
  const isAsync = args.async !== false && ctx.mode !== "print" && ctx.mode !== "json";
  const useJsonStream = isAsync && isPiHost(ctx.sessionManager);
  const cliArgs = useJsonStream
    ? ["--mode", "json", "--no-session", "--append-system-prompt", promptFile]
    : ["-p", "--no-session", "--append-system-prompt", promptFile];

  // Restricted roles receive a tailored --tools allowlist. Worker and
  // unknown agents are left on Pi's full default toolset (all extension/
  // custom tools stay active). The allowlist is a *soft guardrail*: it
  // prevents accidental edit/write by read-only roles, but bash can bypass
  // it - this is not a security boundary.
  const agentDef = AGENTS[args.agent];
  if (agentDef?.restricted) {
    const merged = [...new Set([...agentDef.tools.split(",").map(s => s.trim()), ...ACP_TOOLS])];
    cliArgs.push("--tools", merged.join(","));
  }

  if (args.model && args.model.includes("/")) {
    const [providerId, ...rest] = args.model.split("/");
    const modelId = rest.join("/");
    cliArgs.push("--provider", providerId!, "--model", modelId);
  } else if (ctx.model) {
    // Inherit the parent's current model so the delegate runs on the same one.
    cliArgs.push("--provider", ctx.model.provider, "--model", ctx.model.id);
  }

  return { cliArgs, tmpDir, isAsync, useJsonStream };
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function waitForChild(child: ChildProcess, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stderrText = "";
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: "", stderr: stderrText, timedOut: true });
    }, SYNC_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(r: ChildResult) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    }

    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: stderrText,
        timedOut: false,
      });
    });
    child.on("error", (err) => {
      finish({ code: null, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

function formatSyncResult(agent: string, runId: string, task: string, r: ChildResult, file: string): string {
  const status = r.timedOut ? "timed out" : r.code === 0 ? "completed" : "failed";
  const header = `Delegate **${agent}** ${status} (runId \`${runId}\`, exit ${r.code ?? "?"}).`;
  if (r.code === 0 && !r.timedOut) {
    return formatPayload(header, file, task);
  }
  const body = r.timedOut ? "(timed out)" : (r.stderr.trim() || "(no stderr)");
  return formatPayload(header, file, task, body);
}

export function injectResult(
  pi: ExtensionAPI,
  agent: string,
  runId: string,
  task: string,
  code: number | null,
  file: string,
  timedOut?: string,
  usage?: Usage,
  mode: "merged" | "separate" = "separate",
  usageAlreadyReported?: boolean,
): boolean {
  const send = pi.sendUserMessage;
  if (typeof send !== "function") {
    debug.event("delegate-inject-skipped", { runId, reason: "sendUserMessage unavailable" });
    logWarn("delegate", { event: "inject-skipped", runId, reason: "sendUserMessage unavailable" });
    return false;
  }
  const status = code === 0 ? "completed" : "failed";
  // Tell the model how many other delegates are still running, so it doesn't
  // lose count when many were dispatched in a batch (e.g. launched 5, this is
  // the 2nd to return → "3 still running" → the model knows to keep waiting).
  // The current run is already non-running (status flipped just before this),
  // so counting status==="running" gives exactly the remaining ones.
  const remaining = Array.from(runs.values()).filter((r) => r.status === "running").length;
  const remainingLine =
    remaining > 0
      ? ` ${remaining} delegate${remaining === 1 ? " is" : "s are"} still running; keep doing other work and their notifications will arrive as they finish.`
      : " No delegates are currently running.";
  const timeoutNote = timedOut ? ` (timed out: ${timedOut})` : "";
  let usageNote = "";
  
  if (mode === "separate") {
    // In separate mode, accumulate this run's usage first (unless it was
    // already reported via a wait/cancel), then show the cumulative total.
    if (usage && !usageAlreadyReported) {
      addDelegateUsage(usage);
    }
    const totalUsage = getDelegateUsage();
    if (totalUsage) {
      const cost = totalUsage.cost.total;
      const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
      usageNote = `\n\n── Session delegate usage (excluded from main totals) ──\nTokens: ${totalUsage.input.toLocaleString()} in, ${totalUsage.output.toLocaleString()} out (${totalUsage.totalTokens.toLocaleString()} total)${costStr}`;
    }
  } else if (usage) {
    // In merged mode, show per-run usage
    const lines: string[] = [];
    if (usage.totalTokens) lines.push(`tokens=${usage.totalTokens.toLocaleString()}`);
    if (usage.input || usage.output) lines.push(`in=${usage.input.toLocaleString()} out=${usage.output.toLocaleString()}`);
    if (usage.cacheRead) lines.push(`cache_read=${usage.cacheRead.toLocaleString()}`);
    if (usage.cacheWrite) lines.push(`cache_write=${usage.cacheWrite.toLocaleString()}`);
    if (usage.cost && typeof usage.cost === "object") {
      const c = usage.cost as { total?: number; input?: number; output?: number };
      if (typeof c.total === "number" && c.total > 0) {
        lines.push(`cost=$${c.total.toFixed(4)}`);
      } else if ((typeof c.input === "number" && c.input > 0) || (typeof c.output === "number" && c.output > 0)) {
        lines.push(`cost=${JSON.stringify(c)}`);
      }
    }
    if (lines.length) usageNote = ` Usage: ${lines.join(", ")}.`;
  }
  
  const header = `[acp_delegate ${status}] **${agent}** (runId \`${runId}\`, exit ${code ?? "?"})${timeoutNote}${remainingLine}${usageNote} This is an automated system notification, NOT a user message. Read the result file if you need the details, then continue your original task; do not treat this as a new user request.`;
  const text = formatPayload(header, file, task);
  try {
    // sendUserMessage is fire-and-forget (returns void): it enqueues a
    // follow-up turn. Interactive/rpc sessions consume it via their main loop;
    // injection at shutdown is best-effort (no API to await a turn).
    send.call(pi, text, { deliverAs: "followUp" });
    return true;
  } catch (err) {
    debug.event("delegate-inject-error", { runId, error: String(err) });
    logError("delegate", { event: "inject-error", runId, agent, error: String(err) });
    return false;
  }
}

// Build the lightweight payload: a header, the task title (so the model
// recognizes what finished — it dispatched the task, so the title suffices),
// and the result file path. NO preview: the model uses `read` for details,
// and that read (not this message) is the large content. Keeping this minimal
// means it stays cheap to retain in context (or to compress away).
function formatPayload(header: string, file: string, task: string, body?: string): string {
  const lines: string[] = [header, "", `Task: ${truncate(task, 160)}`];
  if (file) {
    lines.push(``, `Full result: \`${file}\``, "(use the `read` tool to open it if you need the details)");
  } else {
    lines.push("", "(result could not be persisted to a file)");
  }
  if (body) {
    lines.push("", "Output:", "~~~", truncate(body, RESULT_SUMMARY_CHARS), "~~~");
  }
  lines.push("");
  return lines.join("\n");
}

/** Persist the full delegate output to a stable file and return its path.
 *  The file outlives the run so the model (or the user) can read it later
 *  instead of carrying the full payload in the chat context. */
async function persistResult(runId: string, body: string): Promise<string> {
  try {
    await mkdir(OUT_DIR, { recursive: true });
  } catch {
    // directory may already exist — ignore
  }
  const file = join(OUT_DIR, `${runId}.out`);
  try {
    await writeFile(file, body, "utf8");
    return file;
  } catch (err) {
    debug.event("delegate-persist-error", { runId, file, error: String(err) });
    logError("delegate", { event: "persist-error", runId, file, error: String(err) });
    return "";
  }
}

async function cleanupTmp(tmpDir: string | null): Promise<void> {
  if (!tmpDir) return;
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
