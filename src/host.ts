import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPiHost } from "./runtime.js";

/** Which session-entry source API the host exposes (same precedence as readContextEntries). */
export type EntrySourceKind = "buildContextEntries" | "getBranch";

type SessionEntrySource = {
  buildContextEntries?: unknown;
  getBranch?: unknown;
};

export function entrySourceOf(sm: ExtensionContext["sessionManager"]): EntrySourceKind | null {
  const source = sm as unknown as SessionEntrySource | null | undefined;
  if (!source) return null;
  if (typeof source.buildContextEntries === "function") return "buildContextEntries";
  if (typeof source.getBranch === "function") return "getBranch";
  return null;
}

/** The host class a `PI_ACP_FORK_HOST` declaration names.
 *  - `generic`: the operator asserted an anonymous Pi-compatible fork (`=1`/`=true`).
 *  - `pi-desktop`: PI-Desktop specifically (#635) — admitted through the SAME fork path
 *    (never treated as pi-native) but surfaced with host-specific guidance. */
export type ForkHostClass = "generic" | "pi-desktop";

export interface ForkHostDeclaration {
  declared: boolean;
  /** Which class the declaration names; null when nothing was declared. */
  hostClass: ForkHostClass | null;
}

const PI_DESKTOP_VALUE = "pi-desktop";

/**
 * Parse the `PI_ACP_FORK_HOST` declaration (read at call time so hosts can set it
 * per-launch). See docs/host-adapter.md → "Supported-host detection".
 *
 * The SessionManager shape alone cannot distinguish e.g. Prime from OMP from
 * PI-Desktop — all are Pi forks exposing `getBranch()` but not
 * `buildContextEntries()` — so an unsupported shape requires an explicit
 * declaration before the adapter runs. Accepted values are strict:
 *   - `1` / `true` (case-insensitive) → a generic Pi-compatible fork;
 *   - `pi-desktop` (case-insensitive) → PI-Desktop (#635).
 * Anything else — empty, `0`, `yes`, or an unknown host name — is NOT a
 * declaration, so unrecognized hosts stay refused rather than silently admitted.
 */
export function forkHostDeclaration(): ForkHostDeclaration {
  const raw = process.env.PI_ACP_FORK_HOST;
  if (!raw) return { declared: false, hostClass: null };
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return { declared: true, hostClass: "generic" };
  if (v === PI_DESKTOP_VALUE) return { declared: true, hostClass: "pi-desktop" };
  return { declared: false, hostClass: null };
}

/** Whether the host declared itself a Pi-compatible fork via environment. */
export function isDeclaredForkHost(): boolean {
  return forkHostDeclaration().declared;
}

/** Unsupported host: not Pi-shaped and not declared as a fork. OMP stays blocked by default. */
export function isUnsupportedHost(sm: ExtensionContext["sessionManager"]): boolean {
  return !isPiHost(sm) && !isDeclaredForkHost();
}
