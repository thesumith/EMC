/**
 * Cloudflare Worker — proxies medicines.org.uk for the EMC iframe viewer.
 *
 * Deploy (free):
 *   1. Create a Cloudflare account → Workers & Pages → Create Worker
 *   2. Paste this file's contents → Deploy
 *   3. Copy your worker URL (e.g. https://emc-proxy.YOUR_NAME.workers.dev)
 *   4. Put that URL in config.js → push to GitHub Pages
 *
 * Local dev:  npx wrangler dev
 */

const TARGET = "https://www.medicines.org.uk";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BLOCKED_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);

const BLOCKED_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
]);

const TARGET_BLANK_RE = /\s+target\s*=\s*("|'|)\s*_blank\s*\1/gi;
const ABS_HOST_RE = /https?:\/\/(?:www\.)?medicines\.org\.uk/gi;
const PROTO_HOST_RE = /\/\/(?:www\.)?medicines\.org\.uk/gi;

function rewriteLocation(value, workerOrigin) {
  try {
    const parsed = new URL(value, TARGET);
    if (
      parsed.hostname === "www.medicines.org.uk" ||
      parsed.hostname === "medicines.org.uk"
    ) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    if (value.startsWith("/")) {
      return value;
    }
  } catch (_) {
    /* keep original */
  }
  return value;
}

function rewriteHtml(text) {
  return text
    .replace(TARGET_BLANK_RE, "")
    .replace(ABS_HOST_RE, "")
    .replace(PROTO_HOST_RE, "");
}

function buildUpstreamHeaders(request) {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (BLOCKED_REQUEST.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set("Host", "www.medicines.org.uk");
  headers.set("User-Agent", USER_AGENT);
  return headers;
}

function buildResponseHeaders(upstream, workerOrigin) {
  const headers = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (BLOCKED_RESPONSE.has(lower)) continue;
    if (lower === "location") {
      headers.set(key, rewriteLocation(value, workerOrigin));
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function proxyRequest(request) {
  const url = new URL(request.url);
  const upstreamUrl = TARGET + url.pathname + url.search;

  const init = {
    method: request.method,
    headers: buildUpstreamHeaders(request),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(upstreamUrl, init);
  const ctype = (upstream.headers.get("content-type") || "").toLowerCase();
  const workerOrigin = url.origin;

  if (
    request.method !== "HEAD" &&
    (ctype.includes("text/html") || ctype.includes("application/xhtml"))
  ) {
    const text = await upstream.text();
    const body = rewriteHtml(text);
    const headers = buildResponseHeaders(upstream, workerOrigin);
    headers.delete("content-length");
    return new Response(body, { status: upstream.status, headers });
  }

  if (request.method === "HEAD") {
    const headers = buildResponseHeaders(upstream, workerOrigin);
    return new Response(null, { status: upstream.status, headers });
  }

  const headers = buildResponseHeaders(upstream, workerOrigin);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    try {
      return await proxyRequest(request);
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
  },
};
