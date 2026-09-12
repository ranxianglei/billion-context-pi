import * as piModule from "@earendil-works/pi-coding-agent";

type PiNamespace = { CONFIG_DIR_NAME?: unknown };

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
const PI_CONFIG_DIR_NAME: unknown = (piModule as unknown as PiNamespace).CONFIG_DIR_NAME;

export const CONFIG_DIR_NAME: string =
  typeof PI_CONFIG_DIR_NAME === "string" && PI_CONFIG_DIR_NAME.length > 0 ? PI_CONFIG_DIR_NAME : ".pi";
