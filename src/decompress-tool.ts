import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { applyToolPromptOverrides, type ToolPromptOverrides } from "./surface.js";
import { debug, logError, logInfo, logThrow } from "./log.js";
import { parseBlockIdArg, collectBlockContent, markBlockRestoredInline, type CompressionBlock, type InlineRestoreResult } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import { assertNotAborted } from "./abort.js";
import { loadAncestorEntries } from "./session-log.js";
import { UNSUPPORTED_HOST_MESSAGE } from "./omp.js";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, join, basename, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";

/** Directory for auto-generated decompress output files. */
const AUTO_DIR = join(homedir() || tmpdir(), ".cache", "pi", "acp-decompress");

/** Maximum chars of a head preview included in the tool result for file mode. */
const PREVIEW_CHARS = 600;

/** For message-ref decompression: a single message at or above this size is
 *  written to a file instead of returned inline, to avoid context bloat.
 *  Single messages are usually small, so the default for messages is inline
 *  (unlike block decompression, which defaults to file). */
const MESSAGE_INLINE_THRESHOLD = 2000;

const DecompressParams = Type.Object({
  blockId: Type.String({ description: 'Block id to restore, e.g. "b5". Also accepts a message ref (UUID) from search_context results — resolves to the owning block automatically.' }),
  full: Type.Optional(Type.Boolean({ description: "If true, recurse through all nested blocks to original messages. Default: false (restores one tier up — nested block summaries shown, direct messages in full)." })),
  toFile: Type.Optional(Type.String({ description: "Write restored content to this file path (must be under /tmp, ~/.cache/opencode, or ~/.cache/pi) instead of the default auto-generated path. Block stays compressed." })),
  inline: Type.Optional(Type.Boolean({ description: "If true, return content inline as this tool's result (appends to context). Default: false — content is written to an auto-generated file to avoid context bloat. Only set true when the content is small or you accept the context cost." })),
});

type DecompressArgs = Static<typeof DecompressParams>;

export function makeDecompressTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides): ToolDefinition<typeof DecompressParams> {
  return applyToolPromptOverrides({
    name: "decompress",
    label: "Decompress",
    description:
      "Restore a previously compressed block's content, or a single message by its ref. The block/message stays compressed — context and cache prefix are not disrupted. BLOCK decompress (blockId b5) defaults to writing a file (blocks can be large); use the read tool to access it, or inline:true to return inline. MESSAGE decompress (blockId = a message UUID from search_context) returns that ONE message's original text — defaults to inline since a single message is usually small; oversized messages go to a file. full:true recurses through nested block tiers (block mode only). You can pass a block id (b5) OR a message ref (UUID) from search_context results.",
    promptSnippet: 'decompress({ blockId: "b5" }) or decompress({ blockId: "d51b6f94" }) (message ref from search) — writes to file by default; add inline: true to return inline',
    promptGuidelines: [
      "Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
      "Message ref (UUID) returns ONLY that one message's original text, default inline (small). Block id (b5) returns the whole block, default file.",
      "Pass inline:true ONLY when content is small or you accept the context cost (block mode).",
      "Use full:true to recurse through all nested tiers to original messages.",
    ],
    parameters: DecompressParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? UNSUPPORTED_HOST_MESSAGE }] };
      let result: string;
      try {
        result = await handleDecompress(params as DecompressArgs, runtime, ctx, signal);
      } catch (e) {
        logThrow("decompress", e, { sid: ctx.sessionManager.getSessionId(), blockId: (params as DecompressArgs).blockId });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  }, overrides);
}

// #535 P2: close the loop on an inline restore — kernel K2 updates the
// inline-restored block IN PLACE when re-compressed (same id, replaced
// summary) instead of rejecting "already compressed". Degrades to a generic
// hint when the kernel could not derive exact refs (e.g. multi-segment).
function refoldHint(blockId: string, result: InlineRestoreResult | null): string {
  if (result !== null && result.restoredStartRef && result.restoredEndRef) {
    return `Re-fold: call compress("${result.restoredStartRef}–${result.restoredEndRef}", <fresh summary>) → updates block ${blockId} in place (same id, new summary).`;
  }
  return `Re-fold: call compress over the restored messages with a fresh summary → updates block ${blockId} in place (same id, new summary).`;
}

