// Issue #309: small models sometimes emit summaries whose CJK text arrived as
// literal \uXXXX sequences (double-escaped on the wire, so one JSON.parse leaves
// 6-char "\u5408" runs in the parsed string). The kernel stores and renders
// summaries verbatim, so the corruption would persist into every future prompt
// and re-contaminate tier-2/tier-3 distillations. Normalize at ingest instead.

const UNICODE_ESCAPE_RE = /\\u[0-9a-fA-F]{4}/g;

export function countUnicodeEscapes(s: string): number {
  const m = s.match(UNICODE_ESCAPE_RE);
  return m ? m.length : 0;
}

// Decodes ONLY \uXXXX runs (incl. surrogate pairs) — \n, \\ etc. stay literal,
// so legitimate escape examples in prose are never mangled below the threshold.
export function decodeUnicodeEscapes(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.charAt(i) === "\\" && s.charAt(i + 1) === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        const high = parseInt(hex, 16);
        const next = s.slice(i + 6, i + 12);
        if (high >= 0xd800 && high <= 0xdbff && /^\\u[0-9a-fA-F]{4}$/.test(next)) {
          const low = parseInt(next.slice(2, 6), 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            out += String.fromCodePoint(((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000);
            i += 12;
            continue;
          }
        }
        out += String.fromCharCode(high);
        i += 6;
        continue;
      }
    }
    out += s.charAt(i);
    i++;
  }
  return out;
}

// Strictly-more-than semantics: a summary legitimately quoting a few \uXXXX
// examples must survive; dense runs (>20) are the double-escape failure mode.
export const UNESCAPE_THRESHOLD = 20;

export function sanitizeSummary(s: string): { text: string; unescaped: boolean } {
  if (countUnicodeEscapes(s) <= UNESCAPE_THRESHOLD) return { text: s, unescaped: false };
  return { text: decodeUnicodeEscapes(s), unescaped: true };
}

// Issue #309 phenomenon B: a hallucinated user phrase was stored as
// `user verbatim '...'` / `CURRENT TASK: user '...'`. Without an mNNNNN ref the
// quote is unverifiable and later readers treat it as fact — the loop amplifier.
// Detection only: callers log evidence ([warn] summary-unverifiable-quote),
// they NEVER rewrite the model's text.
const USER_QUOTE_CLAIMS: RegExp[] = [
  /\buser\s+verbatim\b/i,
  /\bverbatim\s+user\b/i,
  /\buser\s*[:：]\s*["'"“”‘’]/i,
  /\buser\s+["'"“”‘’]/i,
  /\buser\s+said\s+["'"“”‘’]/i,
  /["'"“”‘’][^"'\n]{1,200}["'"“”‘’]\s*\(\s*(?:from\s+)?user\s*\)/i,
  /用户(?:的)?原话/,
];

const MESSAGE_REF_RE = /\bm\d{4,}\b/i;

// null when no claim matches, or when the summary carries at least one mNNNNN
// ref (quotes then point at verifiable messages).
export function findUnverifiableUserQuote(summary: string): string | null {
  if (MESSAGE_REF_RE.test(summary)) return null;
  for (const re of USER_QUOTE_CLAIMS) {
    const m = re.exec(summary);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}
