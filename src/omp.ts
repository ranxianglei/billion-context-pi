/**
 * Shown (and logged) when the extension detects an unsupported host and stands down.
 *
 * Unsupported = no Pi `buildContextEntries()` API AND no `PI_ACP_FORK_HOST` declaration
 * (see ./host.ts). OMP (oh-my-pi) falls into this by default: its in-process live-entries
 * integration diverges the nudge's example refs from the session's real refs, so compress
 * calls fail with "does not exist in this session" ([#234]). The billion-context proxy runs
 * compression server-side (it owns the ref coordinate space) and works on OMP.
 */
export const UNSUPPORTED_HOST_MESSAGE = [
  "[billion-context-pi] Unsupported host: no buildContextEntries() API and no PI_ACP_FORK_HOST declaration — ACP has been disabled for this session.",
  "Pi-compatible fork (e.g. Prime) running sessions in-process? Opt in explicitly:",
  "  PI_ACP_FORK_HOST=1 <your host command>",
  "Contract: docs/host-adapter.md → \"Supported-host detection\".",
  "OMP (oh-my-pi)? Use the billion-context proxy instead — it runs compression server-side and works on OMP:",
  "  npm install -g billion-context",
  "  bili omp",
  "Docs: https://github.com/ranxianglei/billion-context",
].join("\n");

/**
 * Shown (and logged) when a session runs on a host that declared itself a
 * Pi-compatible fork via PI_ACP_FORK_HOST (see ./host.ts). Live-tail refs are
 * content-addressed and stable across context fires (#459), which assumes the
 * host's view of the session grows append-only; a host that rewrites or
 * shrinks in-flight messages can still drift refs, so long sessions on such
 * hosts are safer on the proxy (it owns the ref coordinate space server-side).
 */
export const FORK_HOST_WARNING_MESSAGE = [
  "[billion-context-pi] Running on a declared fork host (PI_ACP_FORK_HOST). Live-tail refs are content-stable (#459); if compress ever fails with \"does not exist in this session\", this host rewrites its in-flight view — prefer the billion-context proxy for long sessions:",
  "  npm install -g billion-context",
  "  bili omp",
].join("\n");