/** Allowed roots for toFile paths. Keeps user-supplied paths from escaping to
 *  arbitrary filesystem locations. */
const ALLOWED_DIRS = [
  tmpdir(),
  join(homedir(), ".cache", "opencode"),
  join(homedir(), ".cache", "pi"),
];

function resolveToFilePath(targetPath: string): string | { error: string } {
  const expanded = targetPath.startsWith("~/")
    ? join(homedir(), targetPath.slice(2))
    : targetPath;
  const resolved = resolve(expanded);
  // Resolve symlinks in the longest existing ancestor before the containment
  // check — a symlinked dir inside an allowed root must not escape it.
  let probe = resolved;
  const suffix: string[] = [];
  while (!existsSync(probe) && probe !== dirname(probe)) {
    suffix.unshift(basename(probe));
    probe = dirname(probe);
  }
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  // Re-resolve any dangling symlinks among the suffix components. existsSync
  // follows links, so a symlink whose target does not (yet) exist is treated
  // as non-existent and skipped by the walk above — but writing through it
  // would land at the (possibly outside) target. Resolve via lstat/readlink.
  let checked = real;
  for (const part of suffix) {
    checked = join(checked, part);
    try {
      if (lstatSync(checked).isSymbolicLink()) {
        const target = readlinkSync(checked);
        checked = isAbsolute(target) ? resolve(target) : resolve(dirname(checked), target);
      }
    } catch {
      // not statable or not a symlink — keep the literal component
    }
  }
  // Compare against realpath'd roots too: tmpdir() often sits behind a
  // symlink (/var -> /private/var on macOS) and the string forms diverge.
  const allowed = ALLOWED_DIRS.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d; // root does not exist yet — keep the literal form
    }
  });
  const isAllowed = allowed.some((dir) => {
    const rel = relative(dir, checked);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    return { error: `Error: toFile path must be under ${tmpdir()}, ~/.cache/opencode, or ~/.cache/pi. Got: ${targetPath}` };
  }
  return checked;
}

/** Generate a unique auto file path for a block. Uses a timestamp so repeated
 *  decompressions of the same block never overwrite each other. */
function autoFilePath(blockId: string): string {
  // blockId already carries the "b" prefix (e.g. "b5"); use it as-is so the
  // filename reads "b5-<ts>.txt" rather than "bb5-<ts>.txt".
  return join(AUTO_DIR, `${blockId}-${Date.now()}.txt`);
}

function headPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  return text.slice(0, PREVIEW_CHARS) + "\n\n... (truncated; use read tool for full content)";
}

/** Locate a single message's original text by its ref (CoreMessage.id). Scans
 *  session entries since the raw text lives in pi's append-only session log,
 *  NOT in the block (blocks store only a summary + the ref pointer). Returns
 *  the text and role, or null if the ref is not found. */
function findMessageContent(ref: string, ctx: ExtensionContext): { text: string; role: string } | null {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    for (const cm of entriesToCoreMessages([entry])) {
      if (cm.id === ref) {
        return { text: cm.text ?? "", role: cm.role };
      }
    }
  }
  return null;
}

/** Recover a block's message refs from the FULL session tree (getEntry), not
 *  just the active branch, so block decompress still works after a tree
 *  navigation (workspace-history /undo /redo, Pi /tree). Block refs are
 *  CoreMessage ids — multi tool-call assistants are `${entryId}#${callId}`
 *  (messages.ts projectMessage) — while getEntry() keys are SessionEntry ids
 *  (no suffix), so both sides normalize to the base id before comparing.
 *  Re-projecting a fetched entry re-splits multi tool-call assistants back
 *  into `${entryId}#${callId}` CoreMessages, which match
 *  block.effectiveMessageIds verbatim in collectBlockContent's targetIds set.
 *  Third fallback (issue #531): a derived child session (Prime RLM inline)
 *  inherits blocks whose message ids exist only in ANCESTOR session logs —
 *  walk the parentSession header chain read-only for whatever is still missing. */
