import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow } from "./log.js";
import { parseBlockIdArg, collectBlockContent, type CompressionBlock } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
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

export function makeDecompressTool(runtime: AcpRuntime): ToolDefinition<typeof DecompressParams> {
  return {
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: string;
      try {
        result = await handleDecompress(params as DecompressArgs, runtime, ctx);
      } catch (e) {
        logThrow("decompress", e, { sid: ctx.sessionManager.getSessionId(), blockId: (params as DecompressArgs).blockId });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
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
  const checked = join(real, ...suffix);
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
 *  block.effectiveMessageIds verbatim in collectBlockContent's targetIds set. */
function resolveBlockMessages(
  block: CompressionBlock,
  coreMessages: ReturnType<typeof entriesToCoreMessages>,
  ctx: ExtensionContext,
): ReturnType<typeof entriesToCoreMessages> {
  const neededBaseIds = new Set(block.effectiveMessageIds.map((id) => id.split("#")[0]!));
  const presentBaseIds = new Set(coreMessages.map((m) => m.id.split("#")[0]!));
  const missingBaseIds = [...neededBaseIds].filter((id) => !presentBaseIds.has(id));
  if (missingBaseIds.length === 0) return coreMessages;

  const extra: ReturnType<typeof entriesToCoreMessages> = [];
  for (const baseId of missingBaseIds) {
    const entry = ctx.sessionManager.getEntry(baseId);
    if (entry) extra.push(...entriesToCoreMessages([entry]));
  }
  return [...coreMessages, ...extra];
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
  const found = findMessageContent(ref, ctx);
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

async function handleDecompress(args: DecompressArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
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
  // back to getEntry for refs missing from the active branch), so decompress
  // still restores original text after a tree navigation (undo/redo//tree).
  const resolved = resolveBlockMessages(block, coreMessages, ctx);
  const { text, count } = collectBlockContent(state, block, resolved, { full });

  if (count === 0) return `Block ${blockId} has no restorable message content.`;

  // inline mode: return content directly. Model explicitly accepts the context
  // cost (e.g. small restorations or when it must reason over exact text).
  if (args.inline === true && !args.toFile) {
    debug.event("decompress", { blockId, full, count, mode: "inline" });
    logInfo("decompress", { sid: ctx.sessionManager.getSessionId(), event: "block", mode: "inline", blockId, full, count });
    return `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}) inline:\n\n${text}`;
  }

  const targetPath = args.toFile
    ? resolveToFilePath(args.toFile)
    : autoFilePath(blockId);
  if (typeof targetPath === "object" && "error" in targetPath) {
    logError("decompress", { sid: ctx.sessionManager.getSessionId(), event: "block-path-rejected", blockId, toFile: args.toFile });
    return targetPath.error;
  }

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
