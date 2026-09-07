// Manual-wiring detection for the billion-context wire proxy (issue #296):
// a user who starts the proxy standalone (`bili start`) and points pi's
// models.json baseUrl at `http://127.0.0.1:PORT/bili/<scheme>://upstream...`
// never gets the BILLION_CONTEXT_PROXY env var (only the `bili pi` launcher
// exports it), so without this check bcp and the proxy both compress every
// request. Mirrors proxyBaseFromUrl in billion-context (src/agent/shared.ts):
// the real prefix embeds the full upstream URL, so require `bili` as the FIRST
// path segment followed by an http(s) URL — a plain `/foo/bili/` path is NOT a
// bili proxy. MITM transparent mode (HTTPS_PROXY) has no /bili/ prefix and
// stays undetectable from the URL; those users must export the env var.
export function isBiliProxyBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments[0] !== "bili") return false;
    const rest = url.pathname.slice(url.pathname.indexOf("bili") + "bili".length);
    return /^\/https?:\/\//.test(rest);
  } catch {
    return false;
  }
}

/**
 * Shown (and logged) when the extension detects that the model's baseUrl
 * routes through the billion-context wire proxy and stands down. The proxy
 * runs compression server-side and owns the ref coordinate space, so running
 * ACP in-process on top of it would double-compress every request.
 */
export const PROXY_STAND_DOWN_MESSAGE = [
  "[billion-context-pi] Model baseUrl routes through the billion-context wire proxy (/bili/ prefix) — ACP client-side compression has been disabled for this session to avoid double compression.",
  "The proxy runs the same compression pipeline server-side and owns the ref coordinate space; nothing else to configure.",
  "If your traffic reaches the proxy via HTTPS_PROXY instead (no /bili/ prefix in the URL), export BILLION_CONTEXT_PROXY=1 before starting pi.",
  "Docs: https://github.com/ranxianglei/billion-context",
].join("\n");
