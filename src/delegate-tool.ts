import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm, appendFile, readFile, copyFile } from "node:fs/promises";
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
import { DEFAULT_DELEGATE_POLICY, type DelegatePolicy, type DelegateRoleConfig } from "./config.js";
import { attachWatchdogs } from "./delegate-watchdog.js";
import { parseEventLine, activityLines, newPortion, ThinkingCollector, type Usage } from "./delegate-events.js";
import { isPiHost } from "./runtime.js";

const EOF_GRACE_MS = 10_000;
const SETTLED_GRACE_MS = 10_000;
const KILL_GRACE_MS = 10_000;
const RESULT_SUMMARY_CHARS = 500;
export const OUT_DIR = join(tmpdir(), "acp-delegate");
// Coalesce completion notifications: each sendUserMessage follow-up costs a
// full model turn, so N near-simultaneous finishes merge into ONE message
// (issue #157). The trailing window (NOTIFY_COALESCE_MS) never extends more
// than NOTIFY_COALESCE_MAX_MS past the first queued completion.
const NOTIFY_COALESCE_MS = 2_000;
const NOTIFY_COALESCE_MAX_MS = 10_000;
const SESSION_EXT = ".session.jsonl";
const ACTIVITY_TAIL_CHARS = 400;

/** Stdin for a resumed run: the original task and all earlier tool calls are
 *  already in the restored session history, so the child must continue, not
 *  restart. */
const RESUME_INSTRUCTION = `This run RESUMES a previously interrupted delegate run (it failed, timed out, or was cancelled before finishing). Your earlier work is in this session's history: the original task, the tool calls you already made, and any partial findings. Continue exactly where you left off — do NOT repeat steps that are already done, verify any partial work, and complete the task.`;

export function delegateStdinText(resumeFrom: boolean, task: string | undefined): string {
  if (!resumeFrom) return task ?? "";
  const extra = task && task.trim() ? `\n\nAdditional guidance for this attempt:\n${task}` : "";
  return RESUME_INSTRUCTION + extra;
}

export function delegateSpawnOptions(cwd: string, env: NodeJS.ProcessEnv): SpawnOptions {
  return {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  };
}

/** Child process env for a nested delegate: depth increments by one, and the
 *  resolved maxDepth rides along so the cap binds the whole delegation tree
 *  even when the child loads a different project acp.json. */
