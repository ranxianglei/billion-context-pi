import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { extractText } from "./messages.js";

type AgentMessage = SessionMessageEntry["message"];

// #477: pi 0.86 moved the active toolset onto the session system message —
// provider adapters derive the request `tools` parameter exclusively from
// system messages in the transcript (resolveTranscriptTools → toolsAdded /
// getCurrentTools). ACP rebuilds its outgoing view from persisted session
// entries, so host-owned state on system messages must be carried back onto
// the rebuilt array.
//
// #616: pi 1.0.x extends that with `sections` (a flat name→string record; a
// later message replaces a section by name, null removes it — replaying every
// system message in order yields the current prompt). The built-in MCP plugin
// appends a section-only patch message (empty content, only sections) mid-
// session to publish `<mcp_servers>`. Two ways the rebuild lost it:
//   1. section-only system messages project to zero core messages (empty text),
//      so they never reach the kernel and never come back through originalById;
//   2. a compression block covering a system message prunes it from the kernel
//      view.
// The old index-based pairing (k-th rebuilt vs k-th input) then misaligned as
// soon as counts diverged and silently dropped every unpaired input system —
// the MCP server list vanished from the model-visible prompt and its codemode
// tools became unusable. Now:
//   - identity pairing (timestamp + ref-tag-stripped text): under pi the
//     rebuilt systems are an order-preserving subsequence of the host's, so
//     equal keys pair greedily and inputs skipped in between are recognized as
//     dropped-by-rebuild;
//   - matched pairs deep-merge `sections` (live/host wins per key, explicit
//     null removes) and keep filling other missing host fields as before;
//   - every unpaired input system is carried back verbatim, inserted before
//     the next paired rebuilt system that follows it in host order (trailing
//     ones append at the end) — replay order among system messages is
//     preserved, which is all pi's provider adapters need.
// Zero identity matches → legacy positional pairing (#477 fill contract for
// hosts whose rebuilt systems diverge in value from the live view); excess
// input systems beyond the rebuilt count are carried back verbatim instead of
// dropped. Strict no-op (same reference returned) when the input carries no
// system message or nothing changed — hosts whose context array has none (pi
// < 0.86, OMP, fork hosts) see zero change, keeping those turns byte-for-byte
// identical.

function isSystem(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system";
}

/** Identity of a host system message across the persisted-entry view (rebuilt
 *  copy, possibly ref-tagged) and the live input view (pristine): timestamp +
 *  ref-tag-stripped text. */
function systemKey(m: AgentMessage): string {
  const msg = m as { timestamp?: unknown; content?: unknown };
  return `${typeof msg.timestamp === "number" ? msg.timestamp : ""}\u0000${extractText(msg.content ?? "")}`;
}

type Sections = Record<string, string | null>;

function sectionsOf(m: AgentMessage): Sections | undefined {
  const s = (m as { sections?: unknown }).sections;
  return typeof s === "object" && s !== null ? (s as Sections) : undefined;
}

function stableStringify(v: Sections): string {
  return JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
}

/** Deep-merge the live host's sections onto the rebuilt copy: live wins per
 *  key, explicit null removes. Returns null when nothing changed (keeps the
 *  rebuilt reference for byte-identical turns). */
function mergeSections(dst: AgentMessage, src: AgentMessage): AgentMessage | null {
  const live = sectionsOf(src);
  if (live === undefined) return null;
  const old = sectionsOf(dst);
  if (old !== undefined && stableStringify(old) === stableStringify(live)) return null;
  return { ...(dst as object), sections: { ...(old ?? {}), ...live } } as unknown as AgentMessage;
}

/** Fill each missing host field from src, never overwriting existing values
 *  (`sections` is handled by mergeSections). Returns null when nothing
 *  changed. */
function fillMissingFields(dst: AgentMessage, src: AgentMessage): AgentMessage | null {
  const out = dst as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const key of Object.keys(s)) {
    if (key === "sections") continue;
    if (out[key] === undefined && s[key] !== undefined) {
      next ??= { ...out };
      next[key] = s[key];
    }
  }
  return next === null ? null : (next as unknown as AgentMessage);
}

export function carryHostSystemMessages(rebuilt: AgentMessage[], input: AgentMessage[]): AgentMessage[] {
  const inputSystems = input.filter(isSystem);
  if (inputSystems.length === 0) return rebuilt;

  const rebuiltSystems = rebuilt.filter(isSystem);
  if (rebuiltSystems.length === 0) return [...inputSystems, ...rebuilt];

  // Pass 1 — identity pairing with forward scan (order-preserving).
  const identityPartner = new Map<number, number>(); // rebuilt ordinal -> input ordinal
  let i = 0;
  for (let j = 0; j < rebuiltSystems.length; j++) {
    let k = i;
    while (k < inputSystems.length && systemKey(inputSystems[k]!) !== systemKey(rebuiltSystems[j]!)) k++;
    if (k < inputSystems.length) {
      identityPartner.set(j, k);
      i = k + 1;
    }
  }

  // partner: rebuilt ordinal -> input ordinal (absorbed into that slot);
  // orphans: input ordinals dropped by the rebuild, carried back verbatim.
  let partner: Map<number, number>;
  let orphans: number[];
  if (identityPartner.size > 0) {
    partner = identityPartner;
    const consumed = new Set(identityPartner.values());
    orphans = inputSystems.map((_, k) => k).filter((k) => !consumed.has(k));
  } else {
    partner = new Map<number, number>();
    for (let j = 0; j < Math.min(rebuiltSystems.length, inputSystems.length); j++) partner.set(j, j);
    orphans = inputSystems.map((_, k) => k).slice(rebuiltSystems.length);
  }

  const out: AgentMessage[] = [];
  const pending: AgentMessage[] = [];
  let orphanPtr = 0;
  let changed = false;
  let sysOrdinal = 0;
  for (const message of rebuilt) {
    if (!isSystem(message)) {
      out.push(message);
      continue;
    }
    const p = partner.get(sysOrdinal++);
    if (p === undefined) {
      out.push(message);
      continue;
    }
    while (orphanPtr < orphans.length && orphans[orphanPtr]! < p) {
      pending.push(inputSystems[orphans[orphanPtr]!]!);
      orphanPtr++;
    }
    if (pending.length > 0) {
      out.push(...pending);
      pending.length = 0;
      changed = true;
    }
    const source = inputSystems[p]!;
    let carried = message;
    const merged = mergeSections(carried, source);
    if (merged !== null) carried = merged;
    const filled = fillMissingFields(carried, source);
    if (filled !== null) carried = filled;
    if (carried !== message) changed = true;
    out.push(carried);
  }
  while (orphanPtr < orphans.length) {
    out.push(inputSystems[orphans[orphanPtr]!]!);
    orphanPtr++;
    changed = true;
  }
  if (pending.length > 0) {
    out.push(...pending);
    changed = true;
  }
  return changed ? out : rebuilt;
}
