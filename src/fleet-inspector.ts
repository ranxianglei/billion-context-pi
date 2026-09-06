import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { OUT_DIR, fleetRunsSnapshot, type FleetRunView } from "./delegate-tool.js";

const REFRESH_MS = 500;
const MAX_TASK_LEN = 48;
const SNAPSHOT_TAIL_BYTES = 4096;
const MAX_RESULT_LINES = 8;
const PANEL_MAX_H = 40;
const PANEL_MIN_H = 12;

export interface InspectorTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  bg(color: string, text: string): string;
  italic?(text: string): string;
  underline?(text: string): string;
  strikethrough?(text: string): string;
}

interface TuiLike {
  requestRender(force?: boolean): void;
  terminal: { rows: number };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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

/** First maxBytes of a file as utf8. Missing/unreadable → "". */
export function readHeadSync(file: string | undefined, maxBytes: number): string {
  if (!file) return "";
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return "";
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, 0);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

interface SessionContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface SessionMessage {
  role: string;
  content?: SessionContentBlock[];
  toolName?: string;
  isError?: boolean;
}

interface SessionLine {
  type: string;
  provider?: string;
  modelId?: string;
  message?: SessionMessage;
}

export interface TranscriptBlock {
  kind: "user" | "thinking" | "text" | "toolCall" | "toolResult" | "meta";
  name?: string;
  text: string;
  isError?: boolean;
  args?: unknown;
}

/** Pi-style one-line summary of a tool call (mirrors pi's formatToolCall). */
export function formatToolLabel(name: string, args: unknown): string {
  const a: Record<string, unknown> = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const s = (v: unknown): string => String(v ?? "");
  switch (name) {
    case "read": {
      const path = s(a.path ?? a.file_path);
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        display += `:${start}${end ? `-${end}` : ""}`;
      }
      return `read ${display}`;
    }
    case "write": return `write ${s(a.path ?? a.file_path)}`;
    case "edit": return `edit ${s(a.path ?? a.file_path)}`;
    case "bash": {
      const cmd = s(a.command).replace(/[\n\t]/g, " ").trim();
      return `bash ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`;
    }
    case "grep": return `grep /${s(a.pattern)}/ in ${s(a.path ?? ".")}`;
    case "find": return `find ${s(a.pattern)} in ${s(a.path ?? ".")}`;
    case "ls": return `ls ${s(a.path ?? ".")}`;
    default: {
      let j = "";
      try { j = JSON.stringify(args ?? {}); } catch { j = String(args); }
      return `${name} ${j.length > 60 ? `${j.slice(0, 60)}…` : j}`;
    }
  }
}

/** Parse a pi session .jsonl into display blocks (conversation + thinking + tools). */
export function parseSessionJsonl(raw: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: SessionLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "model_change") {
      blocks.push({ kind: "meta", text: `model → ${obj.provider}/${obj.modelId}` });
      continue;
    }
    if (obj.type !== "message") continue;
    const m = obj.message;
    if (!m) continue;
    if (m.role === "user") {
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text?.trim()) blocks.push({ kind: "user", text: c.text });
      }
    } else if (m.role === "assistant") {
      for (const c of m.content ?? []) {
        if (c.type === "thinking" && c.thinking?.trim()) blocks.push({ kind: "thinking", text: c.thinking });
        else if (c.type === "text" && c.text?.trim()) blocks.push({ kind: "text", text: c.text });
        else if (c.type === "toolCall") blocks.push({ kind: "toolCall", name: c.name, text: "", args: c.arguments });
      }
    } else if (m.role === "toolResult") {
      const text = (m.content ?? []).map((c) => c.text ?? "").join("");
      blocks.push({ kind: "toolResult", name: m.toolName, text, isError: !!m.isError });
    }
  }
  return blocks;
}

function padTo(line: string, w: number): string {
  return truncateToWidth(line, w, undefined, true);
}

function frame(body: string[], width: number, theme: InspectorTheme): string[] {
  const innerW = Math.max(0, width - 4);
  const bar = "─".repeat(Math.max(0, width - 2));
  const top = theme.fg("border", `┌${bar}┐`);
  const bottom = theme.fg("border", `└${bar}┘`);
  const mid = body.map((l) => `${theme.fg("border", "│")} ${padTo(l, innerW)} ${theme.fg("border", "│")}`);
  return [top, ...mid, bottom];
}

export function renderListBody(rows: ListRow[], selIdx: number, theme: InspectorTheme, innerW: number): string[] {
  if (rows.length === 0) {
    return [truncateToWidth(theme.fg("dim", "no delegate runs yet — dispatch one with acp_delegate"), innerW)];
  }
  return rows.map((row, i) => {
    const color = row.run.status === "running" ? "warning" : row.run.status === "completed" ? "success" : row.run.status === "failed" ? "error" : "muted";
    const prefix = i === selIdx ? "> " : "  ";
    const line = `${prefix}${theme.fg(color, row.label)}  ${theme.fg("dim", row.detail)}`;
    const filled = padTo(line, innerW);
    return i === selIdx ? theme.bg("selectedBg", filled) : filled;
  });
}

