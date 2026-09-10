# Host Adapter Contract — Multi-Session Hosts

Audience: hosts that embed Pi **in-process** and run several sessions concurrently in one
process (e.g. Prime with inline RLM sub/sibling sessions). Single-session users of Pi need
nothing from this document — every contract here defaults to Pi-native behavior.

Issue: [ranxianglei/billion-context-pi#364](https://github.com/ranxianglei/billion-context-pi/issues/364)
(leftover seams 1 + 2 of the #317 Prime integration report; ledger isolation itself was fixed by #327).

---

## 1. Turn-boundary policy

### The single predicate

"Which entry starts a new turn?" is decided in exactly one place —
`isTurnBoundary(entry, policy)` in `src/turn-boundary.ts`. All three former call sites go
through it (and through its two scan helpers `lastTurnBoundaryId` / `lastTurnBoundaryIndex`):

| Former site | Used for |
|---|---|
| per-turn token estimation key (`src/tokens.ts`) | per-turn token bookkeeping |
| context transform (`src/index.ts`) | `turnKey` for nudge-shown ledgers + compress-outcome scoping |
| compress tool (`src/compress-tool.ts`) | retry-cap key (`MAX_COMPRESS_ATTEMPTS = 3` per turn) |

The context-entry projection in `src/messages.ts` shares the same building block
(`isCustomMessageEntry`) so "what enters LLM context" and "what counts as a host-injected
message" can never drift apart again.

### Rules

1. A genuine **user-role message always starts a turn** (Pi-native; unaffected by policy).
2. Assistant / toolResult / compaction / branch-summary entries never start a turn.
3. Host-injected `custom_message` entries start a turn **only when the policy opts in**.
   UI-only `acp-status` panels (the `/acp` slash-command output) are excluded even under
   the opt-in — they never enter LLM context either.
4. LLM-context projection is **independent of this policy**: `custom_message` entries were
   and remain projected as user-role messages (Pi-native semantics). The policy only changes
   *turn accounting*, not what the model sees.

### Enabling the policy

```json
{ "hostSession": true }
```
or equivalently
```json
{ "hostSession": { "countCustomMessages": true } }
```
in `~/.pi/acp.json` / `<project>/.pi/acp.json`, or programmatically on the adapter config
passed to `createAcpExtension(adapter)`. Invalid values warn and fall back to off; they
never fail a session.

**Default-off guarantee:** with no `hostSession` key the predicate reduces to the exact
pre-#364 rule (user-role only). This is pinned by unit tests that compare against the
legacy scan verbatim — existing single-session users' nudge cadence is byte-for-byte
unchanged.

**Who should enable it:** inline multi-session hosts whose agent turns arrive as injected
`custom_message` entries. Without it, N real host turns collapse into one `turnKey`, so
nudge cells misalign, the per-turn compress retry cap spans multiple real turns, and
throttle/overflow cycle statistics distort.

---

## 2. Child-session state derivation (`deriveChildState`)

### Two kinds of child sessions — different rules

| Kind | How pi tracks it | Adapter behavior |
|---|---|---|
| **Separate-process delegate** (Pi-native sub-agents) | child session file's JSONL header carries `parentSession` | On load, the adapter inherits the parent's state **verbatim** (blocks *and* rhythm). **Unchanged by #364.** Do NOT call `deriveChildState` for these. |
| **Inline same-process child** (Prime RLM & co.) | whatever the host creates; may or may not carry a header | Fresh state by default. Call `deriveChildState` once to inherit blocks with reset rhythm. |

Why derive at all for inline children? If the child starts empty, `decompress` and
`search_context` cannot find any block the parent already created — yet the model sees
parent-created refs in inherited context. Deriving fixes retrieval without copying the
parent's pacing clocks.

### The contract

Inherited (child can decompress/search everything the parent could):

| Field | Semantics |
|---|---|
| `blocks` | deep-copied (blocks carry mutable fields — the copy must not alias the parent) |
| `messageRefs` (`byRaw` / `byRef`) | copied |
| `tokenSnapshot` (original-message index) | copied |
| `nextBlockId` / `nextRunId` | **carried over** — resetting them would make new child block ids collide with inherited ones |

Reset (the child starts its own clock):

| Ledger | Where it lives |
|---|---|
| nudge cadence (`baselineTokens`, `lastShownByTier`, anchors, per-message stamps) | persisted state `nudge` |
| stats counters (`tokensCompressed`, `compressionCount`, absorbed tokens) | persisted state `stats` |
| absorb records | persisted state `absorbed` (records reference parent-log toolCallIds absent from the child log) |
| nudge-shown turns, compress-failure tracking, throttle episodes, overflow episodes, token-scale trackers | runtime maps keyed by session id — never copied across sessions |

### API surfaces

1. **Pure transformation** — `deriveChildState(parentState)` exported from `src/state.js`:
   `CompressionState → CompressionState`. For hosts that manage state objects themselves.
2. **Orchestrated** — `runtime.deriveChildState(childRef, parentRef) → Promise<boolean>` on
   the extension runtime, where a ref is `{ sessionId: string; sessionFile?: string }`.
   It loads the parent state, applies the pure transformation, writes the one-time marker,
   and persists to the child sidecar. Because it operates on on-disk sidecars through
   session refs (no live contexts needed), it works even when the two sessions belong to
   different runtime instances.

Host-side usage (once, before the child's first context event):

```ts
await runtime.deriveChildState(
  { sessionId: childSm.getSessionId(), sessionFile: childSm.getSessionFile() ?? undefined },
  { sessionId: parentSm.getSessionId(), sessionFile: parentSm.getSessionFile() ?? undefined },
);
```

### Guards (all return `false`, change nothing)

- **One-time marker**: the derived sidecar persists `derivedFrom: { parentSessionId, derivedAt }`.
  Any later call (same or new process) refuses — re-derivation would clobber blocks the
  child created in the meantime.
- **Child owns real blocks**: if the child sidecar already contains non-derived blocks,
  derivation refuses — self-compressed history is never overwritten.
- **Parent has no blocks**: nothing to inherit.
- **File-less child**: in-memory sessions have no sidecar to persist the derivation into.
- **Explicit beats implicit**: if the child's JSONL header declares `parentSession`, plain
  loads auto-inherit the parent verbatim (old behavior). An explicit `deriveChildState`
  call upgrades that implicit state to inherit-blocks/reset-rhythm exactly once.

### Persistence

The child keeps its own independent sidecar — `~/.pi/agent/sessions/<child-session-file>.acp.json`
— written atomically like every other sidecar. The parent file is never touched. Subsequent
loads of the child read the derived sidecar normally (marker included); no further action
required.
