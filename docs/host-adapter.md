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
3. Host-injected `custom_message` entries start a turn **only when the policy opts in**,
   and only if they carry non-empty text (the same `extractText` gate projection uses).
   Empty injections are pure control signals: they never enter LLM context, so they
   start no turn either. UI-only `acp-status` panels (the `/acp` slash-command output)
   are excluded even under the opt-in.
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

Both surfaces are exported from the **package entrypoint** (`import ... from "billion-context-pi"`);
no subpath imports and no access to the extension factory's internal instance:

1. **Pure transformation** — `deriveChildState(parentState)`:
   `CompressionState → CompressionState`. For hosts that manage state objects themselves.
2. **Orchestrated** — `createRuntime(adapter)` returns an `AcpRuntime`; call
   `runtime.deriveChildState(childRef, parentRef) → Promise<boolean>` on it, where a ref is
   `{ sessionId: string; sessionFile?: string }` (`SessionRef`). It loads the parent state,
   applies the pure transformation, writes the one-time marker, and persists to the child
   sidecar. Because it operates on on-disk sidecars through session refs (no live contexts
   needed), it works even when the two sessions belong to different runtime instances —
   including the extension's own private instance. Pass the same `AdapterConfig` you would
   give `createAcpExtension` (an empty object suffices for derivation alone).

Host-side usage (once, before the child's first context event):

```ts
import { createRuntime } from "billion-context-pi";

const runtime = createRuntime(adapter); // same AdapterConfig as createAcpExtension; {} also works
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

---

## 3. Supported-host detection & entry sources

### Detection order (at `session_start`)

1. **Pi** — `sessionManager.buildContextEntries()` exists → fully supported, native path.
2. **Declared Pi-compatible fork** — no `buildContextEntries()`, but the process declared
   itself via the environment variable `PI_ACP_FORK_HOST=1` (or `true`) → supported, with
   the entry-source semantics below.
3. **Everything else** — refused: one warning per process (UI notification, or stderr in
   headless one-shot mode), all four ACP tools return guidance instead of acting, system-prompt
   injection is skipped, the context transform is a no-op, and the host's own compaction is
   not cancelled. OMP (oh-my-pi) falls here by default — see [omp.md](./omp.md).

### Why shape alone cannot decide

OMP and Prime are both **Pi forks**, and both expose only `getBranch()` (no
`buildContextEntries()`). The SessionManager shape therefore cannot distinguish an
unsupported host from a supported one — which is why step 2 is an explicit declaration
rather than a fingerprint list. Setting `PI_ACP_FORK_HOST` is the operator's assertion that
their build's `getBranch()` entry source matches the contract below. Do not stub
`buildContextEntries` with an empty array just to pass the gate: that would silently disable
the live-message merge and reintroduce the branch-lag bug.

### Entry-source semantics

| Host | Entry source | Live-message merge | Delegate CLI flags |
|---|---|---|---|
| Pi | `buildContextEntries()` — the effective context, always current including the in-flight message | not needed | pi flags (`--mode json`, `--session`) |
| Declared fork (Prime…) | `getBranch()` — raw branch chronology, **lags one message** (the current user message persists only after transform) | adapter merges each context event's `event.messages` into state building (`runtime.stateFor` live merge) | disabled — spawned children get no pi-only flags |

Consequences for hosts:

- Under a declared fork, refs injected during turn N become visible to branch reads from
  turn N+1 onward; the live merge compensates for exactly this lag. This merge fires for
  *any* non-Pi-shaped session manager (`!isPiHost`), which is what makes declared forks work.
- Delegation (`acp_delegate`) spawns real pi CLI processes. On non-Pi hosts the delegate
  tool refuses to spawn with pi-only flags, regardless of the declaration. Hosts that run
  sub-agents natively (e.g. Prime RLM) should set `"delegate": false` in acp.json so the
  model is not offered a tool whose children cannot run.

Fixtures: `tests/host-detection.test.ts` (Prime-shaped host = `{ getBranch }` only) and
`tests/omp-refuse.test.ts` (refusal behavior + the opt-in test).

---

## 4. Config directory (CONFIG_DIR_NAME)

The extension resolves its config directory from the host's export of `CONFIG_DIR_NAME`
(Pi exports `.pi`). A host that aliases `@earendil-works/pi-coding-agent` to its own build
must either:

1. **re-export `CONFIG_DIR_NAME`** (preferred — keeps paths exact if the fork renames its
   directory), or
2. accept the fallback: the adapter feature-detects a missing or invalid export and falls
   back to Pi's canonical value `.pi` (`src/config-dir.ts`).

Responsibility boundary: the *export* belongs to the host (only it knows its own directory
name); the *fallback* belongs to the adapter (it must not crash at load time because of a
missing named export). A missing export fails differently per resolver — plain Node
ESM→CJS interop throws a link-time `SyntaxError: Named export 'CONFIG_DIR_NAME' not found`,
while loader-based aliasing (Prime's loader) surfaces it as `undefined` at runtime, which
previously broke `path.join()` outright. The adapter therefore imports the pi package as a
**namespace** in `src/config-dir.ts` (safe under both resolvers) and feature-detects the
property; it is the only value import from the pi package — every other import is type-only
and erased at build time. All config/log/session paths flow through the single constant
there.
