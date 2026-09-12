[English](./omp.md) | [中文](./omp.zh-CN.md)

# OMP (oh-my-pi) support

> **billion-context-pi does not support OMP.** If you run it on an OMP
> (`can1357/oh-my-pi`) host, the extension **refuses to run**: it prints a
> warning once, disables the ACP tools, and leaves the host's own context
> handling untouched. Use the [billion-context](https://github.com/ranxianglei/billion-context)
> proxy instead.

## Why OMP is not supported

billion-context-pi is an in-process adapter for the **Pi** coding agent
(`@earendil-works/pi-coding-agent`). It manages context by injecting invisible
message refs (`m00001`, `m00002`, …) into the live conversation and letting the
model drive `compress` / `decompress` / `search_context` against those refs.

OMP exposes a different in-process session API. The refs the extension injects
can drift out of sync with the session's real refs, so `compress` calls fail
with `does not exist in this session` and one-shot runs never succeed
([#234](https://github.com/ranxianglei/billion-context-pi/issues/234)). Keeping
that in-process integration reliable on OMP is not worth the maintenance cost,
so OMP is no longer an actively supported host for this plugin.

## What happens on an OMP host

At session start the extension feature-detects the host (Pi exposes
`sessionManager.buildContextEntries()`; OMP only exposes `getBranch()`). Any host without
that API stands down unless it declares itself a Pi-compatible fork via
`PI_ACP_FORK_HOST=1` (see [host-adapter.md](./host-adapter.md)) — the declaration exists
for forks whose `getBranch()` matches that contract, not for OMP, so OMP always stands down:

- warns **once per process** (UI notification in TUI/RPC; `console.error` to
  stderr in headless one-shot mode) pointing at the supported alternative,
- the four ACP tools (`compress`, `decompress`, `search_context`, `acp_status`)
  return the guidance message instead of acting,
- the ACP system-prompt injection is skipped,
- the `context` transform is a no-op (messages pass through untouched),
- the host's own auto-compaction is **not** cancelled.

Pi hosts are completely unaffected.

## The alternative: billion-context proxy

[billion-context](https://github.com/ranxianglei/billion-context) runs the same
compression pipeline **server-side in a proxy**. Because the proxy owns the ref
coordinate space, the refs never diverge — it works on OMP (and other hosts).

```bash
npm install -g billion-context
bili omp
```

`bili omp` starts a local proxy and launches OMP against it. See
[billion-context](https://github.com/ranxianglei/billion-context) for options.
