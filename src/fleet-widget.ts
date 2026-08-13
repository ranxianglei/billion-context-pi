import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initFooterStatus, updateFooterStatus, disposeFooterStatus } from "./footer-status.js";

const DELEGATE_WIDGET_KEY = "billion-context-pi-delegates";
const REFRESH_MS = 500;
const MAX_TASK_LEN = 48;

interface WidgetRun {
  runId: string;
  agent: string;
  task: string;
  startedAt: number;
}

type RunsSnapshot = () => WidgetRun[];

let ui: ExtensionContext["ui"] | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastRenderKey = "";
let runsSnapshot: RunsSnapshot | undefined;

function truncateTask(task: string): string {
  const oneLine = task.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_TASK_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_TASK_LEN - 1)}…`;
}

function renderLines(runs: WidgetRun[]): string[] | undefined {
  if (runs.length === 0) return undefined;
  const now = Date.now();
  const header = runs.length === 1
    ? `acp_delegate · 1 running`
    : `acp_delegate · ${runs.length} running`;
  const rows = runs.map((r) => {
    const elapsed = Math.max(0, Math.round((now - r.startedAt) / 1000));
    return `  ● ${r.agent} (${elapsed}s) — ${truncateTask(r.task)}`;
  });
  return [header, ...rows];
}

function renderKeyFor(runs: WidgetRun[]): string {
  return runs
    .map((r) => `${r.agent}:${Math.round((Date.now() - r.startedAt) / 1000)}:${truncateTask(r.task)}`)
    .join("|");
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function clearWidget(): void {
  if (!ui) return;
  try {
    ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
  } catch {
    // session is tearing down — best effort
  }
}

function refresh(): void {
  if (!ui) return;
  const runs = runsSnapshot ? runsSnapshot() : [];
  if (runs.length === 0) {
    // Empty list: clear the widget and stop the timer so an idle TUI does not
    // tick forever. The next poke() (on a new spawn) restarts it.
    if (lastRenderKey !== "") {
      lastRenderKey = "";
      clearWidget();
    }
    // Final accumulated usage must still be shown after the last delegate
    // finishes, so refresh the footer before stopping the timer.
    updateFooterStatus();
    stopTimer();
    return;
  }
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  // Debounce: skip re-render if the visible state (agent + elapsed-second +
  // count + task) hasn't changed since last render. Elapsed is rounded to
  // seconds, so this naturally re-renders ~once per second per run.
  const renderKey = renderKeyFor(sorted);
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  const lines = renderLines(sorted);
  try {
    ui.setWidget(DELEGATE_WIDGET_KEY, lines, { placement: "belowEditor" });
  } catch {
    // Real teardown goes through dispose() (session_shutdown). setWidget does
    // not throw "stale" — if it ever throws here, best effort is to clear ui
    // so the next setContext rebinds.
    ui = undefined;
    stopTimer();
  }
  // Delegates still running: keep the footer usage line fresh too (deduped
  // inside updateFooterStatus, so this is O(1) per 500ms tick).
  updateFooterStatus();
}

export const delegateStatusWidget = {
  setContext(ctx: ExtensionContext, snapshot: RunsSnapshot): void {
    // Only the interactive TUI renders widgets. RPC mode has hasUI === true but
    // its setWidget just emits extension_ui_request notifications to an RPC
    // client — useless here and a needless ~1Hz chatter. print/json have
    // hasUI === false. Guard on the mode directly (types.d.ts: "Use \"tui\" to
    // guard terminal-only UI").
    if (ctx.mode !== "tui") return;
    initFooterStatus(ctx);
    ui = ctx.ui;
    runsSnapshot = snapshot;
    if (!timer) {
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref?.();
    }
    refresh();
  },
  dispose(): void {
    stopTimer();
    clearWidget();
    disposeFooterStatus();
    ui = undefined;
    lastRenderKey = "";
  },
  poke(): void {
    // A new spawn may arrive after refresh() stopped the timer on an empty
    // list. Restart it so the widget updates.
    if (ui && !timer) {
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref?.();
    }
    refresh();
  },
};
