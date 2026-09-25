import { promises as fs } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { logWarn } from "./log.js";
import { readParentSessionPath } from "./state.js";

const MAX_CHAIN_DEPTH = 8;

/** Parse a session jsonl into entries — mirrors pi's own loadEntriesFromFile
 *  (JSON.parse per line; blank and malformed lines skipped). */
export function parseSessionLog(text: string): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionEntry);
    } catch {}
  }
  return out;
}

/** Read-only lookup of entries in ANCESTOR sessions (issue #531): a derived
 *  child session (Prime RLM inline) inherits blocks whose message ids exist
 *  only in the parent's session log, so decompress must fall back up the
 *  parentSession header chain. Walks upward from `sessionFile` (nearest
 *  ancestor first), cycle-safe and depth-capped like state inheritance, and
 *  returns entries whose base id is in `wantedBaseIds`. The starting session
 *  itself is never included; nearest-ancestor entries win on duplicate ids. */
export async function loadAncestorEntries(
  sessionFile: string | undefined,
  wantedBaseIds: Set<string>,
): Promise<SessionEntry[]> {
  if (!sessionFile || wantedBaseIds.size === 0) return [];
  const found = new Map<string, SessionEntry>();
  const seen = new Set<string>([sessionFile]);
  let current = sessionFile;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const parent = await readParentSessionPath(current);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    let text: string;
    try {
      text = await fs.readFile(parent, "utf8");
    } catch {
      logWarn("session-log", { event: "ancestor-read-failed", file: parent, depth });
      break;
    }
    for (const entry of parseSessionLog(text)) {
      const id = entry.id;
      if (typeof id === "string" && wantedBaseIds.has(id) && !found.has(id)) found.set(id, entry);
    }
    if ([...wantedBaseIds].every((id) => found.has(id))) break;
    current = parent;
  }
  return [...found.values()];
}
