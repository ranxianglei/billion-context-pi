import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Container, decodeKittyPrintable, fuzzyFilter, getKeybindings, Input, type Component, type SelectItem, type SelectListTheme, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { AcpRuntime } from "./runtime.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent, formatRanges } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { t, setLocale } from "./i18n.js";

declare const CURRENT_VERSION: string;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function makeCommands(runtime: AcpRuntime): Array<{ name: string; options: CommandOptions }> {
  return [
    {
      name: "acp-settings",
      options: {
        description: t("acp-settings.description"),
        handler: async (_args, ctx) => {
          // pi sets ctx.mode ("tui"|"rpc"|"json"|"print"); omp omits the field
          // entirely and always has interactive UI — undefined must pass.
          if (ctx.mode !== undefined && ctx.mode !== "tui") {
            ctx.ui.notify(t("requires-tui"), "error");
            return;
          }
          await settingsCommand(ctx);
        },
      },
    },
    {
      name: "acp",
      options: {
        description: t("acp.description"),
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-status",
      options: {
        description: t("acp-status.description"),
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-decompress",
      options: {
        description: t("acp-decompress.description"),
        handler: async (args, ctx) => {
          const blockId = parseBlockIdArg(args);
          if (!blockId) {
            ctx.ui.notify(t("decompress.usage"));
            return;
          }
          const { state, coreMessages } = await runtime.stateFor(ctx);
          const block = state.blocks.find((b) => b.blockId === blockId);
          if (!block) {
            ctx.ui.notify(t("decompress.not-found", { id: blockId }));
            return;
          }
          const { text, count } = collectBlockContent(state, block, coreMessages, { full: false });
          if (count === 0) {
            ctx.ui.notify(t("decompress.empty", { id: blockId }));
            return;
          }
          ctx.ui.notify(t("decompress.result", { id: blockId, count, text }));
        },
      },
    },
    {
      name: "acp-search",
      options: {
        description: t("acp-search.description"),
        handler: async (args, ctx) => {
          const query = args.trim();
          if (!query) {
            ctx.ui.notify(t("search.usage"));
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const hits = runtime.core.search(query, state);
          if (hits.length === 0) {
            ctx.ui.notify(t("search.no-match"));
            return;
          }
          const lines = hits.map((b) => `[${b.blockId}] (t${b.tier}) ${b.topic ?? ""}`.trim());
          ctx.ui.notify(lines.join("\n"));
        },
      },
    },
  ];
}

class FilterSelectList implements Component {
  private filter = "";
  private selectedIndex = 0;
  private items: SelectItem[];

  constructor(
    items: SelectItem[],
    private maxVisible: number,
    private theme: SelectListTheme,
    private onSelect: (item: SelectItem) => void,
    private onCancel: () => void,
  ) {
    this.items = [...items].sort((a, b) => {
      const pa = a.value.split(":")[0] ?? a.value;
      const pb = b.value.split(":")[0] ?? b.value;
      return pa === pb ? a.label.localeCompare(b.label) : pa.localeCompare(pb);
    });
  }

  private filtered(): SelectItem[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.items;
    return fuzzyFilter(this.items, q, (i) => `${i.value} ${i.label}`);
  }

  private providerOf(item: SelectItem): string {
    return item.value.split(":")[0] || "(clear)";
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const items = this.filtered();
    lines.push(this.theme.description(this.filter ? `filter: ${this.filter}` : "type to filter"));
    if (items.length === 0) {
      lines.push(this.theme.noMatch("no matches"));
      return lines;
    }
    if (this.selectedIndex >= items.length) this.selectedIndex = items.length - 1;
    const start = Math.max(0, this.selectedIndex - this.maxVisible + 1);
    const end = Math.min(items.length, start + this.maxVisible);
    let lastProvider = "";
    for (let i = start; i < end; i++) {
      const item = items[i];
      if (!item) continue;
      const provider = this.providerOf(item);
      if (provider !== lastProvider) {
        lines.push(this.theme.description(`─ ${provider} ─`));
        lastProvider = provider;
      }
      lines.push(i === this.selectedIndex ? this.theme.selectedText(`→ ${item.label}`) : `  ${item.label}`);
    }
    if (items.length > this.maxVisible) {
      lines.push(this.theme.scrollInfo(`${this.selectedIndex + 1}/${items.length}`));
    }
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const len = this.filtered().length;
    if (kb.matches(data, "tui.select.up")) {
      if (len > 0) this.selectedIndex = (this.selectedIndex - 1 + len) % len;
    } else if (kb.matches(data, "tui.select.down")) {
      if (len > 0) this.selectedIndex = (this.selectedIndex + 1) % len;
    } else if (kb.matches(data, "tui.select.confirm")) {
      const item = this.filtered()[this.selectedIndex];
      if (item) this.onSelect(item);
    } else if (kb.matches(data, "tui.select.cancel")) {
      if (this.filter) this.filter = "";
      else this.onCancel();
    } else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      this.filter = this.filter.slice(0, -1);
    } else {
      const printable = decodeKittyPrintable(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
      if (printable) this.filter += printable;
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered().length - 1));
  }
}

async function settingsCommand(ctx: ExtensionCommandContext): Promise<void> {
  const config = await readAcpConfigs(ctx.cwd);
  const fmt = (v: unknown, d: string): string => (v === undefined || v === "" ? d : String(v));

  const items: SettingItem[] = [
    {
      id: "compressModel",
      label: t("settings.compressModel"),
      description: t("settings.compressModel.desc"),
      currentValue: fmt(config.compressModel, t("settings.mainModel")),
    },
    {
      id: "autoUpdate",
      label: t("settings.autoUpdate"),
      description: t("settings.autoUpdate.desc"),
      currentValue: config.autoUpdate ? t("settings.on") : t("settings.off"),
      values: [t("settings.on"), t("settings.off")],
    },
    {
      id: "debug",
      label: t("settings.debug"),
      description: t("settings.debug.desc"),
      currentValue: config.debug ? t("settings.on") : t("settings.off"),
      values: [t("settings.on"), t("settings.off")],
    },
    {
      id: "delegate",
      label: t("settings.delegate"),
      description: t("settings.delegate.desc"),
      currentValue: config.delegate ? t("settings.on") : t("settings.off"),
      values: [t("settings.on"), t("settings.off")],
    },
    {
      id: "modelContextLimit",
      label: t("settings.modelContextLimit"),
      description: t("settings.modelContextLimit.desc"),
      currentValue: fmt(config.modelContextLimit, t("settings.auto")),
    },
    {
      id: "toolBashDefaultTimeout",
      label: t("settings.toolBashDefaultTimeout"),
      description: t("settings.toolBashDefaultTimeout.desc"),
      currentValue: fmt(config.toolBashDefaultTimeout, t("settings.default")),
    },
    {
      id: "toolOutputMaxBytes",
      label: t("settings.toolOutputMaxBytes"),
      description: t("settings.toolOutputMaxBytes.desc"),
currentValue: fmt(config.toolOutputMaxBytes, t("settings.default")),
    },
    {
      id: "language",
      label: t("settings.language"),
      description: t("settings.language.desc"),
      currentValue: fmt(config.language, t("settings.auto")),
      values: ["zh", "en"],
    },
  ];

  const numericIds = ["modelContextLimit", "toolBashDefaultTimeout", "toolOutputMaxBytes"];

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(t("settings.title"))), 1, 0));

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        const patch: Record<string, unknown> = {};
        if (id === "compressModel") {
          patch.compressModel = newValue;
        } else if (id === "autoUpdate" || id === "debug" || id === "delegate") {
          patch[id] = newValue === "on";
        } else if (numericIds.includes(id)) {
          const n = Number(newValue);
          if (!Number.isFinite(n) || n <= 0) {
            ctx.ui.notify(t("settings.invalidNumber", { value: newValue }), "error");
            return;
          }
          patch[id] = n;
} else if (id === "language") {
          patch.language = newValue === "zh" || newValue === "en" ? newValue : undefined;
        }