async function resolveBlockMessages(
  block: CompressionBlock,
  coreMessages: ReturnType<typeof entriesToCoreMessages>,
  ctx: ExtensionContext,
): Promise<ReturnType<typeof entriesToCoreMessages>> {
  const neededBaseIds = new Set(block.effectiveMessageIds.map((id) => id.split("#")[0]!));
  const presentBaseIds = new Set(coreMessages.map((m) => m.id.split("#")[0]!));
  const missingBaseIds = [...neededBaseIds].filter((id) => !presentBaseIds.has(id));
  if (missingBaseIds.length === 0) return coreMessages;

  const extra: ReturnType<typeof entriesToCoreMessages> = [];
  for (const baseId of missingBaseIds) {
    const entry = ctx.sessionManager.getEntry(baseId);
    if (entry) extra.push(...entriesToCoreMessages([entry]));
  }

  const coveredBaseIds = new Set([...coreMessages, ...extra].map((m) => m.id.split("#")[0]!));
  const stillMissing = [...neededBaseIds].filter((id) => !coveredBaseIds.has(id));
  if (stillMissing.length > 0) {
    const ancestors = await loadAncestorEntries(ctx.sessionManager.getSessionFile(), new Set(stillMissing));
    if (ancestors.length > 0) {
      logInfo("decompress", { sid: ctx.sessionManager.getSessionId(), event: "ancestor-fallback", missing: stillMissing.length, found: ancestors.length });
      for (const entry of ancestors) extra.push(...entriesToCoreMessages([entry]));
    }
  }
  return [...coreMessages, ...extra];
}

/** Derived-child fallback for a single message ref (issue #531): the entry may
 *  live only in an ancestor session's log (inherited block) — scan the
 *  parentSession chain read-only. */
async function findAncestorMessage(ref: string, ctx: ExtensionContext): Promise<{ text: string; role: string } | null> {
  const baseId = ref.split("#")[0] ?? ref;
  const ancestors = await loadAncestorEntries(ctx.sessionManager.getSessionFile(), new Set([baseId]));
  for (const entry of ancestors) {
    for (const cm of entriesToCoreMessages([entry])) {
      if (cm.id === ref) return { text: cm.text ?? "", role: cm.role };
    }
  }
  return null;
}

/** Decompress a single message by its ref. Unlike block decompression (which
 *  defaults to file — blocks can be huge), a single message is usually small,
 *  so it defaults to inline. Oversized messages still go to a file. */
async function handleMessageRef(
  ref: string,
  ownerBlockId: string,
  args: DecompressArgs,
  ctx: ExtensionContext,
): Promise<string> {
  let found = findMessageContent(ref, ctx);
  if (!found) found = await findAncestorMessage(ref, ctx);
  if (!found || !found.text) {
    return `Message ${ref} (in block ${ownerBlockId}) has no restorable text content in the session log.`;
  }
  const { text, role } = found;

  // Decide inline vs file. Default inline (messages are small); file when the
  // message is large, or toFile/inline:false is set explicitly.
  const wantFile = args.toFile !== undefined || args.inline === false || text.length >= MESSAGE_INLINE_THRESHOLD;

  if (!wantFile) {
    debug.event("decompress-message", { ref, ownerBlockId, mode: "inline", chars: text.length });
    logInfo("decompress", { sid: ctx.sessionManager.getSessionId(), event: "message", mode: "inline", ref, ownerBlockId, chars: text.length });
    return `Message ${ref} (${role}, block ${ownerBlockId}, ${text.length} chars) restored inline:\n\n${text}`;
  }

  const targetPath = args.toFile ? resolveToFilePath(args.toFile) : autoFilePath(`msg-${ref}`);
  if (typeof targetPath === "object" && "error" in targetPath) {
    logError("decompress", { sid: ctx.sessionManager.getSessionId(), event: "message-path-rejected", ref, toFile: args.toFile });
    return targetPath.error;
  }

  await mkdir(AUTO_DIR, { recursive: true }).catch(() => {});
  await writeFile(targetPath, text, "utf8");

  debug.event("decompress-message", { ref, ownerBlockId, mode: "file", path: targetPath, chars: text.length });
  logInfo("decompress", { sid: ctx.sessionManager.getSessionId(), event: "message", mode: "file", ref, ownerBlockId, path: targetPath, chars: text.length });

  return [
    `Message ${ref} (${role}, block ${ownerBlockId}, ${text.length} chars) written to ${targetPath}.`,
    "Block stays compressed — context unchanged. Use the read tool to access the content.",
    "", "Preview:", headPreview(text),
  ].join("\n");
}

