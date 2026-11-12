import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { logWarn } from "./log.js";

type AgentMessage = SessionMessageEntry["message"];

/** [#351] Character-level degenerate-repeat guard. Models occasionally
 *  degenerate into long single-codepoint runs (observed in the wild: a
 *  5968-char thinking block ending in 4655 consecutive 「【」, escalating over
 *  turns until the turn aborts). This is distinct from `repetitionGuard`
 *  (issue #308), which breaks byte-identical TOOL-CALL loops; here the
 *  attractor is inside the generated text/thinking itself.
 *
 *  Why the adapter must act: pi replays prior assistant thinking back to the
 *  provider on every subsequent request (openai-completions sends it as
 *  `reasoning_content`, or as plain text when `requiresThinkingAsText`), and
 *  an aborted turn's partial message persists in the session log. A
 *  degenerated tail therefore rides along every later prompt, where the model
 *  sees its own previous output ending in thousands of repeated characters —
 *  a continuation bias that re-triggers the same degeneration, aborting the
 *  next turn too. The session dies in an abort loop with no recovery path.
 *
 *  The pass below collapses runs >= minRun in assistant text/thinking of the
 *  OUTGOING view (persisted history is never modified) and appends a one-shot
 *  recovery notice while the degenerated message is the most recent assistant
 *  turn. Position-based self-limiting: a fresh model turn makes the old
 *  message non-last, so the notice stops appearing without any persistent
 *  state (and cannot accumulate — #223 lesson). */
export interface DegenerationGuardConfig {
  /** Master switch. Default: true. `false` disables the pass entirely
   *  (kill-switch). */
  enabled?: boolean;
  /** Minimum length of a single-codepoint run (counted in codepoints) before
   *  it is treated as degeneration. Legitimate single-char runs in coding
   *  sessions (markdown hrules, dotted leaders, comment banners) stay well
   *  under this; observed pre-degeneration drift maxed at ~60 before the
   *  catastrophic 4655×「【」 run. Default: 200. Values below 8 are raised to
   *  8: the collapse marker must stay shorter than any detectable run, and a
   *  sub-8 threshold would start matching ordinary dotted leaders/hrules. */
  minRun?: number;
}

export const DEFAULT_DEGENERATION_GUARD: Required<DegenerationGuardConfig> = { enabled: true, minRun: 200 };

// Below this threshold the collapse marker itself could contain (or create)
// detectable runs and sub-threshold matching starts hitting legitimate dotted
// leaders/hrules — raised silently, not treated as invalid.
const MIN_VALID_MIN_RUN = 8;

/** Resolve the guard config, handling the boolean shorthand (`false`
 *  disables). Invalid minRun values (< 2 or non-numeric) fall back to the
 *  default with a logged warning — they never fail the session. Valid values
 *  below MIN_VALID_MIN_RUN are raised to it. */
export function resolveDegenerationGuard(cfg?: boolean | DegenerationGuardConfig): Required<DegenerationGuardConfig> {
  if (cfg === false) return { enabled: false, minRun: DEFAULT_DEGENERATION_GUARD.minRun };
  const c = typeof cfg === "object" && cfg !== null ? cfg : {};
  let minRun = DEFAULT_DEGENERATION_GUARD.minRun;
  if (c.minRun !== undefined) {
    const n = c.minRun;
    if (typeof n === "number" && Number.isFinite(n) && n >= 2) {
      minRun = Math.max(MIN_VALID_MIN_RUN, Math.floor(n));
    } else {
      logWarn("config", { event: "degeneration-guard-invalid", field: "minRun", value: n, fallback: DEFAULT_DEGENERATION_GUARD.minRun });
    }
  }
  return { enabled: c.enabled !== false, minRun };
}

/** One maximal run of a repeated codepoint. */
export interface DegenerateRun {
  /** The repeated codepoint (string of length 1 or 2 — surrogate pairs kept whole). */
  char: string;
  /** Run length in codepoints. */
  count: number;
  /** UTF-16 index of the run start in the original string. */
  index: number;
}