void saveConfig(patch)
          .then(() => {
            if (id === "language") setLocale(patch.language as string | undefined); // 立即生效，无需重启
            ctx.ui.notify(t("settings.saved", { id, value: newValue }), "info");
          })
          .catch((err: unknown) => ctx.ui.notify(t("settings.saveFailed", { error: err instanceof Error ? err.message : String(err) }), "error"));
      },
      () => done(undefined),
      { enableSearch: true },
    );

    const modelItem = items[0];
    if (modelItem) modelItem.submenu = (cur, subDone) =>
      new FilterSelectList(
        buildModelItems(ctx),
        15,
        {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        },
        (item: SelectItem) => subDone(item.value),
        () => subDone(undefined),
      );
    for (const id of numericIds) {
      const item = items.find((i) => i.id === id);
      if (!item) continue;
      item.submenu = (cur, subDone) => {
        const input = new Input();
        input.setValue(cur === "auto" || cur === "default" ? "" : cur);
        input.onSubmit = (v) => subDone(v.trim() || undefined);
        input.onEscape = () => subDone(undefined);
        return input;
      };
    }

    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", t("settings.hint")), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function buildModelItems(ctx: ExtensionCommandContext): SelectItem[] {
  const models = ctx.modelRegistry.getAvailable();
  const compressModels = models.filter(
    (m) => m.provider === "alibaba-coding" || m.provider === "alibaba-token" || m.provider === "deepseek" || m.provider === "opencode",
  );
  const seen = new Set<string>();
  const items: SelectItem[] = compressModels
    .filter((m) => {
      const key = `${m.provider}:${m.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((m) => {
      const isCodingPlan = m.provider === "alibaba-coding" || m.provider === "alibaba-token";
      return {
        value: `${m.provider}:${m.id}`,
        label: `${m.name || m.id} (${m.provider}${isCodingPlan ? ", coding plan" : ""})`,
      };
    });
  items.unshift({ value: "", label: t("clear-config") });
  return items;
}

/** Read global + project acp.json (project wins), keeping unknown keys so the
 *  settings panel can show e.g. compressModel which is not part of UserAcpConfig. */
async function readAcpConfigs(cwd: string): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  for (const base of [join(homedir(), CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
      if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return merged;
}

/** Merge patch into the global acp.json. Empty/undefined values delete the key. */
export async function saveConfig(patch: Record<string, unknown>): Promise<void> {
  const configPath = join(homedir(), CONFIG_DIR_NAME, "acp.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  } catch (err) {
    // Missing file → start fresh; corrupt JSON → surface instead of silently
    // overwriting the user's whole config.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") delete config[k];
    else config[k] = v;
  }
  await fs.mkdir(join(homedir(), CONFIG_DIR_NAME), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function bar(value: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  const realUsage = ctx.getContextUsage?.();
  const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n"));

  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
  const nudge = turn.nudge;
  const bd = nudge?.contextBreakdown;
  const limit = config.modelContextLimit;
  const classified = bd ? bd.system + bd.tool + bd.summaries + bd.code + bd.text : 0;
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const framework = bd ? Math.max(0, tokenCount - classified - systemPromptTokens) : 0;
  const displayTotal = tokenCount;
  const displayPct = limit > 0 ? Math.round((displayTotal / limit) * 100) : 0;
  const activeBlocksList = state.blocks.filter((b) => b.active);
  const totalBlocksList = state.blocks;

  const lines: string[] = [];

  const versionStr = CURRENT_VERSION ? `billion-context-pi@${CURRENT_VERSION}` : "";

  lines.push("╭─────────────────────────────────────────────╮");
  lines.push(`│ ${t("header").padEnd(41)} │`);
  lines.push("╰─────────────────────────────────────────────╯");
  if (versionStr) lines.push(versionStr);
  lines.push("");
  lines.push(t("context", { pct: displayPct, used: fmtTokens(displayTotal), limit: fmtTokens(limit) }));

  if (nudge && bd) {
    const growth = bd.growth;
    if (growth > 0 && displayTotal > 0) {
      lines.push(t("growth", { growth: fmtTokens(growth) }));
    }
    if (displayTotal > 0) {
      lines.push("");
      lines.push(t("breakdown"));

      const categories: Array<{ label: string; value: number }> = [
        { label: "Tool", value: bd.tool },
        { label: "SysPrompt", value: systemPromptTokens },
        { label: "Framework", value: framework },
        { label: "Text", value: bd.text },
        { label: "Code", value: bd.code },
        { label: "Summaries", value: bd.summaries },
      ];

      for (const cat of categories) {
        if (cat.value <= 0) continue;
        const pct = displayTotal > 0 ? Math.round((cat.value / displayTotal) * 100) : 0;
        const b = bar(cat.value, displayTotal);
        lines.push(`  ${cat.label.padEnd(10)} ${b} ${String(pct).padStart(3)}%  ${fmtTokens(cat.value)}`);
      }
    }
  }

  lines.push("");

  if (nudge) {
    if (nudge.shouldInject) {
      const tierInfo = nudge.tier ? ` [T${nudge.tier} distillation]` : "";
      lines.push(t("nudge.active", { tier: tierInfo, reason: nudge.reason }));
    } else {
      lines.push(t("nudge.idle", { reason: nudge.reason }));
    }
  }

  const ranges = nudge?.compressibleRanges ?? [];
  const protectedRanges = nudge?.protectedRanges ?? [];
  if (ranges.length > 0 || protectedRanges.length > 0) {
    lines.push("");
    lines.push(formatRanges(ranges, protectedRanges));
  }

  if (activeBlocksList.length > 0) {
    lines.push("");
    lines.push(t("blocks.active", { active: activeBlocksList.length, total: totalBlocksList.length, tokens: fmtTokens(state.stats.tokensCompressed) }));
    for (const b of activeBlocksList) {
      const topic = b.topic ? `: ${b.topic}` : "";
      const summaryTok = defaultCountTokens(b.summary || "");
      const origTok = b.compressedTokens > 0 ? b.compressedTokens : summaryTok;
      lines.push(`  [${b.blockId}] T${b.tier} ${fmtTokens(origTok)}\u2192${fmtTokens(summaryTok)}${topic}`);
    }
  } else if (totalBlocksList.length > 0) {
    lines.push("");
    lines.push(t("blocks.active", { active: 0, total: totalBlocksList.length, tokens: fmtTokens(state.stats.tokensCompressed) }));
  } else {
    lines.push("");
    lines.push(t("blocks.none"));
  }

  lines.push("");
  lines.push(t("tag-visibility"));

  return lines.join("\n");
}