import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { OUT_DIR, fleetRunsSnapshot, type FleetRunView } from "./delegate-tool.js";

const REFRESH_MS = 500;
const TRANSCRIPT_TAIL_BYTES = 8192;
const SNAPSHOT_TAIL_BYTES = 4096;
const MAX_TASK_LEN = 48;
const MAX_CONTENT_LINES = 30;

export interface InspectorTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface TuiLike {
  requestRender(force?: boolean): void;
  terminal: { rows: number };
}

function truncateText(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function statusIcon(status: FleetRunView["status"]): string {
  switch (status) {
    case "queued": return "○";
    case "running": return "●";
    case "completed": return "✓";
    case "failed": return "✗";
    case "cancelled": return "⊘";
  }
}

export function usageSummary(usage: FleetRunView["usage"]): string | undefined {
  if (!usage || usage.totalTokens <= 0) return undefined;
  return `\u2191${usage.input.toLocaleString()} \u2193${usage.output.toLocaleString()}`;
}

export interface ListRow {
  run: FleetRunView;
  label: string;
  detail: string;
}

export function buildListRows(runs: FleetRunView[], now: number): ListRow[] {
  return runs.map((run) => {
    const dur = formatDuration((run.finishedAt ?? now) - run.startedAt);
    const state = run.status === "running" ? `running ${dur}` : `${run.status} ${run.exitLabel}`;
    const label = `${statusIcon(run.status)} ${run.agent} · ${state}${run.timedOut ? ` (${run.timedOut})` : ""}`;
    const tokens = usageSummary(run.usage);
    const detail = truncateText(run.task, MAX_TASK_LEN) + (tokens ? ` [${tokens}]` : "");
    return { run, label, detail };
  });
}

/** Last maxBytes of a file as utf8; a partial leading line is dropped so the
 *  tail always starts on a line boundary. Missing/unreadable → "". */
export function readTailSync(file: string | undefined, maxBytes: number): string {
  if (!file) return "";
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return "";
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      let text = buf.toString("utf8");
      if (size > len) {
        const nl = text.indexOf("\n");
        text = nl >= 0 ? text.slice(nl + 1) : "";
      }
      return text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function renderListView(rows: ListRow[], selIdx: number, theme: InspectorTheme, width: number): string[] {
  if (rows.length === 0) {
    return [
      truncateToWidth(theme.bold(theme.fg("accent", "acp_delegate")), width),
      truncateToWidth(theme.fg("dim", "no delegate runs yet — dispatch one with acp_delegate"), width),
      "",
      truncateToWidth(theme.fg("dim", "esc close"), width),
    ];
  }
  const lines: string[] = [
    truncateToWidth(theme.bold(theme.fg("accent", `acp_delegate · ${rows.length} run${rows.length === 1 ? "" : "s"} (live)`)), width),
  ];
  rows.forEach((row, i) => {
    const color = row.run.status === "running" ? "warning" : row.run.status === "completed" ? "success" : row.run.status === "failed" ? "error" : "muted";
    const prefix = i === selIdx ? "> " : "  ";
    lines.push(truncateToWidth(`${prefix}${theme.fg(color, row.label)}  ${theme.fg("dim", row.detail)}`, width));
  });
  lines.push("");
  lines.push(truncateToWidth(theme.fg("dim", "↑↓ select · enter inspect · esc close"), width));
  return lines;
}

export function renderTranscriptView(run: FleetRunView, tail: string, now: number, theme: InspectorTheme, width: number): string[] {
  const dur = formatDuration((run.finishedAt ?? now) - run.startedAt);
  const head = `${statusIcon(run.status)} ${run.agent} · ${run.runId} · ${run.status === "running" ? `running ${dur}` : `${run.status} ${run.exitLabel} after ${dur}`}`;
  const metaBits = [run.cwd];
  const tokens = usageSummary(run.usage);
  if (tokens) metaBits.push(tokens);
  if (run.resumedFrom) metaBits.push(`resumed from ${run.resumedFrom}`);
  const lines: string[] = [
    truncateToWidth(theme.bold(theme.fg("accent", head)), width),
    truncateToWidth(theme.fg("dim", metaBits.join(" · ")), width),
    "",
  ];
  const body = tail.trimEnd();
  if (body) {
    for (const l of body.split("\n")) lines.push(truncateToWidth(l, width));
  } else {
    lines.push(theme.fg("dim", "(no output yet)"));
  }
  lines.push("");
  lines.push(truncateToWidth(theme.fg("dim", "pgup/pgdn scroll · esc back"), width));
  return lines;
}

/** Plain-text snapshot for non-TUI hosts (rpc/print/json). */
export function buildSnapshotText(runs: FleetRunView[], now: number): string {
  if (runs.length === 0) return "acp_delegate: no runs recorded this session.";
  const parts: string[] = [`acp_delegate · ${runs.length} run(s)`];
  for (const row of buildListRows(runs, now)) {
    parts.push(`- ${row.label} — ${row.detail}`);
    if (row.run.status === "running") {
      const tail = readTailSync(row.run.activityFile, SNAPSHOT_TAIL_BYTES).trimEnd();
      if (tail) {
        for (const l of tail.split("\n").slice(-8)) parts.push(`    ${l}`);
      }
    }
  }
  parts.push("");
  parts.push(`Files under ${OUT_DIR}: <runId>.out (reply), <runId>.activity (tool log), <runId>.session.jsonl (session)`);
  return parts.join("\n");
}

class FleetInspectorComponent implements Component {
  private mode: "list" | "transcript" = "list";
  private rows: ListRow[] = [];
  private selIdx = 0;
  private selRunId: string | undefined;
  private follow = true;
  private scrollLines = 0;
  private tailText = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private tui: TuiLike,
    private theme: InspectorTheme,
    private doneCb: () => void,
    private snapshotFn: () => FleetRunView[],
    private refreshMs: number,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.refreshMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {
    // no cache — render() recomputes rows and tails from scratch
  }

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    this.rows = buildListRows(this.snapshotFn(), now);
    if (this.selRunId) {
      const idx = this.rows.findIndex((r) => r.run.runId === this.selRunId);
      this.selIdx = idx >= 0 ? idx : 0;
    } else if (this.selIdx >= this.rows.length) {
      this.selIdx = Math.max(0, this.rows.length - 1);
    }
    const sel = this.rows[this.selIdx]?.run;
    if (sel && this.mode === "transcript") {
      this.tailText = readTailSync(sel.activityFile ?? sel.replyFile, TRANSCRIPT_TAIL_BYTES);
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      if (this.mode === "transcript") {
        this.mode = "list";
        this.follow = true;
        this.scrollLines = 0;
        this.tui.requestRender();
      } else {
        this.close();
      }
      return;
    }
    if (this.mode === "list") {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.move(-1);
      else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.move(1);
      else if (matchesKey(data, Key.enter) || matchesKey(data, "x")) this.openTranscript();
    } else if (matchesKey(data, Key.pageUp)) {
      this.follow = false;
      this.scrollLines += 10;
      this.tui.requestRender();
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollLines = Math.max(0, this.scrollLines - 10);
      if (this.scrollLines === 0) this.follow = true;
      this.tui.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      this.mode = "list";
      this.tui.requestRender();
    }
  }

  private move(dir: -1 | 1): void {
    if (this.rows.length === 0) return;
    const next = Math.min(this.rows.length - 1, Math.max(0, this.selIdx + dir));
    if (next !== this.selIdx) {
      this.selIdx = next;
      this.selRunId = this.rows[next]?.run.runId;
      this.tui.requestRender();
    }
  }

  private openTranscript(): void {
    const sel = this.rows[this.selIdx];
    if (!sel) return;
    this.selRunId = sel.run.runId;
    this.mode = "transcript";
    this.follow = true;
    this.scrollLines = 0;
    this.tick();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.doneCb();
  }

  render(width: number): string[] {
    if (this.mode !== "transcript") return renderListView(this.rows, this.selIdx, this.theme, width);
    const sel = this.rows[this.selIdx]?.run;
    if (!sel) return renderListView(this.rows, this.selIdx, this.theme, width);
    const full = renderTranscriptView(sel, this.tailText, Date.now(), this.theme, width);
    // Header = first 3 lines, footer = last 2; window the body so the view
    // never outgrows the overlay even on short terminals.
    const header = full.slice(0, 3);
    const footer = full.slice(-2);
    const body = full.slice(3, -2);
    const contentBudget = Math.max(4, Math.min(MAX_CONTENT_LINES, Math.floor(this.tui.terminal.rows * 0.7) - 5));
    const start = this.follow ? Math.max(0, body.length - contentBudget) : Math.max(0, Math.min(body.length - contentBudget, body.length - this.scrollLines - contentBudget));
    const visible = body.slice(start, start + contentBudget);
    return [...header, ...visible, ...footer];
  }
}

/** Open the live fleet inspector: TUI overlay in interactive mode, plain-text
 *  snapshot notification elsewhere. Resolves when the user closes it. */
export async function openFleetInspector(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    const text = buildSnapshotText(fleetRunsSnapshot(), Date.now());
    if (ctx.hasUI) ctx.ui.notify(text);
    else console.log(text);
    return;
  }
  await ctx.ui.custom(async (tui, theme, _keybindings, done) => {
    const comp = new FleetInspectorComponent(tui, theme, () => done(undefined), fleetRunsSnapshot, REFRESH_MS);
    comp.start();
    return comp;
  }, {
    overlay: true,
    overlayOptions: {
      width: "72%",
      minWidth: 64,
      maxHeight: 38,
      anchor: "center",
    },
  });
}