// Pre-screen before the full codepoint scan: one compiled regex pass with no
// allocation decides whether a block can hold a degenerate run at all, so the
// Array.from scan (one string object per codepoint) only runs on the rare
// dirty block. Equivalent to the scan, not an approximation: with /s/u, `.`
// matches EVERY codepoint (line terminators and isolated surrogates included),
// so no run the scan would find can go unmatched, and a match is by
// construction a run of >= minRun identical codepoints (no false positives).
// Memoized per threshold — recompiling per block would eat the savings.
let preScreenMinRun = Number.NaN;
let preScreenRe: RegExp | null = null;

function hasLongRun(text: string, minRun: number): boolean {
  const n = Math.floor(minRun);
  if (preScreenRe === null || preScreenMinRun !== n) {
    preScreenMinRun = n;
    preScreenRe = new RegExp(`(.)\\1{${Math.max(n - 1, 0)},}`, "su");
  }
  return preScreenRe.test(text);
}

/** Find maximal runs of a single repeated codepoint with length >= minRun.
 *  Codepoint-safe: surrogate pairs count as one unit, so a run of astral
 *  characters is detected like any other. Returns [] for empty input or
 *  minRun < 2 (a "run" shorter than 2 carries no signal). */
export function findDegenerateRuns(text: string, minRun: number): DegenerateRun[] {
  const runs: DegenerateRun[] = [];
  if (!text || !Number.isFinite(minRun) || minRun < 2) return runs;
  if (!hasLongRun(text, minRun)) return runs;
  const chars = Array.from(text);
  let utf16 = 0;
  let k = 0;
  while (k < chars.length) {
    const ch = chars[k]!;
    let m = k + 1;
    while (m < chars.length && chars[m] === ch) m++;
    const count = m - k;
    if (count >= minRun) runs.push({ char: ch, count, index: utf16 });
    utf16 += count * ch.length;
    k = m;
  }
  return runs;
}

function describeChar(ch: string): string {
  if (ch === " ") return "space";
  if (ch === "\n") return "newline";
  if (ch === "\t") return "tab";
  if (ch === "\r") return "carriage-return";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  return JSON.stringify(ch);
}

function applyRuns(text: string, runs: DegenerateRun[], minRun: number): string {
  // Idempotency: keep fewer copies than minRun, and the fixed marker text must
  // contain NO adjacent duplicate codepoints — otherwise a re-scan at low
  // thresholds would collapse inside the marker itself (observed: "collapsed"
  // has an "ll" run). The kept copies double as the character sample, so the
  // marker need not quote the char (which could add runs for \ and ").
  const keep = Math.max(1, Math.min(3, minRun - 1));
  let out = "";
  let last = 0;
  for (const r of runs) {
    out += text.slice(last, r.index);
    out += `${r.char.repeat(keep)}… [${r.count}× identical chars cut — degenerate repeat]`;
    last = r.index + r.count * r.char.length;
  }
  out += text.slice(last);
  return out;
}

/** Collapse every degenerate run in `text` into a short marker that names the
 *  character and its original count. Pure, idempotent, fail-safe. Returns the
 *  input unchanged when there is nothing to collapse. */
export function collapseDegenerateRuns(text: string, minRun: number): string {
  const runs = findDegenerateRuns(text, minRun);
  return runs.length > 0 ? applyRuns(text, runs, minRun) : text;
}

/** Evidence of one rewritten message: which blocks changed and what was collapsed. */
export interface CollapseEvidence {
  /** Index of the rewritten message in the input array. */
  msgIndex: number;
  /** Block kinds rewritten ("content" for string content, else "text"/"thinking"). */
  blocks: string[];
  /** Runs collapsed across those blocks. */
  runs: DegenerateRun[];
}

/** Request-time pass: collapse degenerate single-codepoint runs in ASSISTANT
 *  messages' text/thinking blocks (string content included). Every position is
 *  scanned — including the current turn's partial assistant message, which is
 *  exactly the one pi will replay back to the provider on the next request.
 *  Tool-call arguments are never touched (rewriting them would desync the
 *  model's view from the call that actually executed). Pure: returns the same
 *  array reference when nothing changed; idempotent; fail-safe (any error
 *  returns the input unchanged). Persisted history is never modified. */
