/** Minimal i18n for user-facing slash-command output. Machine-facing text
 *  (tool descriptions, system prompts, nudge reports) stays English on purpose. */
export type Locale = "en" | "zh";

export function detectLocale(): Locale {
  const raw = process.env.LANG ?? process.env.LC_ALL ?? "";
  return /^zh/i.test(raw) ? "zh" : "en";
}

const zh = {
  "acp-settings.description": "配置 ACP 设置（压缩模型、自动更新、限制）。",
  "acp.description": "显示 ACP 上下文占用、Token 构成与压缩状态。",
  "acp-status.description": "ACP 详细状态（压缩块层级、Token 构成）。",
  "acp-decompress.description": "恢复压缩块内容（显示在会话中，块保持折叠）。用法: /acp-decompress b3",
  "acp-search.description": "搜索压缩块摘要。用法: /acp-search auth token",
  "requires-tui": "/acp-settings 需要 TUI 模式",
  "decompress.usage": "用法: /acp-decompress <blockId>（例如 \"b3\"）",
  "decompress.not-found": "块 {id} 未找到。",
  "decompress.empty": "块 {id} 没有可恢复的消息内容。",
  "decompress.result": "块 {id}（{count} 条消息）:\n\n{text}",
  "search.usage": "用法: /acp-search <查询词>",
  "search.no-match": "没有匹配的块。",
  "header": "ACP 上下文分析",
  "context": "上下文: {pct}% ({used} / {limit})",
  "growth": "较上次提示增长: +{growth}",
  "breakdown": "Token 构成:",
  "nudge.active": "提示: 活跃{tier} — {reason}",
  "nudge.idle": "提示: 空闲 — {reason}",
  "blocks.active": "压缩块: {active} 活跃 / {total} 总计（已压缩 {tokens} tokens）",
  "blocks.none": "压缩块: 无（尚未压缩任何内容）",
  "tag-visibility": "标签可见性: 仅注入 LLM（深拷贝），不写入会话，不在终端显示。",
  "clear-config": "[清除配置 - 使用主模型]",
  "settings.title": "ACP 设置",
  "settings.compressModel": "压缩模型",
  "settings.compressModel.desc": "用于上下文压缩的模型。回车从可用模型中选择。",
  "settings.autoUpdate": "自动更新",
  "settings.autoUpdate.desc": "会话启动时检查 npm 新版本（6 小时节流）。",
  "settings.debug": "调试日志",
  "settings.debug.desc": "向 pi 日志写入调试行。",
  "settings.delegate": "委派子任务",
  "settings.delegate.desc": "对独立的审查/调查工作使用子代理。",
  "settings.modelContextLimit": "模型上下文限制（tokens）",
"settings.modelContextLimit.desc": "估算上下文压力时的上限（tokens）。留空 = 自动（按当前模型窗口）。填小值更早触发压缩提示：如 150000 = 15 万 tokens；64000 = 6.4 万（更激进）。",
  "settings.toolBashDefaultTimeout": "Bash 默认超时（秒）",
  "settings.toolBashDefaultTimeout.desc": "bash 工具调用默认超时（秒）。留空 = 默认。如 60 = 1 分钟；0 = 禁用超时（无限等待，不推荐）。",
  "settings.toolOutputMaxBytes": "工具输出最大字节",
  "settings.toolOutputMaxBytes.desc": "截断前的工具输出大小上限（字节）。留空 = 默认。如 8192 = 8KB（更省上下文）；0 = 禁用截断。",
  "settings.on": "开",
  "settings.off": "关",
  "settings.mainModel": "主模型",
  "settings.auto": "自动",
  "settings.default": "默认",
  "settings.invalidNumber": "无效数字: {value}",
  "settings.saved": "{id} = {value}",
"settings.saveFailed": "保存失败: {error}",
  "settings.hint": "回车/空格修改 • 输入搜索 • esc 关闭",
  "settings.language": "语言",
  "settings.language.desc": "界面语言（slash 命令输出 / 压缩提示）。zh 或 en，缺省按系统 LANG 检测。",
  "nudge.compressedBlocks": "压缩块: {count} 个活跃 ({tiers}) — 摘要 {summary}，原始 {original} 已压缩。块: {ids}{more}。",
  "nudge.minChars": "压缩要求每个范围至少 {min} 字符消息文本（kernel 强制）。以上范围是提示 —— 若太小，把相邻范围合并为一次调用: 第一个的 startId，最后一个的 endId。",
  "compact.compressing": "ACP 正在压缩上下文 ({tokens} tokens)...",
  "compact.failed": "ACP 压缩失败，回退 Pi 默认压缩",
  "compact.done": "ACP 压缩完成: {tokens} tokens → {model}",
} as const;

