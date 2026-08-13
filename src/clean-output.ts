/**
 * Tool-output cleaning — dedupe + noise reduction for bash results.
 *
 * Pure functions, zero deps (kept separate from the guardrail wiring so the
 * logic can be tested in isolation and, if ever needed, lifted into its own
 * extension without dragging the ACP runtime along).
 *
 * Safety rules (validated against real outputs, see session notes):
 *  - Only lines that are NOT indented and NOT code-anchored are deduped.
 *    Indented lines are code/structure — never touched. This makes the
 *    dedupe immune to source-code reads (real-world error rate ~0).
 *  - A line is code-anchored when it starts with `{});` or ends with `{};`.
 *    npm-style warnings (`... (preinstall: ...)`) end with `)` and survive.
 *  - Repetition is counted globally (≥2), not only consecutive — npm's
 *    allow-scripts block repeats in alternating order, which a uniq-style
 *    consecutive check would miss entirely.
 *  - \r residues (progress-bar frames) are cut back to the last frame.
 *  - Runs of ≥2 blank lines collapse to one.
 */

/** Split on \n, preserve trailing newline flag separately. */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline && lines[lines.length - 1] === "") lines.pop();
  return { lines, trailingNewline };
}

/** True when the line is code-shaped: indented, or a syntax anchor. */
function isCodeLine(line: string): boolean {
  if (line.length === 0) return true;
  if (/^[ \t]/.test(line)) return true;
  if (/^[{});]/.test(line)) return true;
  if (/[{};]$/.test(line)) return true;
  return false;
}

/** Cut \r frames back to the final visible state of the line. */
function stripCarriageReturns(line: string): string {
  const idx = line.lastIndexOf("\r");
  return idx >= 0 ? line.slice(idx + 1) : line;
}

/**
 * Dedupe repeated non-code lines across the whole output.
 * First occurrence survives (tagged `(×N)`), later occurrences are dropped.
 * Order of remaining lines is preserved.
 */
function dedupeLines(lines: string[]): string[] {
  const seen = new Map<string, number>();
  const outIdx = new Map<string, number>();
  const out: string[] = [];

  for (const raw of lines) {
    const line = stripCarriageReturns(raw);
    if (line.trim() === "" || isCodeLine(line)) {
      out.push(line);
      continue;
    }

    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);

    if (n === 1) {
      out.push(line);
      outIdx.set(line, out.length - 1);
    } else {
      const idx = outIdx.get(line)!;
      out[idx] = `${line} (×${n})`;
    }
  }

  return out;
}

/** Collapse runs of ≥2 blank lines into a single blank line. */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const blank = line.trim() === "";
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out;
}

export function cleanToolText(text: string): string {
  if (!text) return text;
  const { lines, trailingNewline } = splitLines(text);
  if (lines.length === 0) return text;

  const deduped = dedupeLines(lines);
  const collapsed = collapseBlankRuns(deduped);
  const joined = collapsed.join("\n");

  return trailingNewline ? joined + "\n" : joined;
}

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

type ContentPart = ToolResultEvent["content"][number];

export function cleanToolContent(content: ContentPart[]): ContentPart[] | undefined {
  let changed = false;
  const out: ContentPart[] = [];
  for (const c of content) {
    if (c.type !== "text") {
      out.push(c);
      continue;
    }
    const raw = (c as { text: string }).text;
    const cleaned = cleanToolText(raw);
    if (cleaned !== raw) {
      changed = true;
      out.push({ ...c, text: cleaned } as ContentPart);
    } else {
      out.push(c);
    }
  }
  return changed ? out : undefined;
}
