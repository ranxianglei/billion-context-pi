import { tmpdir } from "node:os";
import { join } from "node:path";

// Test temp paths must derive from os.tmpdir() (honors $TMPDIR), never a
// hardcoded /tmp — sandboxes may mount /tmp read-only (#545).
export function tmpPath(...parts: string[]): string {
  return join(tmpdir(), ...parts);
}
