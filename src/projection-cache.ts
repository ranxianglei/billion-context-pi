import type { CoreMessage } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { entriesToCoreMessages } from "./messages.js";

// Issue #561: entriesToCoreMessages re-projected the whole session on every
// context event even though pi-host sessions are append-only with stable
// entry ids. Cache the projected prefix; verify it by (entryCount, lastEntryId)
// and project only the appended tail. The kernel pipeline treats input
// messages as read-only (filter node rebuilds objects instead of mutating),
// so sharing cached elements across turns is safe.

/** Beyond this many entries the cached prefix would pin a large share of the
 *  session's text in memory permanently — fall back to full projection. */
export const PROJECTION_CACHE_MAX_ENTRIES = 50_000;

export class EntryProjectionCache {
  private maxEntries: number;
  private count = 0;
  private lastId = "";
  private prefix: CoreMessage[] = [];

  constructor(maxEntries: number = PROJECTION_CACHE_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.count;
  }

  project(entries: SessionEntry[]): { coreMessages: CoreMessage[]; hit: boolean } {
    if (entries.length > this.maxEntries) {
      this.reset();
      return { coreMessages: entriesToCoreMessages(entries), hit: false };
    }
    if (this.count > 0 && entries.length >= this.count && entries[this.count - 1]?.id === this.lastId) {
      const tail = entriesToCoreMessages(entries.slice(this.count));
      const coreMessages = tail.length > 0 ? [...this.prefix, ...tail] : this.prefix;
      return { coreMessages, hit: true };
    }
    const coreMessages = entriesToCoreMessages(entries);
    this.count = entries.length;
    this.lastId = entries[entries.length - 1]?.id ?? "";
    this.prefix = coreMessages;
    return { coreMessages, hit: false };
  }

  reset(): void {
    this.count = 0;
    this.lastId = "";
    this.prefix = [];
  }
}
