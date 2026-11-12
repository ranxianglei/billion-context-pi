import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];

// #477: pi 0.86 moved the active toolset onto the session system message —
// provider adapters derive the request `tools` parameter exclusively from
// system messages in the transcript (resolveTranscriptTools → toolsAdded /
// getCurrentTools). ACP rebuilds its outgoing view from persisted session
// entries, which never include the system message, so the rebuild dropped it
// and every request went out with zero tools. Carry the input's system
// messages back onto the rebuilt array:
//   - rebuilt has none  → prepend the input's, verbatim (every host field kept:
//     content, sections, toolsAdded, toolsRemoved, timestamp);
//   - rebuilt has some  → fill each missing host field on the k-th rebuilt
//     system message from the k-th input one, never overwriting existing values.
// Strict no-op (same reference returned) when the input carries no system
// message — hosts whose context array has none (pi < 0.86, OMP, fork hosts)
// see zero change, keeping those turns byte-for-byte identical.
function isSystem(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system";
}

export function carryHostSystemMessages(rebuilt: AgentMessage[], input: AgentMessage[]): AgentMessage[] {
  const inputSystems = input.filter(isSystem);
  if (inputSystems.length === 0) return rebuilt;

  const rebuiltSystems = rebuilt.filter(isSystem);
  if (rebuiltSystems.length === 0) return [...inputSystems, ...rebuilt];

  let changed = false;
  let sysIdx = 0;
  const patched = rebuilt.map((message) => {
    if (!isSystem(message)) return message;
    const source = inputSystems[sysIdx++];
    if (!source) return message;
    const out = message as unknown as Record<string, unknown>;
    const src = source as unknown as Record<string, unknown>;
    let next: Record<string, unknown> | null = null;
    for (const key of Object.keys(src)) {
      if (out[key] === undefined && src[key] !== undefined) {
        next ??= { ...out };
        next[key] = src[key];
      }
    }
    if (next !== null) {
      changed = true;
      return next as unknown as AgentMessage;
    }
    return message;
  });
  return changed ? patched : rebuilt;
}
