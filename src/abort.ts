// #494: pi passes the turn's AbortSignal into every tool execute() (3rd arg);
// Esc aborts it mid-run. Checkpoints stop multi-phase handlers at the next
// phase boundary instead of letting them run (and persist) after the abort.
// Sync kernel phases between checkpoints are ms-scale: worst-case overrun is one.
export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  throw err;
}