export function collapseAssistantDegeneration(
  messages: AgentMessage[],
  cfg?: boolean | DegenerationGuardConfig,
): { messages: AgentMessage[]; evidence: CollapseEvidence[] } {
  const { enabled, minRun } = resolveDegenerationGuard(cfg);
  if (!enabled || messages.length === 0) return { messages, evidence: [] };
  try {
    const evidence: CollapseEvidence[] = [];
    let changed = false;
    const out = messages.slice();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as { role?: string; content?: unknown };
      if (msg.role !== "assistant") continue;
      const c = msg.content;
      if (typeof c === "string") {
        const runs = findDegenerateRuns(c, minRun);
        if (runs.length > 0) {
          out[i] = { ...(msg as object), content: applyRuns(c, runs, minRun) } as AgentMessage;
          evidence.push({ msgIndex: i, blocks: ["content"], runs });
          changed = true;
        }
        continue;
      }
      if (!Array.isArray(c)) continue;
      const blocks: string[] = [];
      const runs: DegenerateRun[] = [];
      let blockChanged = false;
      const nc = c.map((p) => {
        const b = p as { type?: string; text?: unknown; thinking?: unknown };
        if (b?.type === "text" && typeof b.text === "string") {
          const r = findDegenerateRuns(b.text, minRun);
          if (r.length > 0) {
            blockChanged = true;
            blocks.push("text");
            runs.push(...r);
            return { ...(b as object), text: applyRuns(b.text, r, minRun) };
          }
          return p;
        }
        if (b?.type === "thinking" && typeof b.thinking === "string") {
          const r = findDegenerateRuns(b.thinking, minRun);
          if (r.length > 0) {
            blockChanged = true;
            blocks.push("thinking");
            runs.push(...r);
            return { ...(b as object), thinking: applyRuns(b.thinking, r, minRun) };
          }
          return p;
        }
        return p;
      });
      if (blockChanged) {
        out[i] = { ...(msg as object), content: nc } as AgentMessage;
        evidence.push({ msgIndex: i, blocks, runs });
        changed = true;
      }
    }
    return { messages: changed ? out : messages, evidence };
  } catch {
    return { messages, evidence: [] };
  }
}

/** Scan backward for the LAST assistant message and collect its degenerate
 *  runs. Call it with the PERSISTED originals in session order (not the
 *  outgoing view): thinking-only aborted turns never reach the outgoing view
 *  (projectMessage drops them), yet they are still "the previous turn".
 *  Returns null when absent or clean. Gates the recovery notice: because the
 *  notice fires only while the degenerated message is the most recent
 *  assistant turn, it self-limits — once the model produces a new turn the
 *  old message is no longer last and the notice disappears on the next
 *  rebuild (no persistent state needed). */
export function lastAssistantRuns(messages: AgentMessage[], minRun: number): DegenerateRun[] | null {
  try {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { role?: string; content?: unknown };
      if (msg.role !== "assistant") continue;
      const runs: DegenerateRun[] = [];
      const c = msg.content;
      if (typeof c === "string") {
        runs.push(...findDegenerateRuns(c, minRun));
      } else if (Array.isArray(c)) {
        for (const p of c) {
          const b = p as { type?: string; text?: unknown; thinking?: unknown };
          if (b?.type === "text" && typeof b.text === "string") runs.push(...findDegenerateRuns(b.text, minRun));
          else if (b?.type === "thinking" && typeof b.thinking === "string") runs.push(...findDegenerateRuns(b.thinking, minRun));
        }
      }
      return runs.length > 0 ? runs : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** One-shot recovery notice appended while a degenerated assistant message is
 *  the most recent turn: tells the model the repeated segment carries no
 *  information and was truncated, and to resume from the last valid step
 *  instead of continuing the attractor. */
export function degenerationNotice(runs: DegenerateRun[]): AgentMessage {
  const sorted = [...runs].sort((a, b) => b.count - a.count);
  const top = sorted[0]!;
  const extra = sorted.length > 1 ? ` and ${sorted.length - 1} other repeated segment(s)` : "";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[ACP recovery notice] Your previous turn ended in degenerate generation: its output contained ${top.count} consecutive repetitions of ${describeChar(top.char)}${extra}. That repeated segment carries no information and has been truncated in the context above. Do not reproduce it or continue the pattern. Resume your task from your last valid step.`,
      },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
}