const en: Record<keyof typeof zh, string> = {
  "acp-settings.description": "Configure ACP settings (compression model, auto-update, limits).",
  "acp.description": "Show ACP context usage, token breakdown, and compression status.",
  "acp-status.description": "Detailed ACP status (block tiers, token breakdown).",
  "acp-decompress.description": "Restore a compressed block's content (shown here, block stays folded). Usage: /acp-decompress b3",
  "acp-search.description": "Search compressed block summaries. Usage: /acp-search auth token",
  "requires-tui": "/acp-settings requires TUI mode",
  "decompress.usage": 'Usage: /acp-decompress <blockId> (e.g. "b3")',
  "decompress.not-found": "Block {id} not found.",
  "decompress.empty": "Block {id} has no restorable message content.",
  "decompress.result": "Block {id} ({count} items):\n\n{text}",
  "search.usage": "Usage: /acp-search <query>",
  "search.no-match": "No matching blocks.",
  "header": "ACP Context Analysis",
  "context": "Context: {pct}% ({used} / {limit})",
  "growth": "Growth: +{growth} since last nudge",
  "breakdown": "Token Breakdown:",
  "nudge.active": "Nudge: ACTIVE{tier} — {reason}",
  "nudge.idle": "Nudge: idle — {reason}",
  "blocks.active": "Blocks: {active} active / {total} total ({tokens} tokens compressed)",
  "blocks.none": "Blocks: none (nothing compressed yet)",
  "tag-visibility": "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.",
  "clear-config": "[Clear config - use main model]",
  "settings.title": "ACP Settings",
  "settings.compressModel": "Compression model",
  "settings.compressModel.desc": "Model used for context compression. Enter to pick from available models.",
  "settings.autoUpdate": "Auto update",
  "settings.autoUpdate.desc": "Check npm for newer versions on session start (6h throttle).",
  "settings.debug": "Debug logging",
  "settings.debug.desc": "Write debug log lines to the pi log.",
  "settings.delegate": "Delegate sub-tasks",
  "settings.delegate.desc": "Use sub-agents for independent review/investigation work.",
  "settings.modelContextLimit": "Model context limit (tokens)",
"settings.modelContextLimit.desc": "Cap used when estimating context pressure (tokens). Empty = auto (current model window). A smaller value triggers compression nudges sooner: e.g. 150000 = 150k tokens; 64000 = 64k (more aggressive).",
  "settings.toolBashDefaultTimeout": "Bash default timeout (s)",
  "settings.toolBashDefaultTimeout.desc": "Default timeout for bash tool calls (seconds). Empty = default. E.g. 60 = 1 minute; 0 = disable timeout (unbounded wait, not recommended).",
  "settings.toolOutputMaxBytes": "Tool output max bytes",
  "settings.toolOutputMaxBytes.desc": "Cap on tool output size before truncation (bytes). Empty = default. E.g. 8192 = 8KB (tighter context); 0 = disable truncation.",
  "settings.on": "on",
  "settings.off": "off",
  "settings.mainModel": "main model",
  "settings.auto": "auto",
  "settings.default": "default",
  "settings.invalidNumber": "Invalid number: {value}",
  "settings.saved": "{id} = {value}",
  "settings.saveFailed": "Failed to save: {error}",
"settings.hint": "enter/space change • type to search • esc close",
  "settings.language": "Language",
  "settings.language.desc": "UI language (slash command output / compression nudges). zh or en; defaults to system LANG detection.",
  "nudge.compressedBlocks": "Compressed blocks: {count} active ({tiers}) — {summary} summary, {original} original compressed. Blocks: {ids}{more}.",
  "nudge.minChars": "Compression requires at least {min} chars of message text per range (kernel-enforced). The ranges above are hints — if one is too small, combine adjacent ranges into a single call: startId of the first, endId of the last.",
  "compact.compressing": "ACP compressing context ({tokens} tokens)...",
  "compact.failed": "ACP compression failed, falling back to Pi default",
  "compact.done": "ACP compression done: {tokens} tokens → {model}",
};

let cached: Locale | null = null;

/** Resolve locale once per process (LANG/LC_ALL don't change mid-session). */
export function locale(): Locale {
  if (!cached) cached = detectLocale();
  return cached;
}

/** Override locale from user config (acp.json "language"); null resets to LANG detection. */
export function setLocale(lang: string | undefined): void {
  cached = lang === "zh" || lang === "en" ? lang : null;
}

/** Translate a key, substituting {name} placeholders. Falls back to English. */
export function t(key: keyof typeof zh, params?: Record<string, string | number>): string {
  const table: Record<string, string> = locale() === "zh" ? zh : en;
  let out = table[key] ?? en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}
