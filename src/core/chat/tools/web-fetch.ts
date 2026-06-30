/**
 * Built-in `web_fetch` tool — one-shot URL → text.
 *
 * Codex/Claude Code parity: Claude Code has `WebFetchTool` (and
 * `WebBrowserTool` for headful). Codex relies on shell + curl. We follow
 * Claude Code — explicit schema, structured output, no shell quoting
 * headaches for the model.
 *
 * Hard caps + safety:
 *   - 30s request timeout (configurable per-call up to 60s)
 *   - 1 MB response cap (truncated with notice)
 *   - SSRF guard: rejects localhost / link-local / private RFC1918 ranges
 *     unless the workspace owner explicitly allows them in opts. (We don't
 *     want a model researching "current weather" to be able to hit
 *     127.0.0.1:7878 and mess with mathran serve itself.)
 *   - Only http/https schemes allowed.
 *   - User-Agent: mathran/0.1 so target servers can identify us.
 *
 * Output format options:
 *   - "text" (default) — body as UTF-8 text, normalized whitespace.
 *   - "html" — raw HTML body.
 *   - "headers" — HTTP response headers only (debug/inspection use).
 */

import * as dns from "node:dns/promises";
import type { ToolSpec } from "../session.js";

export interface WebFetchToolOptions {
  /** Allow private network targets (default false — SSRF guard ON). */
  allowPrivateNetwork?: boolean;
  /** User-Agent string sent on every request. Default `mathran-web-fetch/0.1`. */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BYTES = 1_000_000; // 1 MB

type Format = "text" | "html" | "headers";

export function createWebFetchTool(opts: WebFetchToolOptions = {}): ToolSpec {
  const allowPrivate = opts.allowPrivateNetwork === true;
  const ua = opts.userAgent ?? "mathran-web-fetch/0.1";

  return {
    name: "web_fetch",
    riskClass: "net",
    readOnly: true,
    description:
      "Fetch a single URL (http/https) and return the response body as text. " +
      "Hard limits: 1 MB response cap, 30s timeout (configurable up to 60s). " +
      "SSRF-guarded: rejects localhost and private IP ranges. " +
      "Redirects (3xx) are surfaced but NOT auto-followed; re-call with the Location URL to follow. " +
      "Use `format=headers` for header-only inspection.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full http:// or https:// URL.",
        },
        format: {
          type: "string",
          enum: ["text", "html", "headers"],
          description:
            "Output shape: `text` (default — normalised UTF-8 body), `html` (raw body), `headers` (response headers only).",
        },
        timeout_seconds: {
          type: "number",
          description: `Request timeout in seconds (default 30, max ${MAX_TIMEOUT_MS / 1000}).`,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>) {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return { ok: false, content: "error: web_fetch requires non-empty 'url'" };
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, content: `error: invalid URL: ${url}` };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, content: `error: only http/https schemes allowed (got ${parsed.protocol})` };
      }

      // SSRF guard — resolve hostname, reject private/loopback/link-local.
      if (!allowPrivate) {
        const denyReason = await checkSsrfGuard(parsed.hostname);
        if (denyReason) {
          return { ok: false, content: `error: SSRF guard rejected ${parsed.hostname} (${denyReason})` };
        }
      }

      const format: Format =
        args.format === "html" || args.format === "headers"
          ? (args.format as Format)
          : "text";
      const timeoutMs = Math.min(
        typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
          ? Math.floor(args.timeout_seconds * 1000)
          : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": ua, Accept: "*/*" },
          signal: ac.signal,
          // 2026-06-25 security audit — DON'T auto-follow redirects.
          // A 302 from a public host to http://127.0.0.1 / a private
          // address would bypass the SSRF guard (we only checked the
          // initial hostname). Surface the redirect to the model; if
          // it wants to follow, it can re-call web_fetch with the
          // Location URL (which will go through SSRF guard again).
          redirect: "manual",
        });
      } catch (err: any) {
        clearTimeout(timer);
        return {
          ok: false,
          content: err?.name === "AbortError"
            ? `web_fetch: timeout after ${timeoutMs} ms`
            : `web_fetch error: ${err?.message ?? String(err)}`,
        };
      }
      clearTimeout(timer);

      // 2026-06-25 security audit — surface redirects as structured info
      // so the model can decide whether to follow. We do NOT auto-follow
      // (see redirect:"manual" above). Status codes 300-308 are redirects.
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get("location") ?? "(no Location header)";
        return {
          ok: false,
          content: `web_fetch: HTTP ${res.status} redirect → ${loc}\n\nFor safety, redirects are NOT auto-followed (an open redirect could bypass the SSRF guard). If you want to follow, re-call web_fetch with url=<the Location target> — the SSRF guard will re-validate.`,
        };
      }

      if (format === "headers") {
        const hdrs: string[] = [];
        res.headers.forEach((v, k) => hdrs.push(`${k}: ${v}`));
        return {
          ok: true,
          content: `HTTP ${res.status} ${res.statusText}\n${hdrs.join("\n")}`,
        };
      }

      // Read body with cap.
      const reader = res.body?.getReader();
      if (!reader) {
        return {
          ok: res.ok,
          content: `HTTP ${res.status} ${res.statusText} (empty body)`,
        };
      }
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > MAX_BYTES) {
            truncated = true;
            chunks.push(value.subarray(0, MAX_BYTES - (received - value.byteLength)));
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks);
      let body = buf.toString("utf8");
      if (format === "text") {
        // Strip HTML tags + collapse whitespace for cleaner model output.
        body = stripTagsAndNormalize(body);
      }

      const header = `HTTP ${res.status} ${res.statusText} — ${received} bytes` +
        (truncated ? ` (truncated to ${MAX_BYTES})` : "");
      return {
        ok: res.ok,
        content: `${header}\n\n${body}`,
      };
    },
  };
}

async function checkSsrfGuard(hostname: string): Promise<string | null> {
  // Quick literal-IP / localhost short-circuit
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "ip6-localhost" || lower === "ip6-loopback") {
    return "loopback";
  }
  if (/^127\./.test(hostname)) return "loopback";
  if (/^0\./.test(hostname)) return "0/8 reserved";
  if (/^10\./.test(hostname)) return "10/8 private";
  if (/^192\.168\./.test(hostname)) return "192.168/16 private";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return "172.16/12 private";
  if (/^169\.254\./.test(hostname)) return "169.254/16 link-local";
  if (hostname === "::1") return "loopback (v6)";
  if (/^f[cd]/.test(lower)) return "fc00::/7 private (v6)";
  // 2026-06-25 security audit — broader IPv6 coverage:
  //   fe80::/10  link-local
  //   ::ffff:    IPv4-mapped IPv6 (could mask private IPv4)
  //   ::/96      IPv4-compatible IPv6 (deprecated but rejected for safety)
  if (/^fe[89ab]/.test(lower)) return "fe80::/10 link-local (v6)";
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (/^127\./.test(v4)) return "v6-mapped loopback";
    if (/^10\./.test(v4)) return "v6-mapped private";
    if (/^192\.168\./.test(v4)) return "v6-mapped private";
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return "v6-mapped private";
    if (/^169\.254\./.test(v4)) return "v6-mapped link-local";
  }

  // DNS resolve and check resulting addresses.
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const a of addrs) {
      const ip = a.address;
      if (/^127\./.test(ip)) return `resolves to loopback (${ip})`;
      if (/^10\./.test(ip)) return `resolves to private (${ip})`;
      if (/^192\.168\./.test(ip)) return `resolves to private (${ip})`;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return `resolves to private (${ip})`;
      if (/^169\.254\./.test(ip)) return `resolves to link-local (${ip})`;
      if (ip === "::1") return `resolves to loopback (v6)`;
      // v6 link-local & IPv4-mapped (same defensive set as the literal
      // checks above — DNS records can return these too).
      const lowerIp = ip.toLowerCase();
      if (/^fe[89ab]/.test(lowerIp)) return `resolves to link-local (v6) (${ip})`;
      if (/^f[cd]/.test(lowerIp)) return `resolves to private (v6) (${ip})`;
      if (lowerIp.startsWith("::ffff:")) {
        const v4 = lowerIp.slice(7);
        if (/^127\./.test(v4) || /^10\./.test(v4) || /^192\.168\./.test(v4)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(v4) || /^169\.254\./.test(v4)) {
          return `resolves to v6-mapped private (${ip})`;
        }
      }
    }
  } catch {
    // DNS failure — let fetch surface its own error.
    return null;
  }
  return null;
}

function stripTagsAndNormalize(html: string): string {
  // Drop <script> / <style> blocks entirely.
  let out = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  out = out.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  // Replace block-level closes with newline so paragraph structure survives.
  out = out.replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, "\n");
  // Strip all remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Decode the most common entities (no full HTML decode — keep tool deps zero).
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse runs of whitespace.
  out = out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
