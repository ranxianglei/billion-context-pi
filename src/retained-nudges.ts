import { isBridgeForkApi } from "./async-compress.js";

// claude-bridge treats a nudge missing from the next request as a history rewrite
// and rebuilds its Claude Code session, so on that wire ACP re-sends its own
// non-emergency nudge after the message it followed until that message leaves the view.
export const retainsNudges = (api: unknown): boolean => isBridgeForkApi(api);

interface Retained<M> {
  anchorId: string;
  message: M;
  tokens: number;
}

export class RetainedNudges<M> {
  private readonly bySession = new Map<string, Retained<M>[]>();

  retain(sid: string, anchorId: string, message: M, tokens: number): void {
    const list = (this.bySession.get(sid) ?? []).filter((r) => r.anchorId !== anchorId);
    list.push({ anchorId, message, tokens });
    this.bySession.set(sid, list);
  }

  /** Drops nudges whose anchor is no longer sent; returns the tokens of the rest. */
  prune(sid: string, sentIds: ReadonlySet<string>): number {
    const list = this.bySession.get(sid);
    if (!list) return 0;
    const kept = list.filter((r) => sentIds.has(r.anchorId));
    if (kept.length > 0) this.bySession.set(sid, kept);
    else this.bySession.delete(sid);
    return this.tokens(sid);
  }

  tokens(sid: string): number {
    return (this.bySession.get(sid) ?? []).reduce((n, r) => n + r.tokens, 0);
  }

  /** `ids` runs parallel to `messages`; each nudge goes right after its anchor. */
  replay(sid: string, messages: M[], ids: readonly string[]): M[] {
    const list = this.bySession.get(sid);
    if (!list || list.length === 0 || ids.length !== messages.length) return messages;
    const byAnchor = new Map(list.map((r) => [r.anchorId, r.message]));
    const missing = new Set(byAnchor.keys());
    const out: M[] = [];
    messages.forEach((m, i) => {
      out.push(m);
      const nudge = byAnchor.get(ids[i]!);
      if (nudge && missing.delete(ids[i]!)) out.push(nudge);
    });
    if (missing.size > 0) this.bySession.set(sid, list.filter((r) => !missing.has(r.anchorId)));
    return out;
  }

  at(sid: string, anchorId: string): M | undefined {
    return this.bySession.get(sid)?.find((r) => r.anchorId === anchorId)?.message;
  }

  drop(sid: string, anchorId: string): void {
    const list = this.bySession.get(sid)?.filter((r) => r.anchorId !== anchorId);
    if (list && list.length > 0) this.bySession.set(sid, list);
    else this.bySession.delete(sid);
  }

  reset(sid: string): void {
    this.bySession.delete(sid);
  }
}
