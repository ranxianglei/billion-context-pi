// Independent stop-signal injected as a user-role message once a compress loop
// is confirmed within the current user turn (COMPRESS_LOOP_CORRECT_THRESHOLD+
// failed/no-op compress calls without progress). It is appended per context event
// and NOT persisted to the session log, so it self-clears when the turn changes.
// The #308/#6/#250 breakers stop the TOOL from doing damage but cannot stop the
// MODEL from generating another ~10K-token repetitive compress turn; only an
// input-side counter-signal breaks the semantic attractor (issue #330). Follows
// the provider-throttle sentinel pattern (throttle-retry.ts) so system-prompt.ts
// documents how to interpret it.
export const COMPRESS_LOOP_SENTINEL = "[ACP:compress-loop]";

export const COMPRESS_LOOP_CORRECT_THRESHOLD = 2;

export function buildCompressLoopText(failures: number): string {
  return `${COMPRESS_LOOP_SENTINEL} You have issued ${failures} compress calls this turn without making progress (identical or already-compressed ranges). STOP calling compress now. Continue your actual task using the context you already have — compression is paused until your next user request.`;
}
