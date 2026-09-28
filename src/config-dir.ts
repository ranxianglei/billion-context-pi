import * as path from "node:path";
import { homedir } from "node:os";
import * as piModule from "@earendil-works/pi-coding-agent";

type PiNamespace = { CONFIG_DIR_NAME?: unknown; getAgentDir?: unknown };

/**
 * Config directory name with a host feature-detection fallback (#364).
 *
 * Pi exports CONFIG_DIR_NAME (".pi"). Hosts that alias the pi package to their own build
 * (e.g. Prime) may not re-export it. A static named import of it fails differently per
 * resolver — link-time SyntaxError under plain Node ESM→CJS interop, or `undefined` at
 * runtime (which then breaks `path.join()`) under loader-based aliasing — so this module
 * uses a namespace import (safe in both cases) and falls back to Pi's canonical ".pi"
 * when the export is absent or not a non-empty string. It is the ONLY value import from
 * the pi package; everything else is type-only.
 * Contract & responsibility boundary: docs/host-adapter.md → "Config directory".
 */
const PI = piModule as unknown as PiNamespace;

export const CONFIG_DIR_NAME: string =
  typeof PI.CONFIG_DIR_NAME === "string" && PI.CONFIG_DIR_NAME.length > 0 ? PI.CONFIG_DIR_NAME : ".pi";

/**
 * Agent dir (e.g. ~/.pi/agent) with a host feature-detection fallback.
 *
 * Pi's getAgentDir() honors the host's agent-dir env override (<APP>_CODING_AGENT_DIR)
 * and defaults to <home>/<CONFIG_DIR_NAME>/agent. Aliased hosts that do not re-export
 * it would break a static named import exactly like the missing CONFIG_DIR_NAME did in
 * #364, so we feature-detect through the same namespace import and fall back to Pi's
 * default path shape. On such hosts the env override does not apply to this path
 * (documented limitation; all real hosts running pi's code export it).
 */
export function getAgentDir(): string {
  const fn = PI.getAgentDir;
  if (typeof fn === "function") return (fn as () => string)();
  return path.join(homedir(), CONFIG_DIR_NAME, "agent");
}
