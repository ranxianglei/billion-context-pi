// Machine-readable contract for ACP compression blocks (#368). Zero runtime deps;
// safe to import across process/restart boundaries. The sidecar is the source of
// truth — this module only pins the versioned, additive-only block shape.

export const SCHEMA_VERSION = 1 as const;

export const PRODUCER_NAME = "billion-context-pi";

export interface ProducerInfo {
  name: string;
  /** Semver of the billion-context-pi build that wrote the sidecar. Omitted when unknown (dev/test). */
  version?: string;
}

export interface SidecarEnvelope {
  schemaVersion: number;
  producer: ProducerInfo;
}

/** Build the top-level envelope written to every `<session>.acp.json`. */
export function createSidecarEnvelope(version?: string): SidecarEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    producer: { name: PRODUCER_NAME, ...(version ? { version } : {}) },
  };
}

/**
 * One compression block as persisted in a sidecar's `blocks[]` element.
 *
 * v1 stability contract: listed fields are guaranteed present with stable names
 * and semantics; evolution is additive-only (new optional fields may appear).
 * Renaming/removing/re-semanticking any field requires bumping `SCHEMA_VERSION`.
 * Fields not listed here are internal pruning/index details — not part of the
 * contract and may change freely.
 */
export interface BcpBlockV1 {
  /** Idempotency key. Stable across restarts; never reused. */
  blockId: string;
  /** The final accepted summary text. */
  summary: string;
  /** Compression tier (1 | 2 | 3). */
  tier: number;
  /** Tokens of original content compressed by this block. */
  compressedTokens: number;
  /** Creation time — epoch MILLISECONDS (not an ISO string). */
  createdAt: number;
  /** Short human label for the compressed range. */
  topic?: string;
  /** Model-facing start ref, e.g. "m00005". Absent when unknown. */
  startRef?: string;
  /** Model-facing end ref, e.g. "m00020". Absent when unknown. */
  endRef?: string;
  /** Raw message ids covered by this block (authoritative coverage set). */
  effectiveMessageIds?: string[];
}