export function delegateChildEnv(parentDepth: number, maxDepth: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_ACP_DELEGATE_DEPTH: String(parentDepth + 1),
    PI_ACP_DELEGATE_MAX_DEPTH: String(maxDepth),
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

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface DelegateRun {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  exitCode?: number | null;
  /** Exit signal when the child died by signal (exit code null), e.g. "SIGTERM". */
  exitSignal?: NodeJS.Signals;
  child?: ChildProcess;
  result?: { code: number | null; file: string; body: string };
  /** Live activity log path (async json-stream runs only). */
  activityFile?: string;
  /** runId of the run this run resumed from (resumeFrom). */
  resumedFrom?: string;
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
  /** True while the run sits in the coalescing notification queue (scheduled
   *  for the next batched flush, not yet delivered). */
  notifyQueued?: boolean;
  /** When the model successfully read this run's result file (read tool, or a
   *  bash command referencing it). A read at/after finishedAt means the model
   *  already saw the final result — the completion notification is then
   *  suppressed (notifyIfRead: "skip"). */
  readAt?: number;
  /** True when the completion notification was suppressed because the model
   *  had already read the result file. Treated as delivered (injected=true)
   *  so wait/recovery never re-surface the result. */
  readSuppressed?: boolean;
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

let delegatePolicy: DelegatePolicy = DEFAULT_DELEGATE_POLICY;

export function setDelegatePolicy(policy: DelegatePolicy): void {
  delegatePolicy = policy;
}

// ─── Delegate concurrency gate (#294) ───────────────────────────────────────
// At most `capacity` background children run at once (Infinity = unlimited);
// extra launches wait in a FIFO queue. Cancelling a QUEUED launch marks it
// (skipped on drain), never deletes it, so a cancelled entry can't take a slot.
export class ConcurrencyGate {
  private active = 0;
  private queue: { runId: string; launch: () => void; cancelled?: boolean }[] = [];
  private readonly capacityOf: () => number;
  constructor(capacityOf: () => number) {
    this.capacityOf = capacityOf;
  }
  private get capacity(): number {
    return this.capacityOf();
  }
  get unlimited(): boolean {
    return !Number.isFinite(this.capacity);
  }
  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    let n = 0;
    for (const q of this.queue) if (!q.cancelled) n++;
    return n;
  }
  /** Start `launch` immediately when a slot is free and nothing waits ahead;
   *  otherwise hold it in the FIFO queue. True when it started right away. */
  launchOrQueue(runId: string, launch: () => void): boolean {
    if (this.unlimited) {
      launch();
      return true;
    }
    if (this.active < this.capacity && this.queuedCount === 0) {
      this.active++;
      launch();
      return true;
    }
    this.queue.push({ runId, launch });
    return false;
  }
  cancelQueued(runId: string): boolean {
    const e = this.queue.find((q) => q.runId === runId && !q.cancelled);
    if (!e) return false;
    e.cancelled = true;
    return true;
  }
  /** A live child hit a terminal state: free its slot, then start waiting
   *  launches FIFO (skipping any cancelled while queued). */
  release(): void {
    if (this.unlimited) return;
    this.active = Math.max(0, this.active - 1);
    while (this.active < this.capacity) {
      const next = this.queue.shift();
      if (!next) break;
      if (next.cancelled) continue;
      this.active++;
      next.launch();
    }
  }
}

const delegateGate = new ConcurrencyGate(() => delegatePolicy.maxConcurrent);
// Per-role / global model + thinking defaults, resolved once at session_start
// from adapter.delegate. buildChildArgs reads them at spawn time. Kept as module
// state (mirroring delegateDisplayUsage) so buildChildArgs stays testable without
// threading config through every call site.
let delegateDefaults: { thinkingLevel?: string; agents?: Record<string, DelegateRoleConfig> } = {};

export function setDelegateDefaults(d: { thinkingLevel?: string; agents?: Record<string, DelegateRoleConfig> } | undefined): void {
  delegateDefaults = d ?? {};
}

export function resetDelegateDefaults(): void {
  delegateDefaults = {};
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(v: unknown): v is (typeof VALID_THINKING_LEVELS)[number] {
  return typeof v === "string" && (VALID_THINKING_LEVELS as readonly string[]).includes(v);
}

function pickFirstDefined(values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function normalizeModelRef(m: string | undefined): string | undefined {
  if (!m) return undefined;
  const s = m.trim();
  return s.includes("/") ? s : undefined;
}

let delegateNotifyIfRead: "skip" | "always" = "skip";

export function setDelegateNotifyIfRead(mode: "skip" | "always"): void {
  delegateNotifyIfRead = mode;
}

/** Mark the run whose result file the model just read (via the `read` tool).
 *  Returns true when a run matched. A read of the final result file after the
 *  run finished means the model already saw the result — the completion
 *  notification is then suppressed (notifyIfRead: "skip"). */
export function markDelegateResultRead(filePath: string): boolean {
  if (!filePath) return false;
  const abs = resolvePath(filePath);
  let matched = false;
  for (const run of runs.values()) {
    if (join(OUT_DIR, `${run.runId}.out`) === abs) {
      run.readAt = Date.now();
      suppressIfReadNow(run);
      matched = true;
    }
  }
  return matched;
}

/** Mark runs referenced by a bash command (e.g. `cat <result file>`).
 *  Matches runIds appearing anywhere in the command string; only existing
 *  runs are affected, so task text that merely contains "del_..." is inert. */
export function markDelegateRunReadByCommand(command: string): boolean {
  if (!command) return false;
  const ids = command.match(/del_[a-z0-9]+_[a-z0-9]+/g);
  if (!ids) return false;
  let matched = false;
  const now = Date.now();
  for (const id of new Set(ids)) {
    const run = runs.get(id);
    if (run) {
      run.readAt = now;
      suppressIfReadNow(run);
      matched = true;
    }
  }
  return matched;
}


/** Snapshot of currently-running delegate runs, for the TUI status widget. */
export function runningRunsSnapshot(): { runId: string; agent: string; task: string; startedAt: number }[] {
  const out: { runId: string; agent: string; task: string; startedAt: number }[] = [];
  for (const r of runs.values()) {
    if (r.status === "running") out.push({ runId: r.runId, agent: r.agent, task: r.task, startedAt: r.startedAt });
  }
  return out;
}

// ─── Fleet inspector (#292) ─────────────────────────────────────────────────

export interface FleetRunView {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  exitLabel: string;
  timedOut?: string;
  resumedFrom?: string;
  /** Streamed reply text (always retained, even for cancelled runs). */
  replyFile: string;
  /** Live tool-activity log (async json-stream runs only). */
  activityFile?: string;
  sessionFile?: string;
  usage?: Usage;
}

const MAX_FLEET_FINISHED = 12;

/** Running first (oldest spawn on top), then recently finished (newest first,
 *  capped) — the order the fleet inspector list shows. */
export function orderRunsForFleet(all: DelegateRun[]): DelegateRun[] {
  const running = all
    .filter((r) => r.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  const finished = all
    .filter((r) => r.status !== "running")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, MAX_FLEET_FINISHED);
  return [...running, ...finished];
}

function toFleetRunView(r: DelegateRun): FleetRunView {
  return {
    runId: r.runId,
    agent: r.agent,
    task: r.task,
    cwd: r.cwd,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status,
    exitLabel: exitLabel(r.exitCode ?? null, r.exitSignal),
    timedOut: r.timedOut,
    resumedFrom: r.resumedFrom,
    replyFile: r.result?.file ?? join(OUT_DIR, `${r.runId}.out`),
    activityFile: r.activityFile,
    sessionFile: join(OUT_DIR, `${r.runId}${SESSION_EXT}`),
    usage: r.usage,
  };
}

/** Display-safe snapshot of every delegate run known this session, for the
 *  fleet inspector (/acp-fleet). In-memory only: runs from previous pi
 *  processes are not listed (their files remain under OUT_DIR). */
export function fleetRunsSnapshot(): FleetRunView[] {
  return orderRunsForFleet(Array.from(runs.values())).map(toFleetRunView);
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

/** Resolve a wait timeout to ms. Agents frequently pass seconds (e.g. 180)
 *  instead of milliseconds; values below the 1s floor make no sense as a wait
 *  duration, so rescale them to seconds before clamping — otherwise 180 clamps
 *  to 1000ms and the wait times out in 1s. */
export function resolveWaitTimeoutMs(raw: number | undefined): number {
  if (raw === undefined) return WAIT_TIMEOUT_MS_DEFAULT;
  const ms = raw < 1_000 ? raw * 1_000 : raw;
  return Math.min(Math.max(ms, 1_000), WAIT_TIMEOUT_MS_MAX);
}

const DelegateParams = Type.Object({
  agent: Type.String({
    description: `Role of the delegate. One of: ${AGENT_NAMES.join(", ")}. See tool description for what each does.`,
  }),
  task: Type.Optional(
    Type.String({
      description: "The self-contained task to hand off. State purpose, scope, and any constraints explicitly. Required for fresh runs; optional when resuming via resumeFrom (if given, it is appended as extra guidance for this attempt).",
    }),
  ),
  resumeFrom: Type.Optional(
    Type.String({
      description: 'Resume a previously failed/cancelled run: the new delegate restores that run\'s session (original task, tool calls already made, partial findings) and continues from where it left off instead of starting over. Pass the earlier runId. When resuming, `task` is optional — if given, it is appended as extra guidance for this attempt. (pi host only.)',
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the delegate (default: current project dir)." }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Model override as "provider/id". Default: this role\'s configured model (delegate.agents.<role>.model), else inherit the current model.' }),
  ),
  thinkingLevel: Type.Optional(
    Type.String({ description: `Per-call thinking-level override: ${VALID_THINKING_LEVELS.join("|")}. Default: this role's configured level, else the global delegate.thinkingLevel, else Pi's own default.` }),
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
      description: `Maximum time to block waiting for the result, in milliseconds. Default ${WAIT_TIMEOUT_MS_DEFAULT} (10s); max ${WAIT_TIMEOUT_MS_MAX} (300s). Values below 1000 are treated as seconds (so 180 means 180s, not 180ms). If the delegate does not finish in time, returns "failed (not ready)" — do NOT keep waiting or retry; go do other work, and a completion notification will still be injected when it completes.`,
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
  const maxConcurrent = delegatePolicy.maxConcurrent;
  const concurrencyNote = Number.isFinite(maxConcurrent)
    ? `\n• Concurrency limit: at most ${maxConcurrent} background delegate(s) run at once; extra launches stay QUEUED and start automatically as slots free. Set delegate.maxConcurrent in acp.json (or PI_ACP_DELEGATE_MAX_CONCURRENT) to change it.`
    : "";
  return {
    name: "acp_delegate",
    label: "ACP Delegate",
    description: `Hand a self-contained task to a fresh sub-agent running in a clean context (its own pi process). Use to get focused review/investigation/implementation without polluting the main context, or to run several tasks concurrently.

Agents (pick by name):
${AGENT_NAMES.map(agentListLine).join("\n")}

Behavior:
• async=true (default): returns immediately with a runId. The delegate runs in the background. Call acp_delegate_wait({ runId }) to block for its result (up to a timeout); if you let the timeout lapse, or never call wait, a short completion notification (status + file path) is still injected into this chat when it finishes — unless you already read the result file after it finished, in which case the notification is skipped (you have the result). In one-shot sessions (print/json) async auto-downgrades to sync so the result is returned inline within the same turn. Call acp_delegate again to launch more runs in parallel.${concurrencyNote}
• async=false: blocks until the delegate finishes. The full output is saved to a file; the tool result contains the path. Use the \`read\` tool to open the file for the complete content.

There is NO non-blocking status tool. To get a delegate's result, call acp_delegate_wait with the runId — it blocks until the run finishes or the timeout elapses. Use acp_delegate_cancel only to stop a run you no longer want.

Failure & resume:
• Failed and cancelled runs KEEP their output files (partial reply + activity log) — read them to see what the delegate produced before dying.
• To continue a failed/cancelled run instead of re-dispatching it, call acp_delegate again with resumeFrom: "<runId>" (pi host only): the new run restores the earlier session (history + partial work) and picks up where it left off.

The delegate runs in its own clean pi process — it does NOT see this conversation's context. Give it everything it needs (paths, goals, constraints). Full results always go to a file so the chat context stays small.`,
    promptSnippet:
      'acp_delegate({ agent: "reviewer", task: "Review src/index.ts for race conditions" })',
    promptGuidelines: [
      "Delegate to get a focused result in a clean context, or to parallelize independent work.",
      "The sub-agent has NO access to this conversation — write a fully self-contained task.",
      "Prefer async=true and launch several; results arrive back automatically when each finishes.",
      "A FAILED notification (⚠️) means that task produced no usable result — read the excerpt and the output files, then decide whether to re-dispatch it before wrapping up.",
      "A failed/cancelled run keeps its output files and can be resumed with resumeFrom: \"<runId>\" — prefer resuming over re-dispatching when the earlier work is worth keeping.",
      "For changes you must apply yourself, delegate read-only investigation (reviewer/researcher/oracle) and keep the main context as the sole writer.",
    ],
    parameters: DelegateParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const args = params as DelegateArgs;
      let outcome = await runDelegate(pi, args, ctx, signal);
      const notice = undeliveredNotice();
      if (notice) outcome = `${notice}\n\n${outcome}`;
      return { details: undefined, content: [{ type: "text", text: outcome }] };
    },
  };
}

export function formatRunResult(run: DelegateRun): string {
  const timeoutNote = run.timedOut ? ` (timed out: ${run.timedOut})` : "";
  const exit = exitLabel(run.exitCode ?? null, run.exitSignal);
  const header =
    run.status === "completed"
      ? `Delegate **${run.agent}** (runId \`${run.runId}\`) completed (${exit})${timeoutNote}${remainingLineForWait(run.runId)}`
      : `Delegate **${run.agent}** (runId \`${run.runId}\`) ${run.status === "failed" ? "FAILED ⚠️" : run.status} (${exit})${timeoutNote}${remainingLineForWait(run.runId)}`;
  return formatPayload(header, run.result?.file ?? "", run.task, run.result?.body, run.status === "failed" ? run.activityFile : undefined);
}

/** "exit 0" / "exit 1" / "exit SIGTERM" (signal shown when the child was
 *  killed and has no exit code) / "exit ?" (unknown). */
export function exitLabel(code: number | null, signal?: NodeJS.Signals | null): string {
  if (code === null && signal) return `exit ${signal}`;
  return `exit ${code ?? "?"}`;
}

/** Shared note for cancelled runs: their files are retained, so point the
 *  model at the partial output and offer a resume. */
export function cancelledFileNote(runId: string, file: string): string {
  return `Partial output (if any) is retained at \`${file}\` — read it to see what the delegate produced before cancellation. To continue from where it left off, call acp_delegate again with resumeFrom: "${runId}".`;
}

/** Count of OTHER delegates still in flight (running or queued), excluding self. */
function remainingLineForWait(selfRunId: string): string {
  const remaining = Array.from(runs.values()).filter((r) => (r.status === "running" || r.status === "queued") && r.runId !== selfRunId).length;
  return remaining > 0 ? ` ${remaining} delegate${remaining === 1 ? " is" : "s are"} still running.` : "";
}

/** Runs that reached a terminal state but whose result never reached the
 *  model: no parked waiter, not consumed by a tool result, never injected
 *  as a notification, and not sitting in the coalescing queue (a scheduled
 *  batch is not a lost delivery). The model was promised a notification
 *  ("do NOT keep waiting"), so these must eventually be recovered, or a
 *  failed delegate stays invisible until the very end of the task. */
export function findUndeliveredRuns(all: DelegateRun[], excludeRunId?: string): DelegateRun[] {
  return all.filter(
    (r) =>
      r.runId !== excludeRunId &&
      (r.status === "completed" || r.status === "failed") &&
      !r.waiter &&
      !r.consumed &&
      !r.injected &&
      !r.notifyQueued,
  );
}

/** Compute the recovery notice for undelivered runs WITHOUT marking them
 *  delivered. The caller commits the marking (covered[].injected = true) only
 *  after the carrier message is actually sent: if the send throws, the runs
 *  must stay undelivered so a later carrier can recover them. */
export function buildRecoveryNotice(all: DelegateRun[], excludeRunId?: string): { text: string; covered: DelegateRun[] } {
  const pending = findUndeliveredRuns(all, excludeRunId);
  if (pending.length === 0) return { text: "", covered: [] };
  const anyFailed = pending.some((r) => r.status === "failed");
  const header = `⚠️ Recovery notice: ${pending.length} earlier delegate result${pending.length === 1 ? "" : "s"} never reached you (notification delivery failed).${anyFailed ? " At least one FAILED — that task's work is missing; read its result below and decide whether to re-dispatch before concluding." : ""}`;
  return { text: [header, ...pending.map((r) => formatRunResult(r))].join("\n"), covered: pending };
}

/** Build a recovery notice for undelivered runs and mark each covered run
 *  injected=true (this notice IS its delivery) so it is never re-notified and
 *  a later wait dedups instead of re-delivering the payload. For carriers the
 *  host owns (delegate tool results); injectResult commits the marking itself
 *  only after its send succeeds (see buildRecoveryNotice). */
export function undeliveredNoticeFrom(all: DelegateRun[], excludeRunId?: string): string {
  const { text, covered } = buildRecoveryNotice(all, excludeRunId);
  for (const r of covered) r.injected = true;
  return text;
}

function undeliveredNotice(excludeRunId?: string): string {
  return undeliveredNoticeFrom(Array.from(runs.values()), excludeRunId);
}

// ─── Coalesced completion notifications (#157) ─────────────────────────────
// Each injected notification is a follow-up turn for the model; delegates that
// finish close together must share ONE message instead of piling up in the
// queue. A trailing-edge debounce (reset by every new completion, capped at
// NOTIFY_COALESCE_MAX_MS from the first) batches simultaneous finishers while
// keeping worst-case delivery latency low.

let notifyPi: ExtensionAPI | undefined;
const notifyQueue: DelegateRun[] = [];
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
let notifyWindowStart = 0;

/** Queue a finished run's completion notification for coalesced delivery.
 *  The flush timer is re-armed (trailing edge) on every call so runs that
 *  finish together share one message; see NOTIFY_COALESCE_MS. */
export function scheduleRunNotification(pi: ExtensionAPI, run: DelegateRun): void {
  if (!notifyQueue.includes(run)) notifyQueue.push(run);
  run.notifyQueued = true;
  notifyPi = pi;
  const now = Date.now();
  if (!notifyWindowStart) notifyWindowStart = now;
  const delay = Math.max(0, Math.min(NOTIFY_COALESCE_MS, NOTIFY_COALESCE_MAX_MS - (now - notifyWindowStart)));
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    flushDelegateNotifications();
  }, delay);
  notifyTimer.unref?.();
}

/** Deliver every undelivered terminal run (queued + any earlier lost ones) as
 *  a single injected message. Runs that gained a waiter or were consumed
 *  while queued are skipped — their result is owned by the wait/cancel path.
 *  On send failure nothing is marked delivered, so a later carrier recovers
 *  the batch via the normal undelivered-notice mechanism. */
export function flushDelegateNotifications(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
  }
  notifyWindowStart = 0;
  const queued = new Set(notifyQueue.splice(0));
  for (const r of queued) r.notifyQueued = false;
  const pi = notifyPi;
  if (!pi) return;
  const owned = (r: DelegateRun): boolean =>
    !r.waiter && !r.consumed && !r.injected && (r.status === "completed" || r.status === "failed");
  const deliverable: DelegateRun[] = [];
  const seen = new Set<DelegateRun>();
  for (const r of queued) {
    if (owned(r) && !seen.has(r)) {
      seen.add(r);
      deliverable.push(r);
    }
  }
  for (const r of findUndeliveredRuns(Array.from(runs.values()))) {
    if (!seen.has(r)) {
      seen.add(r);
      deliverable.push(r);
    }
  }
  if (deliverable.length === 0) return;
  if (deliverable.length === 1) {
    const r = deliverable[0]!;
    const mode = delegateDisplayUsage;
    const injected = injectResult(
      pi,
      r.agent,
      r.runId,
      r.task,
      r.status,
      r.result?.code ?? null,
      r.result?.file ?? "",
      r.timedOut,
      r.usage,
      mode,
      r.usageReported,
      r.status === "failed" ? r.result?.body : undefined,
      r.status === "failed" ? r.activityFile : undefined,
      r.exitSignal,
    );
    if (r.usage && !r.usageReported && (mode === "separate" || injected)) r.usageReported = true;
    r.injected = injected;
    return;
  }
  const mode = delegateDisplayUsage;
  const failedCount = deliverable.filter((r) => r.status === "failed").length;
  const okCount = deliverable.length - failedCount;
  const lost = deliverable.filter((r) => !queued.has(r));
  const parts: string[] = [];
  if (lost.length > 0) {
    parts.push(`⚠️ Recovery notice: ${lost.length} earlier delegate result${lost.length === 1 ? "" : "s"} never reached you (notification delivery failed); included below.`);
  }
  parts.push(`[acp_delegate] ${deliverable.length} delegates finished (${okCount} completed${failedCount > 0 ? `, ${failedCount} FAILED` : ""}).`);
  for (const r of deliverable) parts.push(formatBatchRunSection(r));
  for (const r of deliverable) {
    if (mode === "separate" && r.usage && !r.usageReported) addDelegateUsage(r.usage);
  }
  parts.push(buildBatchTrailer(deliverable, failedCount > 0, mode));
  const text = parts.join("\n\n");
  const send = pi.sendUserMessage;
  let sent = false;
  if (typeof send === "function") {
    try {
      send.call(pi, text, { deliverAs: "followUp" });
      sent = true;
    } catch (err) {
      logError("delegate", { event: "notify-batch-error", error: String(err), runIds: deliverable.map((r) => r.runId).join(",") });
    }
  } else {
    logWarn("delegate", { event: "notify-batch-skipped", reason: "sendUserMessage unavailable" });
  }
  for (const r of deliverable) {
    if (sent) r.injected = true;
    if (r.usage && !r.usageReported && (mode === "separate" || sent)) r.usageReported = true;
  }
  debug.event("delegate-notify-batch", { count: deliverable.length, failed: failedCount, sent, runIds: deliverable.map((r) => r.runId).join(",") });
  logInfo("delegate", { event: "notify-batch", count: deliverable.length, failed: failedCount, sent });
}

/** One per-run section of a batched notification: status header + task +
 *  result file (+ error excerpt for failed runs). */
export function formatBatchRunSection(run: DelegateRun): string {
  const failed = run.status === "failed";
  const status = failed ? "FAILED ⚠️" : "completed";
  const timeoutNote = run.timedOut ? ` (timed out: ${run.timedOut})` : "";
  const header = `[acp_delegate ${status}] **${run.agent}** (runId \`${run.runId}\`, ${exitLabel(run.result?.code ?? null, run.exitSignal)})${timeoutNote}`;
  return formatPayload(header, run.result?.file ?? "", run.task, failed ? run.result?.body : undefined, failed ? run.activityFile : undefined);
}

function buildBatchTrailer(batch: DelegateRun[], anyFailed: boolean, mode: "merged" | "separate"): string {
  const remaining = Array.from(runs.values()).filter((r) => (r.status === "running" || r.status === "queued")).length;
  const remainingLine = remaining > 0
    ? `${remaining} delegate${remaining === 1 ? " is" : "s are"} still running; keep doing other work and their notifications will arrive as they finish.`
    : "No delegates are currently running.";
  let usageNote = "";
  if (mode === "separate") {
    const totalUsage = getDelegateUsage();
    if (totalUsage) {
      const cost = totalUsage.cost.total;
      const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
      usageNote = `\n── Session delegate usage (excluded from main totals) ──\nTokens: ${totalUsage.input.toLocaleString()} in, ${totalUsage.output.toLocaleString()} out (${totalUsage.totalTokens.toLocaleString()} total)${costStr}`;
    }
  } else {
    const batchUsage = batch.reduce<Usage | undefined>(
      (acc, r) => (r.usage && !r.usageReported ? accumulateUsage(acc, r.usage) : acc),
      undefined,
    );
    if (batchUsage) usageNote = `\nBatch usage: tokens=${batchUsage.totalTokens.toLocaleString()} in=${batchUsage.input.toLocaleString()} out=${batchUsage.output.toLocaleString()}`;
  }
  const closing = anyFailed
    ? "At least one delegate did NOT complete its task — its result is missing from your work. Read the error excerpts (and the result files if present), then decide whether to re-dispatch those tasks before wrapping up. This is an automated system notification, NOT a user message."
    : "This is an automated system notification, NOT a user message. Read the result files if you need the details, then continue your original task; do not treat this as a new user request.";
  return `${remainingLine}${usageNote}\n${closing}`;
}

/** Attach the recovery notice (if any) to a delegate tool result, so a lost
 *  notification resurfaces at the next delegate interaction. */
function withUndeliveredNotice(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  const notice = undeliveredNotice();
  const first = result.content[0];
  if (notice && first && first.type === "text") first.text = `${notice}\n\n${first.text}`;
  return result;
}

/** If the delegate already delivered its result via a system notification
 *  (the close handler injected before this wait was called), return a short
 *  "already delivered" message pointing at the result file, so the model
 *  never sees the same result twice (once via the injected notification,
 *  once via this tool result). Returns null when the run was NOT injected,
 *  in which case the caller delivers the full payload via formatRunResult(). */
export function injectedWaitMessage(
  run: { injected?: boolean; readSuppressed?: boolean; result?: { file: string } },
  runId: string,
  remainingLine: string,
): string | null {
  if (run.readSuppressed) {
    const file = run.result?.file;
    const fileLine = file ? ` The result file is: \`${file}\`.` : "";
    return `Delegate \`${runId}\` already finished and you read its result file — no completion notification was injected.${remainingLine}${fileLine}`;
  }
  if (!run.injected) return null;
  const file = run.result?.file;
  const fileLine = file ? ` If you need details, read the result file: \`${file}\`.` : "";
  return `Delegate \`${runId}\` already delivered its result (system notification or recovery notice) when it finished — no need to wait on it again.${remainingLine}${fileLine}`;
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
  const exec = async (args: { runId: string; timeout?: number }, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
    const run = runs.get(args.runId);
    if (!run) {
      return { details: undefined, content: [{ type: "text" as const, text: `No delegate run with runId \`${args.runId}\`. It may have already been reported or never existed.` }] };
    }
    // Already finished (e.g. the model calls wait after the injected
    // notification, or the run was cancelled).
    const displayMode = delegateDisplayUsage;
    if (run.status === "cancelled") {
      run.consumed = true;
      const file = run.result?.file || join(OUT_DIR, `${args.runId}.out`);
      return buildWaitResult(run, `Delegate \`${args.runId}\` was cancelled. ${cancelledFileNote(args.runId, file)}${remainingLineForWait(args.runId)}`, displayMode);
    }
    if (run.status === "completed" || run.status === "failed") {
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
    const timeoutMs = resolveWaitTimeoutMs(args.timeout);
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
          // Don't go through formatRunResult — a cancelled run may not have its
          // result recorded yet (finalize runs when the child exits). Partial
          // usage (if any) is accumulated per displayMode like the early-return
          // path.
          const file = run.result?.file || join(OUT_DIR, `${run.runId}.out`);
          finish(buildWaitResult(run, `Delegate \`${run.runId}\` was cancelled. ${cancelledFileNote(run.runId, file)}${remainingLineForWait(run.runId)}`, displayMode));
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
  };
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
      return withUndeliveredNotice(await exec(params as { runId: string; timeout?: number }, signal));
    },
  };
}

export function makeDelegateCancelTool(_pi: ExtensionAPI): ToolDefinition<typeof CancelParams> {
  const exec = async (params: Static<typeof CancelParams>): Promise<AgentToolResult<unknown>> => {
    const { runId } = params;
    const run = runs.get(runId);
    if (!run) {
      return { details: undefined, content: [{ type: "text", text: `Unknown runId "${runId}".` }] };
    }
    if (run.status !== "running" && run.status !== "queued") {
      return buildCancelResult(run, `Run ${runId} already ${run.status} (no action).`);
    }
    const wasQueued = run.status === "queued";
    run.status = "cancelled";
    run.consumed = true; // suppress injection; the waiter (if any) gets cancelled status
    if (wasQueued) {
      // No child exists yet, so nothing will fire finalize to free the gate slot or
      // wake a parked waiter — do both explicitly here.
      delegateGate.cancelQueued(runId);
      run.waiter?.();
    } else {
      try {
        run.child?.kill("SIGTERM");
      } catch (err) {
        debug.event("delegate-cancel-kill-error", { runId, error: String(err) });
        logError("delegate", { event: "cancel-kill-error", runId, error: String(err) });
      }
    }
    delegateStatusWidget.poke();
    const displayMode = delegateDisplayUsage;
    const file = join(OUT_DIR, `${runId}.out`);
    return buildCancelResult(run, `Cancelled ${runId} (${run.agent}). ${cancelledFileNote(runId, file)}`, displayMode);
  };
  return {
    name: "acp_delegate_cancel",
    label: "ACP Delegate Cancel",
    description:
      "Cancel a background delegate (acp_delegate async run) by runId. Sends SIGTERM to the sub-agent process.",
    promptSnippet: 'acp_delegate_cancel({ runId: "del_..." })',
    promptGuidelines: [],
    parameters: CancelParams,
    async execute(toolCallId, params): Promise<AgentToolResult<unknown>> {
      return withUndeliveredNotice(await exec(params as Static<typeof CancelParams>));
    },
  };
}

function spawnDelegateChild(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cliArgs: string[];
  isPi: boolean;
  runId: string;
  resumeFrom: boolean;
  task: string | undefined;
}): ChildProcess {
  const child = spawn(
    process.execPath,
    [resolvePiCliEntry(process.argv[1] ?? "", process.env, opts.isPi), ...opts.cliArgs],
    delegateSpawnOptions(opts.cwd, opts.env),
  ) as ChildProcess;
  child.stdin?.once("error", (e: Error) => {
    debug.event("delegate-stdin-error", { runId: "pre-spawn", error: String(e) });
    logError("delegate", { event: "stdin-error", runId: opts.runId, error: String(e) });
  });
  child.stdin?.end(delegateStdinText(opts.resumeFrom, opts.task));
  return child;
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
  const maxDepth = delegatePolicy.maxDepth;
  if (Number.isNaN(parentDepth) || parentDepth >= maxDepth) {
    return `Delegate nesting limit reached (depth ${parentDepth}, max ${maxDepth}). The delegate cannot spawn further delegates.`;
  }
  if (!args.task || !args.task.trim()) {
    if (!args.resumeFrom) {
      return `Task must be a non-empty string. Got: ${JSON.stringify(args.task).slice(0, 60)}`;
    }
  }
  let prevSession: string | null = null;
  if (args.resumeFrom) {
    if (!isPiHost(ctx.sessionManager)) {
      return `resumeFrom is only supported on pi hosts (this host has no pi session files to restore). Re-dispatch the task fresh instead.`;
    }
    const prev = runs.get(args.resumeFrom);
    if (prev && (prev.status === "running" || prev.status === "queued")) {
      return `Cannot resume from run \`${args.resumeFrom}\`: it has not finished yet (${prev.status}). Wait for it to finish first, then resume from its final session.`;
    }
    prevSession = join(OUT_DIR, `${args.resumeFrom}${SESSION_EXT}`);
    if (!existsSync(prevSession)) {
      return `Cannot resume ${args.resumeFrom}: no session file at ${prevSession} (the run produced no assistant output, or the file was cleaned up). Re-dispatch the task fresh instead.`;
    }
  }
  const taskText = args.task?.trim() || (args.resumeFrom ? "(resumed — the original task is in the session history)" : "");

  const cwd = args.cwd && args.cwd.trim() ? args.cwd : ctx.cwd;
  const childEnv = delegateChildEnv(parentDepth, maxDepth);
  const runId = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const { cliArgs, tmpDir, isAsync, useJsonStream, sessionFile } = await buildChildArgs(args, agent.prompt, ctx, runId);
  // One-shot modes (print/json = `pi -p` / SDK) exit after one turn, so async
  // injection (a follow-up turn) is never observed. Downgrade to sync there:
  // the result returns as the tool result within the same turn. Long-lived
  // modes (tui/rpc) keep true async + injection (consumed by the main loop).
  const requestedAsync = args.async !== false;
  if (requestedAsync && !isAsync) {
    debug.event("delegate-async-downgraded", { reason: `mode=${ctx.mode}` });
    logInfo("delegate", { event: "async-downgraded", reason: `mode=${ctx.mode}` });
  }
  debug.event("delegate-spawn", { agent: args.agent, runId, cwd, async: isAsync, useJsonStream, cliArgs, resumedFrom: args.resumeFrom, sessionFile });
  logInfo("delegate", { event: "spawn", agent: args.agent, runId, cwd, async: isAsync, useJsonStream, mode: ctx.mode, parentDepth, resumedFrom: args.resumeFrom, sessionFile });

  // Prepared before spawn: everything from spawn() to the child event handlers
  // must stay synchronous — an await in between lets a fast spawn failure
  // (ENOENT from a missing cwd) fire 'error' before any listener attaches,
  // which escalates to an uncaughtException and kills the host process.
  await mkdir(OUT_DIR, { recursive: true });
  if (prevSession && sessionFile) {
    // Copy (not open) so each run owns its session file: a later resume can
    // target this runId directly instead of the chain root.
    await copyFile(prevSession, sessionFile);
  }
  if (isAsync) {
    const replyFile = join(OUT_DIR, `${runId}.out`);
    const activityFile = join(OUT_DIR, `${runId}.activity`);
    const run: DelegateRun = {
      runId,
      agent: args.agent,
      task: taskText,
      cwd,
      startedAt: Date.now(),
      status: "queued",
      resumedFrom: args.resumeFrom,
    };
    runs.set(runId, run);
    delegateStatusWidget.poke();

    // Spawn + wiring is deferred behind the concurrency gate (#294): the tool
    // returns immediately with the run registered as "queued"; launch() runs
    // when a slot is free (immediately when unlimited). Watchdog timers start
    // here, at actual spawn, so queue time never counts toward idle/hard limits.
    const launch = (): void => {
      if (run.status === "cancelled") return;
      run.status = "running";
      run.startedAt = Date.now();
      run.activityFile = useJsonStream ? activityFile : undefined;
      const child = spawnDelegateChild({
        cwd,
        env: childEnv,
        cliArgs,
        isPi: isPiHost(ctx.sessionManager),
        runId,
        resumeFrom: Boolean(args.resumeFrom),
        task: args.task,
      });
      run.child = child;
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
        { eofGraceMs: EOF_GRACE_MS, idleMs: delegatePolicy.idleMs, timeoutMs: delegatePolicy.asyncTimeoutMs, killGraceMs: KILL_GRACE_MS },
      );
      // Two stream files are fed from the --mode json event stream: text_delta
      // tokens go to the reply stream (.out), tool activity (and optionally
      // thinking) goes to the activity stream (.activity). The agent is told
      // only about the activity file; the .out path arrives with the result.
      // omp has no json mode, so async delegates run plain `-p` — stdout IS the
      // reply and there is no tool activity to stream, so no .activity file.
      const replyStream = createWriteStream(replyFile, { flags: "a" });
      const activityStream = useJsonStream ? createWriteStream(activityFile, { flags: "a" }) : null;
      const endStream = (s: WriteStream | null): Promise<void> =>
        new Promise((resolve) => {
          if (!s || s.destroyed || s.closed) return resolve();
          s.end(() => resolve());
        });
      let stdoutBuf = "";
      let stderrText = "";
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

      const finalize = (code: number | null, signal?: NodeJS.Signals | null): void => {
        void (async () => {
          if (settled) return;
          settled = true;
          delegateGate.release();
          watchdog.dispose();
          void cleanupTmp(tmpDir);
          await Promise.all([endStream(replyStream), endStream(activityStream)]);
          run.exitCode = code;
          run.exitSignal = signal ?? undefined;
          const output = applier.getReplyText().trim();
          let body: string;
          if (code === 0) {
            body = output || "(no output)";
          } else {
            // Failed runs: compose a diagnostic body — stderr first (the usual
            // error channel), then the tail of the activity log (where the run
            // actually went), then whatever partial reply was produced.
            const parts: string[] = [];
            const err = stderrText.trim();
            if (err) parts.push(`stderr:\n${err}`);
            const tail = activityStream ? await readActivityTail(activityFile) : "";
            if (tail) parts.push(`last activity (full log: \`${activityFile}\`):\n${tail}`);
            if (output) parts.push(`partial reply:\n${output}`);
            body = parts.join("\n\n") || "(no output)";
          }
          // Cancelled runs KEEP their files: the partial output is exactly what
          // the model/user wants to inspect. Backfill like the failure path,
          // record a result (so wait/cancel can point at the file), and wake a
          // parked waiter. status stays "cancelled" (set by cancel).
          if (run.status === "cancelled") {
            if (output === "") {
              const fallback = stderrText.trim();
              await appendFile(replyFile, fallback ? `${fallback}\n` : "(no output)\n");
            }
            run.result = { code, file: replyFile, body: stderrText.trim() || output || "(no output)" };
            run.finishedAt = Date.now();
            debug.event("delegate-done", { runId, code, status: run.status, injected: false, outLen: output.length, file: replyFile });
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
            const effectiveCode = effectiveExitCode(code, output, stderrText);
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
            // Read-tracking: if the model already read the final result file
            // after this run finished, skip the completion notification — it
            // would only re-inject content the model already saw. Completed runs
            // only: a FAILED run's file holds partial output without any failure
            // marker, so the model cannot tell it failed from the file — the
            // FAILED notification must still go out.
            if (run.status === "completed" && shouldSuppressRead(run, delegateNotifyIfRead)) {
              applyReadSuppression(run, runId);
              debug.event("delegate-done", { runId, code, status: run.status, injected: false, suppressed: true, outLen: output.length, file });
              logInfo("delegate", { event: "done", runId, agent: args.agent, code, status: run.status, injected: false, suppressed: true, outLen: output.length, file });
              delegateStatusWidget.poke();
              return;
            }
            scheduleRunNotification(pi, run);
            debug.event("delegate-done", { runId, code, status: run.status, injected: false, queued: true, outLen: output.length, file });
            logInfo("delegate", { event: "done", runId, agent: args.agent, code, status: run.status, injected: false, queued: true, outLen: output.length, file });
            delegateStatusWidget.poke();
          } catch (err) {
            run.status = "failed";
            run.finishedAt = Date.now();
            run.result = run.result ?? { code, file: replyFile, body: `result persistence error: ${String(err)}` };
            debug.event("delegate-done-error", { runId, error: String(err) });
            logError("delegate", { event: "done-error", runId, agent: args.agent, error: String(err) });
            notifyTerminalFailure(pi, run);
            delegateStatusWidget.poke();
          }
        })();
      };

      child.on("close", (code, signal) => finalize(code, signal));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        delegateGate.release();
        watchdog.dispose();
        void cleanupTmp(tmpDir);
        void replyStream.destroy();
        void activityStream?.destroy();
        // Keep the reply file and record the spawn error in it, so the failure
        // is inspectable and the run points at a file like any other.
        const body = `spawn error: ${String(err)}`;
        void writeFile(replyFile, body, "utf8").catch(() => {});
        // Spawn-level error (e.g. EPIPE on a fast-exiting child, ENOENT).
        // Node does not guarantee a follow-up close, so finalize here too:
        // atomically set status + a synthetic result, and wake a parked waiter.
        // The settled guard in close (if it does fire) prevents double-finalize.
        if (run.status === "running" || run.status === "queued" || run.status === "cancelled") {
          run.status = run.status === "cancelled" ? "cancelled" : "failed";
          run.finishedAt = Date.now();
          run.result = { code: null, file: replyFile, body };
          debug.event("delegate-spawn-error", { runId, error: String(err) });
          logError("delegate", { event: "spawn-error", runId, agent: args.agent, error: String(err) });
          if (run.status === "failed") notifyTerminalFailure(pi, run);
          else run.waiter?.();
          delegateStatusWidget.poke();
        }
      });
      // Detach so the child survives the tool returning. Injection is best-effort:
      // the close handler calls sendUserMessage (fire-and-forget) to notify the
      // parent chat; interactive/rpc sessions consume it via their main loop.
      child.unref();
    };

    const startedNow = delegateGate.launchOrQueue(runId, launch);
    if (startedNow) {
      return [
        args.resumeFrom
          ? `Resuming **${args.agent}** from run \`${args.resumeFrom}\` (new runId \`${runId}\`).`
          : `Delegated to **${args.agent}** (runId \`${runId}\`).`,
        `Task: ${truncate(taskText, 160)}`,
        `Running in the background at \`${cwd}\`.`,
        useJsonStream
          ? `Live activity is streaming to \`${activityFile}\` — read it anytime to watch the delegate work (tool calls and their output${args.showThinking ? ", plus thinking" : ""}).`
          : `The reply is streaming to \`${replyFile}\` — read it anytime to see partial output (this host has no json event mode, so tool activity is not visible).`,
        asyncWatchdogDescription(),
        ``,
        `Call acp_delegate_wait({ runId: "${runId}" }) to block for the result (default 10s timeout). If the wait times out, or you skip it, a completion notification (with the result file path) is still injected here automatically when the delegate finishes — so you may also just continue other work now and let the result find you.`,
      ].join("\n");
    }
    return [
      args.resumeFrom
        ? `Resuming **${args.agent}** from run \`${args.resumeFrom}\` (new runId \`${runId}\`).`
        : `Delegated to **${args.agent}** (runId \`${runId}\`).`,
      `Task: ${truncate(taskText, 160)}`,
      `QUEUED — at most ${delegatePolicy.maxConcurrent} background delegate(s) run concurrently; ${Math.max(0, delegateGate.queuedCount - 1)} ahead of it. It starts automatically when a slot frees.`,
      `Call acp_delegate_wait({ runId: "${runId}" }) to block for the result; a completion notification is injected when it finishes (unless you already read the result file after it finished — then it's skipped).`,
    ].join("\n");
  }

  // Sync: block until the child finishes (bounded by the configured timeout).
  const child = spawnDelegateChild({
    cwd,
    env: childEnv,
    cliArgs,
    isPi: isPiHost(ctx.sessionManager),
    runId,
    resumeFrom: Boolean(args.resumeFrom),
    task: args.task,
  });
  const result = await waitForChild(child, signal, delegatePolicy.syncTimeoutMs);
  void cleanupTmp(tmpDir);
  const body =
    result.timedOut || result.code !== 0
      ? (result.stderr.trim() || "(no stderr)")
      : (result.stdout || "(no output)");
  const file = await persistResult(runId, body);
  return formatSyncResult(args.agent, runId, taskText, result, file);
}

