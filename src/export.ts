import { mkdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { renderHandoff, matchSession, defaultCountTokens, type CompressionState } from "acp-kernel";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { entriesToCoreMessages, extractText } from "./messages.js";
import { SessionStateStore } from "./state.js";

// The full conversation always lives in Pi's .jsonl; ACP state in the adjacent
// <sessionFile>.acp.json (written every turn). So a session is exportable once
// ACP has processed a turn in it — we scan for the state file to enumerate them.
const ACP_STATE_SUFFIX = ".acp.json";

export interface ExportOptions {
  output?: string;
  full?: boolean;
}

export interface SessionSummary {
  id: string;
  title?: string;
  label?: string;
  savedAt?: number;
  contextTokens?: number;
  blocks: number;
}

interface LoadedSession {
  id: string;
  name?: string;
  title?: string;
  entries: SessionEntry[];
  state: CompressionState;
  contextTokens: number;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function latestBlockTime(state: CompressionState): number {
  let latest = 0;
  for (const b of state.blocks) if (b.createdAt > latest) latest = b.createdAt;
  return latest;
}

function firstUserText(entries: SessionEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const text = extractText(m.content);
    if (text.trim()) return text;
  }
  return undefined;
}

async function loadSession(jsonlPath: string, store: SessionStateStore): Promise<LoadedSession> {
  const sm = SessionManager.open(jsonlPath);
  const id = sm.getSessionId();
  const entries = sm.buildContextEntries();
  const state = await store.load(jsonlPath, id);
  const coreMessages = entriesToCoreMessages(entries);
  const contextTokens = coreMessages.reduce((sum, m) => sum + defaultCountTokens(m.text ?? ""), 0);
  return { id, name: sm.getSessionName(), title: firstUserText(entries), entries, state, contextTokens };
}

async function loadAllSessions(sessionDir: string): Promise<LoadedSession[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return [];
  }
  const store = new SessionStateStore();
  const sessions: LoadedSession[] = [];
  for (const name of names) {
    if (!name.endsWith(ACP_STATE_SUFFIX)) continue;
    const jsonl = name.slice(0, -ACP_STATE_SUFFIX.length);
    try {
      sessions.push(await loadSession(path.join(sessionDir, jsonl), store));
    } catch {
      // unreadable / corrupt session file — skip it
    }
  }
  sessions.sort((a, b) => latestBlockTime(b.state) - latestBlockTime(a.state));
  return sessions;
}

export async function listSessions(sessionDir: string): Promise<SessionSummary[]> {
  const sessions = await loadAllSessions(sessionDir);
  return sessions.map((s) => ({
    id: s.id,
    title: s.title ? truncate(s.title, 120) : undefined,
    label: s.name,
    savedAt: latestBlockTime(s.state) || undefined,
    contextTokens: s.contextTokens || undefined,
    blocks: s.state.blocks.length,
  }));
}

export async function exportSession(selector: string | undefined, opts: ExportOptions, sessionDir: string): Promise<string> {
  const all = await loadAllSessions(sessionDir);
  if (all.length === 0) {
    return "No ACP-managed sessions found in this project's session directory. A session becomes exportable once billion-context-pi has processed a turn in it (its compression state is saved alongside the session file).";
  }
  if (!selector) {
    const rows = all.map((s) =>
      `${s.id}${s.name ? `  label=${s.name}` : ""}  blocks=${s.state.blocks.length}${s.contextTokens ? `  ctx~${s.contextTokens}` : ""}  ${s.title ? truncate(s.title, 80) : ""}`
    );
    return ["ACP-managed sessions:", "", ...rows.map((r) => `  ${r}`), "", "Usage: /acp-export <session-id|label> [--output handoff.md] [--full]"].join("\n");
  }
  const matches = matchSession(all, selector, (s) => s.name);
  if (matches.length === 0) {
    throw new Error(`no session matches "${selector}" (run "/acp-export" to list sessions)`);
  }
  if (matches.length > 1) {
    const ids = matches.map((s) => s.id).join(", ");
    throw new Error(`selector "${selector}" matches ${matches.length} sessions (${ids}); use the full session id`);
  }
  const s = matches[0]!;
  const markdown = renderHandoff({
    coreMessages: entriesToCoreMessages(s.entries),
    state: s.state,
    full: opts.full ?? false,
    meta: {
      title: s.title ? truncate(s.title, 200) : undefined,
      label: s.name,
      sessionId: s.id,
      contextTokens: s.contextTokens || undefined,
      extraBullets: [`- messages: ${s.entries.length}`],
    },
  });
  if (opts.output) {
    mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    writeFileSync(opts.output, markdown, "utf8");
    return `written to ${opts.output}`;
  }
  return markdown;
}

export function parseExportArgs(args: string): { selector?: string; full: boolean; output?: string; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let selector: string | undefined;
  let full = false;
  let output: string | undefined;
  let error: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--full") {
      full = true;
    } else if (t === "--output" || t === "-o") {
      const value = tokens[i + 1];
      if (value === undefined) {
        error = "--output requires a file path (e.g. /acp-export <id> --output handoff.md)";
        break;
      }
      output = value;
      i++;
    } else if (t.startsWith("--output=")) {
      output = t.slice("--output=".length);
    } else if (!selector) {
      selector = t;
    }
  }
  return { selector, full, output, error };
}
