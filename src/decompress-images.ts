import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadAncestorEntries, loadLiveRefEntries } from "./session-log.js";

/** Pi image content block (pi-ai ImageContent). */
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface RestoredImage {
  /** Display label of the source message: its mNNNNN ref when known, else the raw id. */
  label: string;
  image: ImageBlock;
}

/** Inline budget for images returned as tool-result image blocks. Anything
 *  beyond goes to files the model can open with the read tool — a decompress
 *  must never push a request past the provider's image count / byte limits. */
export const MAX_INLINE_IMAGES = 8;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Image blocks carried by a session entry (user / toolResult messages and
 *  content-array custom messages). Folding projects only text into the kernel,
 *  so these bytes survive solely in the append-only session log. */
export function imagesOfEntry(entry: unknown): ImageBlock[] {
  const e = entry as { type?: string; message?: { content?: unknown }; content?: unknown } | undefined;
  const content = e?.type === "message" ? e.message?.content : e?.type === "custom_message" ? e.content : undefined;
  if (!Array.isArray(content)) return [];
  const out: ImageBlock[] = [];
  for (const block of content) {
    const b = block as { type?: string; data?: unknown; mimeType?: unknown };
    if (b?.type !== "image" || typeof b.data !== "string" || b.data.length === 0) continue;
    out.push({ type: "image", data: b.data, mimeType: typeof b.mimeType === "string" && b.mimeType ? b.mimeType : "image/png" });
  }
  return out;
}

/** Resolve session entries by base id with the same fallbacks decompress uses
 *  for text: full tree (getEntry) → active branch → ancestor logs (#531) →
 *  fork-host live-ref aliases (#579). Order of the returned map follows `baseIds`. */
export async function resolveEntriesByBaseId(baseIds: string[], ctx: ExtensionContext): Promise<Map<string, SessionEntry>> {
  const found = new Map<string, SessionEntry>();
  const sm = ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getEntry?: (id: string) => SessionEntry | undefined;
    getEntries?: () => SessionEntry[];
    getBranch?: () => SessionEntry[];
  };
  const scan = sm.getEntries?.() ?? sm.getBranch?.() ?? [];
  for (const id of baseIds) {
    const entry = sm.getEntry?.(id) ?? scan.find((e) => e.id === id);
    if (entry) found.set(id, entry);
  }
  const missing = baseIds.filter((id) => !found.has(id));
  if (missing.length === 0) return found;
  const sessionFile = sm.getSessionFile?.();
  const plain = missing.filter((id) => !id.startsWith("live-"));
  if (plain.length > 0) {
    for (const entry of await loadAncestorEntries(sessionFile, new Set(plain))) found.set(entry.id, entry);
  }
  const live = missing.filter((id) => id.startsWith("live-"));
  if (live.length > 0) {
    for (const [rawId, entry] of await loadLiveRefEntries(sessionFile, new Set(live))) found.set(rawId, entry);
  }
  return found;
}

/** Collect restorable images for the given message ids (CoreMessage ids; the
 *  `#callId` suffix of split assistants is ignored — assistants carry no images). */
export async function collectImages(messageIds: string[], ctx: ExtensionContext, refLabel: (rawId: string) => string): Promise<RestoredImage[]> {
  const baseIds = [...new Set(messageIds.map((id) => id.split("#")[0]!))];
  const entries = await resolveEntriesByBaseId(baseIds, ctx);
  const out: RestoredImage[] = [];
  for (const id of baseIds) {
    const entry = entries.get(id);
    if (!entry) continue;
    for (const image of imagesOfEntry(entry)) out.push({ label: refLabel(id), image });
  }
  return out;
}

export interface ImageDelivery {
  /** Text appended to the decompress result describing what was restored. */
  note: string;
  /** Image blocks to return in the tool result (inline delivery). */
  blocks: ImageBlock[];
}

/** Deliver restored images. `inline` returns up to the inline budget as image
 *  blocks (the model sees pixels again) and writes the rest to files; file mode
 *  writes every image to a file the read tool can open (keeps the default
 *  decompress cheap, matching its text behavior). */
export async function deliverImages(images: RestoredImage[], mode: "inline" | "file", dir: string, prefix: string): Promise<ImageDelivery> {
  if (images.length === 0) return { note: "", blocks: [] };
  const blocks: ImageBlock[] = [];
  const inlineLabels: string[] = [];
  const files: string[] = [];
  let bytes = 0;
  const stamp = Date.now();
  for (let i = 0; i < images.length; i++) {
    const { label, image } = images[i]!;
    const size = image.data.length;
    if (mode === "inline" && blocks.length < MAX_INLINE_IMAGES && bytes + size <= MAX_INLINE_IMAGE_BYTES) {
      blocks.push(image);
      bytes += size;
      inlineLabels.push(`#${blocks.length} ← ${label}`);
      continue;
    }
    await mkdir(dir, { recursive: true }).catch(() => {});
    const path = join(dir, `${prefix}-${stamp}-img${i + 1}.${EXT_BY_MIME[image.mimeType] ?? "bin"}`);
    await writeFile(path, Buffer.from(image.data, "base64"));
    files.push(`${path} (from ${label})`);
  }
  const lines: string[] = ["", `Images: ${images.length} image(s) from the original message(s).`];
  if (blocks.length > 0) lines.push(`Attached below as image blocks (${inlineLabels.join(", ")}).`);
  if (files.length > 0) {
    lines.push(mode === "inline" ? "Over the inline image budget — written to files (open with the read tool):" : "Written to files (open with the read tool to view them):");
    for (const f of files) lines.push(`- ${f}`);
  }
  return { note: lines.join("\n"), blocks };
}