export async function buildChildArgs(
  args: DelegateArgs,
  rolePrompt: string,
  ctx: ExtensionContext,
  runId: string,
): Promise<{ cliArgs: string[]; tmpDir: string; isAsync: boolean; useJsonStream: boolean; sessionFile: string | null }> {
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
  // Pi hosts persist the delegate's own session to a deterministic file so a
  // failed/cancelled run can be resumed: `--session <path>` continues the
  // file when present and creates it when missing (pi writes entries
  // synchronously, so the file is crash-safe). `--session-dir` pins the
  // location (user settings could otherwise redirect it). Every run owns its
  // own file — on resume, the earlier run's session is copied into the new
  // run's file before spawn, so resuming the most recent runId always works.
  // omp has no session flags and keeps `--no-session`.
  const useSession = isPiHost(ctx.sessionManager);
  const sessionFile = useSession ? join(OUT_DIR, `${runId}${SESSION_EXT}`) : null;
  const sessionArgs = sessionFile
    ? ["--session", sessionFile, "--session-dir", OUT_DIR]
    : ["--no-session"];
  const cliArgs = useJsonStream
    ? ["--mode", "json", ...sessionArgs, "--append-system-prompt", promptFile]
    : ["-p", ...sessionArgs, "--append-system-prompt", promptFile];

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

  // Model: per-call > role default (delegate.agents.<role>.model) > inherit parent.
  // A role-configured model is validated against the live registry; a missing one
  // falls back to the parent model with a warning and never fails (omo lesson).
  // Per-call and inherited models pass through untouched — a per-call override is a
  // deliberate choice that may name a custom/non-catalog model pi resolves itself.
  const roleCfg = delegateDefaults.agents?.[args.agent];
  const callModel = normalizeModelRef(args.model);
  const roleModel = normalizeModelRef(roleCfg?.model);
  const parentProvider = ctx.model?.provider;
  const parentModelId = ctx.model?.id;

  let provider: string | undefined;
  let modelId: string | undefined;
  let source: "call" | "role" | "inherit" = "inherit";
  if (callModel) {
    const parts = callModel.split("/");
    provider = parts[0];
    modelId = parts.slice(1).join("/");
    source = "call";
  } else if (roleModel) {
    const parts = roleModel.split("/");
    provider = parts[0];
    modelId = parts.slice(1).join("/");
    source = "role";
  } else if (parentProvider !== undefined && parentModelId !== undefined) {
    provider = parentProvider;
    modelId = parentModelId;
  }

  if (source === "role" && provider !== undefined && modelId !== undefined) {
    const registry = ctx.modelRegistry;
    const found = registry ? registry.find(provider, modelId) : undefined;
    if (!found) {
      logWarn("delegate", {
        event: "role-model-missing",
        agent: args.agent,
        requested: `${provider}/${modelId}`,
        fallback: parentProvider !== undefined ? `${parentProvider}/${parentModelId}` : null,
      });
      if (parentProvider !== undefined && parentModelId !== undefined) {
        provider = parentProvider;
        modelId = parentModelId;
        source = "inherit";
      }
    }
  }

  if (provider !== undefined && modelId !== undefined) {
    cliArgs.push("--provider", provider, "--model", modelId);
  }

  // Thinking level: per-call > role default > global default > (none = Pi default).
  // Only the highest-priority defined value is used; an invalid value warns and is
  // dropped rather than cascading to a lower-priority one.
  const thinkingPick = pickFirstDefined([args.thinkingLevel, roleCfg?.thinkingLevel, delegateDefaults.thinkingLevel]);
  if (thinkingPick !== undefined) {
    if (isValidThinkingLevel(thinkingPick)) {
      cliArgs.push("--thinking", thinkingPick);
    } else {
      logWarn("delegate", { event: "invalid-thinking-level", agent: args.agent, value: thinkingPick });
    }
  }

  return { cliArgs, tmpDir, isAsync, useJsonStream, sessionFile };
}

