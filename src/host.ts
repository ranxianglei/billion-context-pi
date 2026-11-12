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

/**
 * Whether the host declared itself a Pi-compatible fork via environment.
 *
 * The SessionManager shape alone cannot distinguish e.g. Prime from OMP — both are
 * Pi forks exposing `getBranch()` but not `buildContextEntries()` — so an
 * unsupported shape requires an explicit declaration before the adapter runs.
 * Read at call time so hosts can set it per-launch. See docs/host-adapter.md.
 */
export function isDeclaredForkHost(): boolean {
  const v = process.env.PI_ACP_FORK_HOST;
  return v === "1" || v?.toLowerCase() === "true";
}

/** Unsupported host: not Pi-shaped and not declared as a fork. OMP stays blocked by default. */
export function isUnsupportedHost(sm: ExtensionContext["sessionManager"]): boolean {
  return !isPiHost(sm) && !isDeclaredForkHost();
}