async function handleDecompress(args: DecompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const { state, coreMessages } = await runtime.stateFor(ctx);
  assertNotAborted(signal);
  const arg = (args.blockId ?? "").trim();

  // Resolve what `arg` refers to. Check message-ref FIRST (data-driven: a ref
  // exists in some block's effectiveMessageIds). This must precede block-id
  // parsing because pure-digit hex refs (e.g. 51102431) would otherwise be
  // misread as a block number by parseBlockIdArg.
  const owner = state.blocks.find((b) => b.effectiveMessageIds.includes(arg));
  if (owner) {
    return handleMessageRef(arg, owner.blockId, args, ctx);
  }

  // Otherwise treat as a block id.
  const blockId = parseBlockIdArg(arg);
  if (!blockId) return `Invalid blockId: ${args.blockId}. Expected format like "b5", "5", or a message ref (UUID) from search_context results.`;
  const block = state.blocks.find((b) => b.blockId === blockId);
  if (!block) {
    const active = state.blocks.filter((b) => b.active).map((b) => b.blockId).join(", ");
    return `Block ${blockId} not found. Active blocks: ${active || "(none)"}.`;
  }

  const full = args.full ?? false;
  // Resolve the block's message refs against the FULL session tree (falling
  // back to getEntry for refs missing from the active branch, then to ancestor
  // session logs for derived children — issue #531), so decompress still
  // restores original text after a tree navigation (undo/redo//tree) or in a
  // child that inherited the block.
  const resolved = await resolveBlockMessages(block, coreMessages, ctx);
  const { text, count } = collectBlockContent(state, block, resolved, { full });

  if (count === 0) return `Block ${blockId} has no restorable message content.`;

  // inline mode: return content directly. Model explicitly accepts the context
  // cost (e.g. small restorations or when it must reason over exact text).
  if (args.inline === true && !args.toFile) {
    // Flag the block as inline-restored (persisted) so a later compress may
    // refold it in place (kernel K2), and surface the re-fold hint.
    const marked = markBlockRestoredInline(state, blockId);
    await runtime.save(marked.state, ctx);
    debug.event("decompress", { blockId, full, count, mode: "inline", restoredStartRef: marked.result?.restoredStartRef ?? null, restoredEndRef: marked.result?.restoredEndRef ?? null });
    logInfo("decompress", { sid: ctx.sessionManager.getSessionId(), event: "block", mode: "inline", blockId, full, count, refold: marked.result !== null });
    return `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}) inline:\n\n${text}\n\n${refoldHint(blockId, marked.result)}`;
  }

  const targetPath = args.toFile
    ? resolveToFilePath(args.toFile)
    : autoFilePath(blockId);
  if (typeof targetPath === "object" && "error" in targetPath) {
    logError("decompress", { sid: ctx.sessionManager.getSessionId(), event: "block-path-rejected", blockId, toFile: args.toFile });
    return targetPath.error;
  }

  assertNotAborted(signal);
  await mkdir(AUTO_DIR, { recursive: true }).catch(() => {});
  await writeFile(targetPath, text, "utf8");

  debug.event("decompress", { blockId, full, count, mode: "file", path: targetPath, chars: text.length });
  logInfo("decompress", { sid: ctx.sessionManager.getSessionId(), event: "block", mode: "file", blockId, full, count, path: targetPath, chars: text.length });

  const itemWord = count === 1 ? "item" : "items";
  const lines = [
    `Block ${blockId} (${count} ${itemWord}, ${text.length} chars) written to ${targetPath}.`,
    "Block stays compressed — context unchanged. Use the read tool to access the content.",
  ];
  // A short head preview lets the model decide whether the content is worth
  // reading without forcing a second round-trip for small restorations.
  lines.push("", "Preview:", headPreview(text));
  return lines.join("\n");
}