interface ChildResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function waitForChild(child: ChildProcess, signal: AbortSignal | undefined, timeoutMs: number | null): Promise<ChildResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stderrText = "";
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ code: null, stdout: "", stderr: stderrText, timedOut: true });
      }, timeoutMs);
    }

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(r: ChildResult) {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    }

    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
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

function fmtMinutes(ms: number): string {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

/** Model-facing summary of the ACTIVE async watchdog limits — built from the
 *  resolved policy so it stays truthful when timeouts are customized or
 *  disabled via acp.json/env. */
export function asyncWatchdogDescription(): string {
  const parts: string[] = [];
  if (delegatePolicy.idleMs !== null) parts.push(`no output for ${fmtMinutes(delegatePolicy.idleMs)}`);
  parts.push(`${EOF_GRACE_MS / 1000}s after output ends`);
  if (delegatePolicy.asyncTimeoutMs !== null) parts.push(`a ${fmtMinutes(delegatePolicy.asyncTimeoutMs)} hard limit`);
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}` : parts[0]!;
  return `A watchdog force-finishes a hung run: ${joined} — the result reflects whatever was produced.`;
}

function formatSyncResult(agent: string, runId: string, task: string, r: ChildResult, file: string): string {
  const status = r.timedOut ? "timed out" : r.code === 0 ? "completed" : "FAILED ⚠️";
  const header = `Delegate **${agent}** ${status} (runId \`${runId}\`, ${exitLabel(r.code, r.signal)}).`;
  if (r.code === 0 && !r.timedOut) {
    return formatPayload(header, file, task);
  }
  const body = r.timedOut ? "(timed out)" : (r.stderr.trim() || "(no stderr)");
  return formatPayload(header, file, task, body);
}

/** Watchdog/EOF finalize arrives with code === null (the child was killed or
 *  never exited). If a result was delivered (non-empty reply or stderr), the
 *  run counts as completed (0); otherwise it stays null = genuine failure. */
export function effectiveExitCode(code: number | null, output: string, stderr: string): number | null {
  return code ?? (output || stderr ? 0 : null);
}

/** Pure read-after-finish predicate: should the completion notification be
 *  suppressed because the model already read the final result file? Only a
 *  read at/after finishedAt counts — a read while the run was still in flight
 *  (readAt < finishedAt) saw partial output, so the notification still goes
 *  out. Callers additionally gate on run.status === "completed": a FAILED
 *  run's file holds only partial output with no failure marker, so the model
 *  cannot tell it failed from the file — failure notifications are never
 *  suppressed (failures are loud). */
export function shouldSuppressRead(
  run: { readAt?: number; finishedAt?: number },
  mode: "skip" | "always",
): boolean {
  if (mode !== "skip") return false;
  if (run.readAt === undefined || run.finishedAt === undefined) return false;
  return run.readAt >= run.finishedAt;
}

/** Suppress the completion notification for a run the model already read:
 *  mark it delivered (so wait/recovery/flush never re-surface the result),
 *  account its usage in separate mode, and log the skip. Idempotent. */
export function applyReadSuppression(run: DelegateRun, runId: string): void {
  run.readSuppressed = true;
  run.injected = true;
  if (run.usage && !run.usageReported && delegateDisplayUsage === "separate") {
    addDelegateUsage(run.usage);
    run.usageReported = true;
  }
  debug.event("delegate-inject-suppressed", { runId, reason: "result-file-read", readAt: run.readAt, finishedAt: run.finishedAt });
  logInfo("delegate", { event: "inject-suppressed", runId, reason: "result-file-read", readAt: run.readAt, finishedAt: run.finishedAt });
}

/** Apply read-suppression immediately when a qualifying read just happened.
 *  Covers the window where the notification is already queued in the
 *  coalescing batch but not yet flushed: marking the run delivered here makes
 *  the flush skip it. Inert for running runs (readAt < finishedAt), for
 *  non-completed runs (failed/cancelled — see shouldSuppressRead), and for
 *  "always" mode. */
function suppressIfReadNow(run: DelegateRun): void {
  if (run.status === "completed" && shouldSuppressRead(run, delegateNotifyIfRead)) applyReadSuppression(run, run.runId);
}

/** status (set by finalize from the effective exit code) is the authority for
 *  the FAILED/completed decision; the raw code is diagnostic display only
 *  ("exit ?"), so the notification can never disagree with run.status. */
export function injectResult(
  pi: ExtensionAPI,
  agent: string,
  runId: string,
  task: string,
  status: RunStatus,
  code: number | null,
  file: string,
  timedOut?: string,
  usage?: Usage,
  mode: "merged" | "separate" = "separate",
  usageAlreadyReported?: boolean,
  body?: string,
  activityFile?: string,
  signal?: NodeJS.Signals | null,
): boolean {
  const send = pi.sendUserMessage;
  if (typeof send !== "function") {
    debug.event("delegate-inject-skipped", { runId, reason: "sendUserMessage unavailable" });
    logWarn("delegate", { event: "inject-skipped", runId, reason: "sendUserMessage unavailable" });
    return false;
  }
  const failed = status === "failed";
  const statusLabel = failed ? "FAILED ⚠️" : "completed";
  // Tell the model how many other delegates are still running, so it doesn't
  // lose count when many were dispatched in a batch (e.g. launched 5, this is
  // the 2nd to return → "3 still running" → the model knows to keep waiting).
  // The current run is already non-running (status flipped just before this),
  // so counting in-flight runs (running or queued) gives exactly the remaining ones.
  const remaining = Array.from(runs.values()).filter((r) => (r.status === "running" || r.status === "queued")).length;
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
  
  const closing = failed
    ? "This delegate did NOT complete its task — its result is missing from your work. Read the error excerpt (and the result file if present), then decide whether to re-dispatch the task before wrapping up. This is an automated system notification, NOT a user message."
    : "This is an automated system notification, NOT a user message. Read the result file if you need the details, then continue your original task; do not treat this as a new user request.";
  const header = `[acp_delegate ${statusLabel}] **${agent}** (runId \`${runId}\`, ${exitLabel(code, signal)})${timeoutNote}${remainingLine}${usageNote} ${closing}`;
  const { text: recoveryText, covered } = buildRecoveryNotice(Array.from(runs.values()), runId);
  const text = formatPayload(header, file, task, failed ? body : undefined, failed ? activityFile : undefined) + (recoveryText ? `\n\n${recoveryText}` : "");
  try {
    // sendUserMessage is fire-and-forget (returns void): it enqueues a
    // follow-up turn. Interactive/rpc sessions consume it via their main loop;
    // injection at shutdown is best-effort (no API to await a turn).
    send.call(pi, text, { deliverAs: "followUp" });
    // Commit the recovery marking only now: a thrown send above must leave the
    // covered runs undelivered so a later carrier can still recover them.
    for (const r of covered) r.injected = true;
    return true;
  } catch (err) {
    debug.event("delegate-inject-error", { runId, error: String(err) });
    logError("delegate", { event: "inject-error", runId, agent, error: String(err) });
    return false;
  }
}

/** Deliver a terminal failure that occurred OUTSIDE normal finalize (spawn
 *  error, result persistence error). A parked waiter owns the result; with no
 *  waiter the model must still learn the run failed — the coalescing queue
 *  delivers it, and runs whose send fails land in the undelivered set for
 *  recovery. Read-suppression never applies here: a failed run's file holds
 *  only partial output with no failure marker, so the notification must go
 *  out. */
function notifyTerminalFailure(pi: ExtensionAPI, run: DelegateRun): void {
  const hadWaiter = run.waiter !== undefined;
  run.waiter?.();
  if (hadWaiter || run.consumed) return;
  scheduleRunNotification(pi, run);
}

// Build the lightweight payload: a header, the task title (so the model
// recognizes what finished — it dispatched the task, so the title suffices),
// and the result file path. NO preview: the model uses `read` for details,
// and that read (not this message) is the large content. Keeping this minimal
// means it stays cheap to retain in context (or to compress away).
function formatPayload(header: string, file: string, task: string, body?: string, activityFile?: string): string {
  const lines: string[] = [header, "", `Task: ${truncate(task, 160)}`];
  if (file) {
    lines.push(``, `Full result: \`${file}\``, "(use the `read` tool to open it if you need the details)");
  } else {
    lines.push("", "(result could not be persisted to a file)");
  }
  if (activityFile) {
    lines.push(`Activity log: \`${activityFile}\``, "(tool calls and their output, newest at the end — read it to see where the run went wrong)");
  }
  if (body) {
    lines.push("", "Output:", "~~~", truncate(body, RESULT_SUMMARY_CHARS), "~~~");
  }
  lines.push("");
  return lines.join("\n");
}

/** Tail of an activity log for failure diagnostics ("" when missing/empty). */
export async function readActivityTail(file: string, maxChars = ACTIVITY_TAIL_CHARS): Promise<string> {
  try {
    const raw = await readFile(file, "utf8");
    const text = raw.trimEnd();
    if (!text) return "";
    return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`;
  } catch {
    return "";
  }
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