function buildMarkdownTheme(theme: InspectorTheme): MarkdownTheme {
  return {
    heading: (t) => theme.bold(theme.fg("accent", t)),
    link: (t) => theme.fg("accent", t),
    linkUrl: (t) => theme.fg("dim", t),
    code: (t) => theme.fg("text", t),
    codeBlock: (t) => theme.fg("dim", t),
    codeBlockBorder: (t) => theme.fg("borderMuted", t),
    quote: (t) => theme.fg("dim", t),
    quoteBorder: (t) => theme.fg("borderMuted", t),
    hr: (t) => theme.fg("borderMuted", t),
    listBullet: (t) => theme.fg("accent", t),
    bold: (t) => theme.bold(t),
    italic: (t) => (theme.italic ? theme.italic(t) : theme.fg("dim", t)),
    strikethrough: (t) => (theme.strikethrough ? theme.strikethrough(t) : t),
    underline: (t) => (theme.underline ? theme.underline(t) : t),
  };
}

export function renderTranscriptBlocks(blocks: TranscriptBlock[], theme: InspectorTheme, innerW: number): string[] {
  const out: string[] = [];
  const wrapW = Math.max(10, innerW - 2);
  for (const b of blocks) {
    switch (b.kind) {
      case "meta":
        out.push(truncateToWidth(theme.fg("dim", `· ${b.text}`), innerW));
        break;
      case "user":
        out.push(theme.bold(theme.fg("userMessageText", "you ›")));
        for (const l of wrapTextWithAnsi(b.text, wrapW)) out.push(theme.fg("userMessageText", `  ${l}`));
        break;
      case "thinking":
        for (const l of wrapTextWithAnsi(b.text, wrapW)) out.push(theme.fg("thinkingText", `  ⌥ ${l}`));
        break;
      case "text": {
        try {
          const md = new Markdown(b.text, 0, 0, buildMarkdownTheme(theme));
          for (const l of md.render(wrapW)) out.push(truncateToWidth(`  ${l}`, innerW));
        } catch {
          for (const l of wrapTextWithAnsi(b.text, wrapW)) out.push(theme.fg("text", `  ${l}`));
        }
        break;
      }
      case "toolCall": {
        out.push(truncateToWidth(theme.fg("toolTitle", theme.bold(`  ⚙ ${b.name ?? "?"}`)), innerW));
        const label = formatToolLabel(b.name ?? "", b.args);
        if (label) out.push(truncateToWidth(theme.fg("dim", `     ${label}`), innerW));
        break;
      }
      case "toolResult": {
        const icon = b.isError ? "✗" : "✓";
        const color = b.isError ? "error" : "toolOutput";
        const rawLines = b.text.replace(/\n+$/, "").split("\n");
        const shown = rawLines.slice(0, MAX_RESULT_LINES);
        shown.forEach((l, i) => out.push(truncateToWidth(theme.fg(color, `  ${i === 0 ? `${icon} ${b.name ?? "?"}: ` : ""}${l}`), innerW)));
        if (rawLines.length > shown.length) out.push(truncateToWidth(theme.fg("dim", `      … +${rawLines.length - shown.length} more`), innerW));
        break;
      }
    }
  }
  if (out.length === 0) out.push(theme.fg("dim", "(no session content yet)"));
  return out;
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
  private viewTop = 0;
  private blocks: TranscriptBlock[] = [];
  private loadedFile = "";
  private loadedBytes = 0;
  private transcriptLines: string[] = [];
  private lastWidth = 80;
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
    // no cache — render() recomputes from rows/blocks each frame
  }

  private panelHeight(): number {
    return clamp(this.tui.terminal.rows - 2, PANEL_MIN_H, PANEL_MAX_H);
  }

  private pageSize(): number {
    return Math.max(1, this.panelHeight() - 2 - 2 - 1);
  }

  /** Incrementally append newly-written session.jsonl bytes (waterfall load).
   *  Only reads the delta past loadedBytes; holds back a trailing partial line
   *  while the run is still writing. */
  private loadTranscript(file: string | undefined, isRunning: boolean): void {
    if (!file) return;
    if (file !== this.loadedFile) {
      this.loadedFile = file;
      this.loadedBytes = 0;
      this.blocks = [];
    }
    let size = 0;
    try {
      const fd = openSync(file, "r");
      try { size = fstatSync(fd).size; } finally { closeSync(fd); }
    } catch {
      return;
    }
    if (size < this.loadedBytes) {
      this.loadedBytes = 0;
      this.blocks = [];
    }
    if (size <= this.loadedBytes) return;
    const len = size - this.loadedBytes;
    const buf = Buffer.alloc(len);
    let got = 0;
    try {
      const fd = openSync(file, "r");
      try { got = readSync(fd, buf, 0, len, this.loadedBytes); } finally { closeSync(fd); }
    } catch {
      return;
    }
    const text = buf.subarray(0, got).toString("utf8");
    let complete: string;
    if (isRunning && !text.endsWith("\n")) {
      const nl = text.lastIndexOf("\n");
      if (nl < 0) return;
      complete = text.slice(0, nl + 1);
    } else {
      complete = text;
    }
    this.blocks.push(...parseSessionJsonl(complete));
    this.loadedBytes += Buffer.byteLength(complete, "utf8");
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
    if (this.mode === "transcript" && sel) {
      this.loadTranscript(sel.sessionFile, sel.status === "running");
      this.transcriptLines = renderTranscriptBlocks(this.blocks, this.theme, Math.max(20, this.lastWidth - 4));
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      if (this.mode === "transcript") {
        this.mode = "list";
        this.follow = true;
        this.viewTop = 0;
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
    } else {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.scrollTranscript(-1);
      else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.scrollTranscript(1);
      else if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) this.scrollTranscript(-this.pageSize());
      else if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) this.scrollTranscript(this.pageSize());
      else if (matchesKey(data, Key.enter)) {
        this.mode = "list";
        this.tui.requestRender();
      }
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

  private scrollTranscript(delta: number): void {
    const maxTop = Math.max(0, this.transcriptLines.length - this.pageSize());
    this.viewTop = clamp(this.viewTop + delta, 0, maxTop);
    this.follow = this.viewTop >= maxTop;
    this.tui.requestRender();
  }

  private openTranscript(): void {
    const sel = this.rows[this.selIdx];
    if (!sel) return;
    this.selRunId = sel.run.runId;
    this.mode = "transcript";
    this.follow = true;
    this.viewTop = 0;
    this.tick();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.doneCb();
  }

  private transcriptHeader(sel: FleetRunView, innerW: number): string[] {
    const now = Date.now();
    const dur = formatDuration((sel.finishedAt ?? now) - sel.startedAt);
    const state = sel.status === "running" ? `running ${dur}` : `${sel.status} ${sel.exitLabel} after ${dur}`;
    const head = `${statusIcon(sel.status)} ${sel.agent} · ${sel.runId} · ${state}`;
    const bits = [sel.cwd];
    const tok = usageSummary(sel.usage);
    if (tok) bits.push(tok);
    if (sel.resumedFrom) bits.push(`resumed ${sel.resumedFrom}`);
    return [
      truncateToWidth(this.theme.bold(this.theme.fg("accent", head)), innerW),
      truncateToWidth(this.theme.fg("dim", bits.join(" · ")), innerW),
    ];
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const innerW = Math.max(20, width - 4);
    const sel = this.rows[this.selIdx]?.run;
    const useList = this.mode === "list" || !sel;
    const headerN = useList ? 1 : 2;
    const midH = Math.max(1, this.panelHeight() - 2 - headerN - 1);

    let header: string[];
    let middle: string[];
    let footer: string;
    if (useList) {
      header = [truncateToWidth(this.theme.bold(this.theme.fg("accent", `acp_delegate · ${this.rows.length} run${this.rows.length === 1 ? "" : "s"} (live)`)), innerW)];
      middle = renderListBody(this.rows, this.selIdx, this.theme, innerW);
      let top = this.viewTop;
      if (this.selIdx < top) top = this.selIdx;
      else if (this.selIdx >= top + midH) top = this.selIdx - midH + 1;
      top = Math.max(0, top);
      middle = middle.slice(top, top + midH);
      footer = this.theme.fg("dim", "↑↓ select · enter inspect · esc close");
    } else {
      header = this.transcriptHeader(sel, innerW);
      middle = this.transcriptLines;
      const maxTop = Math.max(0, middle.length - midH);
      const top = clamp(this.follow ? maxTop : this.viewTop, 0, maxTop);
      middle = middle.slice(top, top + midH);
      footer = this.theme.fg("dim", "↑↓/←→/pg scroll · enter back · esc close");
    }
    while (middle.length < midH) middle.push("");
    return frame([...header, ...middle, footer], width, this.theme);
  }
}

/** Open the live fleet inspector: bordered TUI overlay in interactive mode,
 *  plain-text snapshot notification elsewhere. Resolves when the user closes it. */
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
      width: "100%",
      minWidth: 80,
      anchor: "center",
    },
  });
}
