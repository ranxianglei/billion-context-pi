import { promises as fs } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { logWarn } from "./log.js";
import { messageIdentity } from "./messages.js";
import { parseLiveRefOrigins, readParentSessionPath, STATE_SUFFIX } from "./state.js";

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

/** Read-only content recovery for content-addressed `live-*` refs (issue
 *  #579): fork hosts alias not-yet-persisted tail messages with `live-*` ids
 *  (runtime.ts mergeLiveEntries); those aliases appear in NO jsonl, so the
 *  entry-id lookup above can never find them. The rawId→identity bridge lives
 *  in each session's OWN sidecar (liveRefOrigins). Walks the chain — itself
 *  first, then ancestors, same depth/cycle rules as loadAncestorEntries — and
 *  at each level pairs that level's declared origins with that same level's
 *  log entries matched by messageIdentity. First matching entry wins per rawId
 *  (identical identities are interchangeable: identity covers full normalized
 *  content). Never writes any sidecar. */
export async function loadLiveRefEntries(
  sessionFile: string | undefined,
  wantedRawIds: Set<string>,
): Promise<Map<string, SessionEntry>> {
  const wanted = new Set([...wantedRawIds].filter((id) => id.startsWith("live-")));
  const found = new Map<string, SessionEntry>();
  if (!sessionFile || wanted.size === 0) return found;
  const seen = new Set<string>([sessionFile]);
  let current: string | undefined = sessionFile;
  for (let depth = 0; current !== undefined && depth <= MAX_CHAIN_DEPTH && found.size < wanted.size; depth++) {
    const file = current;
    const identities = new Map<string, string[]>();
    try {
      const raw = await fs.readFile(`${file}${STATE_SUFFIX}`, "utf8");
      const parsed = JSON.parse(raw) as { liveRefOrigins?: unknown };
      for (const origin of parseLiveRefOrigins(parsed.liveRefOrigins)) {
        if (!wanted.has(origin.rawId)) continue;
        const list = identities.get(origin.identity);
        if (list) list.push(origin.rawId);
        else identities.set(origin.identity, [origin.rawId]);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") logWarn("session-log", { event: "live-ref-sidecar-failed", file, error: e instanceof Error ? e.message : String(e) });
    }
    if (identities.size > 0) {
      let text: string | undefined;
      try {
        text = await fs.readFile(file, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") logWarn("session-log", { event: "live-ref-log-failed", file, error: e instanceof Error ? e.message : String(e) });
      }
      if (text !== undefined) {
        for (const entry of parseSessionLog(text)) {
          if (entry.type !== "message") continue;
          const rawIds = identities.get(messageIdentity(entry.message));
          if (!rawIds) continue;
          for (const rawId of rawIds) if (!found.has(rawId)) found.set(rawId, entry);
        }
      }
    }
    const parent = await readParentSessionPath(file);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return found;
}
