import type { StripProtocol } from "acp-kernel/wire";
import { stripHistoricalImages } from "acp-kernel/wire";

// Opt-in (default OFF) wire-level strip of historical image payloads
// (issue #321, kernel #215). Image bytes ride along verbatim on every request
// even after compression folds the surrounding text — the codecs move images
// out of CoreMessage.text into sidecars, so the raw payload is forwarded
// regardless of what got summarized. With compress.stripImages enabled, every
// message older than the most recent `compress.stripImagesKeepRecent` (default
// 5) has its image parts dropped in the outbound provider body; an image-only
// message collapses to a "[image]" text placeholder so message count / role
// ordering stay stable. The strip runs at pi's before_provider_request hook on
// the RAW parsed body, after codec serialization and before the HTTP call.

/** Map pi-ai's Api id to the kernel wire dialect. Only dialects the kernel
 *  strip primitive explicitly supports are mapped; everything else returns
 *  null (= no-op), so exotic or future APIs are never mangled. */
export function apiToStripProtocol(api: string | undefined): StripProtocol {
  switch (api) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-completions":
      return "openai";
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return "responses";
    default:
      return null;
  }
}

export interface StripImagesOutcome {
  /** Replacement body to send, or undefined when the payload is unchanged. */
  body?: unknown;
  /** Number of image parts removed (0 = untouched). */
  removed: number;
}

/** Strip historical images from a provider request body. Pure: returns
 *  { removed: 0 } (and NO body) when disabled, the protocol is unsupported,
 *  the body is not strip-shaped, or nothing is older than keepRecent. */
export function applyStripImages(
  body: unknown,
  api: string | undefined,
  settings: { enabled: boolean; keepRecent: number },
): StripImagesOutcome {
  if (!settings.enabled) return { removed: 0 };
  const protocol = apiToStripProtocol(api);
  if (!protocol) return { removed: 0 };
  const result = stripHistoricalImages(body, protocol, settings.keepRecent);
  if (result.removed === 0) return { removed: 0 };
  return { body: result.body, removed: result.removed };
}
