# billion-context-pi

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Billion-Context</strong> for <a href="https://pi.dev">Pi</a>
<br />
The model decides <em>when</em> and <em>what</em> to compress — not a hard limit.
</p>

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context-pi"><img src="https://img.shields.io/npm/v/billion-context-pi.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context-pi/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context-pi.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context-pi"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context--pi-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>pi install npm:billion-context-pi</code>
</p>

---

> **Host support:** this plugin is for **Pi**. It does **not** support **OMP (oh-my-pi)** — on an OMP host it refuses to run. OMP users: use [billion-context](https://github.com/ranxianglei/billion-context) instead (`bili omp`, built-in plugin). Full client → package table: see [Which do I need?](#which-do-i-need); OMP details: [docs/omp.md](./docs/omp.md).

## Why?

When conversations get long, the model runs out of context. Most tools hard-truncate — silently dropping earlier messages. **billion-context** gives the model a `compress` tool: the LLM decides **when** and **what** to compress into high-fidelity summaries, preserving critical details (file paths, decisions, error strings) while reclaiming context space.

Unlike Pi's built-in auto-compaction (which replaces everything with a single summary), billion-context:
- **Preserves structure** — compressed ranges become labeled blocks you can decompress later
- **Multi-tier** — summaries can be further distilled (T1 → T2 → T3) as sessions grow
- **Searchable** — `search_context` finds information inside compressed blocks without decompressing
- **Selective** — protected tools, user messages, and the recent working set are never compressed

This means:

1. **A single session handles enormous workloads.** Per simulation tests of the three-tier architecture (see [opencode-acp](https://github.com/ranxianglei/opencode-acp)), one session can process on the order of 10–60 billion cumulative tokens — while retaining long-term memory of distant key information (paths, decisions, signatures). You can work in the **same session for months** without outgrowing the context.
2. **Context stays lean over the long run.** In practice context typically holds under ~150K tokens (opencode-acp keeps it under ~200K), so compared to traditional compaction that lets context balloon toward 1M, **a single session costs roughly 5× less in tokens**.

## Which do I need?

Pick by your client:

| Client | Use |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) (in-process extension) |
| **opencode** | [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) (in-process extension) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili omp` (built-in plugin) |
| **everything else** | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili <client>` (launcher, preferred) or `/bili/` prefix |

> Why OMP can't use this in-process extension, and what happens if you try anyway: see [Host support](#host-support) and [docs/omp.md](./docs/omp.md).

## Install

```bash
pi install npm:billion-context-pi
```

That's it. The extension auto-loads on next Pi startup. No configuration needed — it reads your model's context window automatically.

> **Uninstall `pi-subagents` first (optional, recommended).** billion-context-pi ships its own `acp_delegate` sub-agent tool (see below) that replaces pi-subagents at a fraction of the context cost (~600 tok vs ~7K tok/turn). If you have pi-subagents installed, remove it to avoid duplicate delegation tools:
> ```bash
> pi remove npm:pi-subagents
> ```

## How it works

billion-context intercepts Pi's `context` event (fired before each LLM call) and runs an 8-stage pipeline:

```
assign refs → sync blocks → prune → filter → hide calls → recommend → nudge → emergency truncate
```

Each message gets an invisible `<acp>` ref tag (`m00001`, `m00002`, ...) visible to the model but not the user. The model uses these refs to specify compression ranges.

Pi's built-in auto-compaction is cancelled — billion-context is the sole context manager.

## Plugin compatibility & ordering

billion-context takes over context management by intercepting Pi's `context` event. **Pi has no plugin priority mechanism** — when multiple extensions register handlers for the same event, they run in a fixed sequence (load order), with no `priority`/`weight` field and no way for the user to control the order. The `context` event specifically is a *pipeline*: every handler receives the previous handler's output, there is no short-circuit, and the **last** handler has the final say over what reaches the model.

This has two practical implications:

1. **Keep exactly one context-compression plugin installed.** If you run two compression plugins together (e.g. billion-context-pi alongside another), both will rewrite the message list and clobber each other's work — compressed ranges can be re-expanded or corrupted. Pi's built-in auto-compaction is already cancelled automatically by billion-context-pi, but any *third-party* compression/compaction extension should be uninstalled.

2. **Even with a single compression plugin, interference is still possible in rare cases.** Load order under Pi is determined by filesystem discovery order (`fs.readdirSync` over `.pi/extensions/` → global → packages), which is not fully deterministic. If another (non-compression) extension also hooks the `context` event and happens to load *after* billion-context-pi, it could modify the compressed output. billion-context-pi rebuilds its working set from the session log rather than the chained input, which makes it robust to handlers that run *before* it — but it cannot defend against a handler that runs *after* it. This is a limitation of Pi's extension model; if you observe unexpected context behavior, check whether other installed extensions intercept the `context` event.

## Host support

billion-context-pi is built for the **Pi** coding agent (`@earendil-works/pi-coding-agent`) and detects the host at session start — the full client → package table lives in [Which do I need?](#which-do-i-need):

- **Pi** — fully supported.
- **OMP (`can1357/oh-my-pi`)** — **not supported.** OMP's in-process session API diverges from Pi's, so the compression refs the extension injects can drift out of sync with the session's real refs and `compress` calls fail with `does not exist in this session` (issue [#234](https://github.com/ranxianglei/billion-context-pi/issues/234)). On OMP the extension now **refuses service**: it prints a warning, disables the ACP tools, and leaves the host's own context handling untouched.

  **Use [billion-context](https://github.com/ranxianglei/billion-context) instead** — it runs the same compression pipeline server-side in a proxy, so the refs never diverge:

  ```bash
  npm install -g billion-context
  bili omp   # run OMP through the proxy
  ```

  Full details: [docs/omp.md](./docs/omp.md).

- **Coexisting with the [billion-context](https://github.com/ranxianglei/billion-context) wire proxy** — running both on the same session double-compresses every request (wasted tokens, nested summaries, two ref coordinate systems). This is prevented automatically: launcher paths (`bili pi`, …) export `BILLION_CONTEXT_PROXY`, and models whose `baseUrl` routes through the proxy (`…/bili/https://upstream…`) are detected at session start — in both cases billion-context-pi stands down with a warning and leaves the proxy as the sole compressor. One exception: transparent mode, where traffic reaches the proxy via `HTTPS_PROXY` so the URL carries no `/bili/` prefix — that is undetectable from the URL, so export `BILLION_CONTEXT_PROXY=1` before starting pi in that case.

## Model-facing tools

| Tool | What it does |
|------|-------------|
| `compress` | Replace a contiguous message range with a detailed summary |
| `decompress` | Restore a previously compressed block's content |
| `search_context` | Search compressed block summaries (and visible messages) by keyword |
| `acp_status` | Show context usage, compressed blocks, compressible ranges |
| `acp_delegate` | Spawn a clean-context sub-agent for a task (review / research / implement / plan / advise) |
| `acp_delegate_wait` | Block until a delegate run finishes (returns its result; times out otherwise) |
| `acp_delegate_cancel` | Cancel a running delegate by runId |

### acp_delegate — clean-context delegation

Hand a self-contained task to a fresh pi process running in a clean context. Five built-in roles, each with a system prompt and a **soft tool guardrail**:

| Role | Tools | Best for |
|------|-------|----------|
| `reviewer` | read, bash, grep, find, ls + ACP | Read-only code review (bugs, risks, file:line) |
| `researcher` | read, bash, grep, find, ls + ACP | Read-only codebase investigation |
| `worker` | read, edit, write, bash | Make code changes |
| `planner` | read, bash, grep, find, ls + ACP | Analyze + propose a step-by-step plan |
| `oracle` | read, bash, grep, find, ls + ACP | Answer questions / advise |

Read-only roles (reviewer, researcher, planner, oracle) receive a restricted tool allowlist (`read, bash, grep, find, ls`) plus ACP context tools (`compress, decompress, search_context, acp_status`) so they can manage their own context. This prevents accidental file modifications, but `bash` can bypass it - **it is a guardrail, not a security boundary**.

Worker runs on Pi's full default toolset - no `--tools` allowlist is applied, so any loaded extension or custom tools (e.g. ACP, LSP, MCP) remain available. This keeps primary-task delegation fully capable. The `read, edit, write, bash` listing above reflects core tools only.

The full delegate result is saved to a file (`/tmp/acp-delegate/<runId>.out`); the tool result and injected notification carry only the **task title + file path** (no preview) - use `read` for the details. This keeps the parent context lean.

- **Interactive (TUI) & RPC modes**: `async:true` (default) runs the child in the background; a short completion notification is injected into the chat when it finishes — **unless the model already read the result file after the run finished** (detected via the `read` tool or a bash command referencing the file), in which case the notification is skipped: the model already has the result, so re-injecting it would only waste context. Set `delegate: { notifyIfRead: "always" }` in `acp.json` to restore the always-inject behavior.
- **Print / JSON modes** (`pi -p`, SDK): `async:true` auto-downgrades to **synchronous** — the result returns as the tool result in the same turn (the parent exits after one turn, so background injection would be lost).
- **Failures are loud, never silent.** A run that fails (nonzero exit, spawn error, watchdog timeout) injects a `FAILED ⚠️` notification carrying a short error excerpt, so a failed delegate cannot hide among sibling completions. If a notification cannot be delivered at all, a recovery notice is attached to the next delegate notification or the next `acp_delegate` / `acp_delegate_wait` / `acp_delegate_cancel` tool result — a dispatched run's failure always reaches the model before it wraps up.

In the **interactive TUI**, async runs also show a live status widget below the editor (agent, elapsed seconds, task preview), so you always know what's running and for how long. Disabled automatically in RPC/print/JSON.

## `/acp` command

Rich status display for the user:

```
╭─────────────────────────────────────────────╮
│           ACP Context Analysis              │
╰─────────────────────────────────────────────╯
 billion-context-pi@0.1.14

Context: 12% (120K / 1.0M)
Growth: +15K since last nudge

Token Breakdown:
  System     ░░░░░░░░░░░░░░░░░░░░   2%  2.1K
  Tool       ████████████░░░░░░░░  58%  69.6K
  Summaries  ████░░░░░░░░░░░░░░░░  20%  24.0K
  Code       ██░░░░░░░░░░░░░░░░░░  10%  12.0K
  Text       █░░░░░░░░░░░░░░░░░░░   5%  6.0K

Blocks: 3 active (3.7K summary, 15.2K original compressed)
  b1 (T1)  3.7K→599  age=5m  "API exploration"
  b2 (T1)  8.2K→2.1K  age=2m  "Debug session"
  b3 (T2)  3.3K→1.0K  age=1m  "Architecture review"
```

## `/acp-subagents` command

**Optional, one-time setup — only if you also use [pi-subagents](https://github.com/nicobailon/pi-subagents).**

billion-context-pi's own `acp_delegate` tool works standalone. If you additionally keep pi-subagents installed and want its builtin sub-agents to have ACP context tools (`compress`/`decompress`/`search_context`/`acp_status`) for long-running tasks, run:

```
/acp-subagents
```

It discovers the agents and their tool baselines from the installed pi-subagents package and appends the four ACP tools to `subagents.agentOverrides` in `~/.pi/agent/settings.json` (safe write: backup + verify). Nothing is written automatically — this command is the only write path. Re-run it after upgrading pi-subagents. For git installs or forks, pass the package directory explicitly: `/acp-subagents <installDir>`.

## Configuration

billion-context-pi works out of the box with no configuration — it reads your model's context window automatically and applies sensible defaults.

Behavior is tuned via an optional `acp.json` config file (`~/.pi/acp.json` for global defaults, `<project>/.pi/acp.json` for per-project overrides) plus a few environment variables. For the complete reference — every key, type, default, and the precedence order — see **[CONFIGURATION.md](./CONFIGURATION.md)** ([中文](./CONFIGURATION.zh-CN.md)).

### Logging

billion-context-pi writes a structured, always-on log to `~/.pi/acp.log` (override with `ACP_LOG_FILE`). It covers the model's whole working session and is useful for diagnosing problems:

- **Always written** (even with `debug: false`): `error`, `warn`, `info` levels — session start, every context turn (token usage / nudge decision), compress/decompress, delegate spawn/done, and **all errors and warnings** (config/state/tool failures, delegate errors, guardrail caps, update failures). Error lines include the message and stack trace.
- **Written only when `debug: true`**: verbose `debug`-level diagnostics (full field dumps, per-turn internals).

Each line: `<ISO timestamp> [<level>] [<scope>] key=value key=value`. The file rotates to `~/.pi/acp.log.old` at 10 MB.

```sh
tail -f ~/.pi/acp.log                 # watch the session live
grep '\[error\]' ~/.pi/acp.log        # surface every recorded failure
```

### Compression philosophy

The model receives detailed guidance (in its system prompt) on **when** to compress, **what** to keep verbatim (paths, signatures, errors, decisions, user intent), and **what** to drop (verbose logs, duplicates, consumed exploration). This guidance is injected on every turn so it stays in the model's attention.

### What gets protected

billion-context protects three categories of content from compression:

1. **Always-protected tools** — `compress` calls are hard-protected (they're load-bearing metadata; compressing them breaks decompress and the "summary is historical" contract).
2. **Soft recent-zone** — the last N messages (default 5) and last ~5K tokens are soft-protected so the model keeps its working set. Tool results from `decompress`, `search_context`, `read`, and `bash` are **excluded** from this zone: they're large and meant to be compressible once consumed, so they don't eat the protected budget.
3. **Last user message** — always protected (user intent must survive).

## Session storage & migration

billion-context-pi persists each session's compression state in a **sidecar file** next to the session transcript. Every session lives as two files in Pi's sessions directory (`~/.pi/agent/sessions/`):

| File | Contents |
|------|----------|
| `<id>.jsonl` | The conversation transcript (messages, tool calls) |
| `<id>.jsonl.acp.json` | The ACP compression state (compressed blocks, message refs, nudge + stats) |

The `.acp.json` sidecar is what holds your compressed blocks. Without it, the session runs on its full raw history until ACP compresses again.

### Migrating a session (cross-machine copy / backup-restore)

Pi's built-in export/import moves only the **transcript**, not the ACP state. Two things are affected:

1. **The `.acp.json` sidecar is not carried.** As a fallback, ACP now **rebuilds the compression state by replaying the session log itself**: on the first context event after import, it re-applies every successful `compress` call recorded in the transcript (assistant tool-call arguments + tool results) through the kernel, restoring the block structure, summaries, message refs and cumulative stats, then persists the recreated sidecar (#299). Errored, no-op and unparseable calls are skipped; the replay runs only when no sidecar and no inheritable parent state exists. This removes the old behavior — resending the entire raw history until the nudge re-compresses, with a one-time full re-cache cost and context bloat back to original size. Caveat: the replay restores what the *log* records, so summaries come back exactly as stored in the transcript, and stats like per-message token snapshots are re-derived rather than bit-identical.
2. **Export drops the `parentSession` header.** Clone/fork child sessions rely on that header field to inherit their parent's compression state; once exported, the link is gone even if the parent's files still exist on the target machine. (A host-side fix is proposed upstream in [pi#1](https://github.com/ranxianglei/pi/pull/1).)

**To migrate a session with its compression state intact, copy both files together** (they share the same base name):

```bash
# copy the pair
cp <id>.jsonl <id>.jsonl.acp.json  <dest>/
# ... or back up / restore the whole directory
cp -r ~/.pi/agent/sessions  <backup>/pi-sessions
```

Restore them next to each other on the target machine. For clone/fork children, also bring the parent's pair so `parentSession` resolves.

> If you import only the `.jsonl`, ACP's log-replay fallback rebuilds the state automatically on the next session (see above). Copying the pair is still preferred — it is exact, while the replay re-derives token snapshots and can only restore what the transcript records.

## Built on acp-kernel

The compression engine is [`acp-kernel`](https://github.com/ranxianglei/acp-kernel) — a platform-agnostic, MIT-licensed library with 208 tests. It's bundled inline into `dist/index.js`, so there are zero runtime dependencies.

## License

MIT.
