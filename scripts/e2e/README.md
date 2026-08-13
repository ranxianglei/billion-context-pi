# billion-context-pi E2E regression suite

End-to-end regression tests for the billion-context-pi Pi extension, modelled on
[opencode-acp](https://github.com/ranxianglei/opencode-acp)'s
`scripts/e2e/` harness. Instead of opencode, these tests drive the **real `pi`
host** (`pi -p`) headlessly against a fake, scripted LLM and assert on the
persisted ACP state.

## How it works

```
                ┌──────────────────────────┐
   pi -p ──────▶│ fake-llm-server.cjs      │  OpenAI-compatible SSE on :8400
   (real host)  │  scenario-driven turns   │  emits text OR compress/decompress/
                │  parses <acp>mNNNNN</acp>│  search tool_use calls
                └───────────┬──────────────┘
                            │
            billion-context-pi extension (-e scripts/e2e/e2e-extension.js)
                            │
                ┌───────────▼──────────────┐
                │ ~/.pi/agent/sessions/    │  <session>.jsonl
                │   <ts>_<uuid>.jsonl      │
                │   <ts>_<uuid>.jsonl.acp.json   ← persisted CompressionState
                └───────────┬──────────────┘
                            │
                ┌───────────▼──────────────┐
                │ verify.mjs               │  asserts block counts, nudge
                │                          │  baselines, compression stats,
                │                          │  session-log tool invocations
                └──────────────────────────┘
```

For each scenario in `scenarios/*.json`:

1. An **isolated Pi HOME** is written (`models.json` → fake provider,
   `acp.json` → `{ autoUpdate:false, debug:false }` merged with the scenario's
   `acpConfig`).
2. The **fake LLM server** is started, seeded with the scenario file. It tracks
   turns via a file counter (one counter per scenario, so each `pi -p`
   invocation advances to the next scripted response).
3. Real `pi -p` turns are driven (`-c` to continue the same session). Each
   non-`auto` scenario turn maps to one `pi -p` invocation; `auto:true` turns
   are tool-call follow-ups consumed inside the previous invocation.
4. The persisted state file (`<session>.jsonl.acp.json`) is located and handed
   to `verify.mjs`, which checks the scenario's `verify` expectations.

## Running locally

```bash
npm ci
npm run build
npm run e2e                          # all scenarios (cross-platform)
npm run e2e -- 03-nudge              # filter by filename substring
```

The runner is `scripts/e2e/run-e2e.mjs` (Node; works on Linux, macOS, and
Windows). It isolates each scenario under a temp Pi home by setting both `HOME`
and `USERPROFILE`, since Node's `os.homedir()` reads `HOME` on POSIX but
`USERPROFILE` on Windows. A legacy `run-e2e.sh` (bash) is kept for reference.

Prerequisites: `node` ≥ 20 and the `pi` binary from the dev dependency
(`./node_modules/.bin/pi`, pinned to a known version in `package.json`).

## Running in Docker

The Docker image pins the Node major and the Pi host version (via
`package.json` devDependencies + `npm ci`) for full reproducibility:

```bash
docker build -t bcp-e2e -f Dockerfile.e2e .
docker run --rm bcp-e2e              # all scenarios
docker run --rm bcp-e2e 03-nudge     # filtered
```

## Scenario format

```jsonc
{
  "name": "basic-compress",
  "description": "...",
  "acpConfig": { "modelContextLimit": 1500 },  // optional, merged into ~/.pi/acp.json
  "turns": [
    { "respond": "text",  "userText": "...", "text": "..." },     // assistant text reply
    { "respond": "compress", "range": "all", "topic": "...", "summary": "...",
      "auto": true },                                              // tool-call follow-up
    { "respond": "decompress", "blockId": "b1", "auto": true },
    { "respond": "nudge-compress", "growthText": "...", "summary": "...", "auto": true }
  ],
  "verify": {
    "blockCount": 1,
    "activeBlockCount": 1,
    "compressionCount": 1,
    "summaryContains": "src/auth/jwt.ts:78",
    "nudgeBaselineSet": true,
    "toolInvoked": "decompress"
  }
}
```

### `respond` step types

| type             | behaviour                                                                 |
|------------------|---------------------------------------------------------------------------|
| `text`           | reply with `text`                                                          |
| `compress`       | emit a `compress` tool_use over `range` (`"all"` or `[startIdx, endIdx]`) |
| `nudge-compress` | if billion-context-pi injected a nudge → compress; else emit `growthText` |
| `decompress`     | emit a `decompress` tool_use for `blockId`                                 |
| `search`         | emit a `search_context` tool_use                                           |
| `tool`           | emit an arbitrary `tool`/`toolArgs` call                                   |

### `verify` fields

`blockCount` / `minBlockCount` / `maxBlockCount`, `activeBlockCount`,
`minCompressedCount` / `maxCompressedCount`, `nudgeBaselineSet`,
`tier2BaselineSet`, `summaryContains`, `compressionCount`,
`maxCompressCallsVisible` / `lastRequestCompressCalls`,
`minNudgeCount` / `maxNudgeCount`, `childBlockCount`, `toolInvoked`.

`toolInvoked` scans the Pi session log (`<session>.jsonl`) for a tool call by
name — used to confirm side-effect-only tools (like `decompress`) actually ran,
since they don't mutate `CompressionState`.

## The test extension shim

`scripts/e2e/e2e-extension.js` builds the extension with test-only overrides
mirroring opencode-acp's `acp.jsonc`: no recent-message protection and a tiny
`minCompressRange`, so compact fixtures exercise the compress path without
needing tens of thousands of chars. It is **only** loaded in e2e (via
`-e scripts/e2e/e2e-extension.js`); production users load `dist/index.js`.
