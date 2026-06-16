/**
 * /api/fetch — generic HTTP(S) reverse proxy that gives the Daytona-sandboxed
 * Telemachus agent GENERAL internet access.
 *
 * Why: the Telemachus bot (and the agent it drives) runs in a Daytona EU sandbox
 * whose outbound egress RESETS TCP to most public hosts (verified: NVIDIA NIM,
 * google.com, moltbook.com → "Connection reset by peer", HTTP 000). Vercel
 * Functions have full internet egress AND are reachable from the Daytona host, so
 * the agent routes web reads / HTTP-API calls through this proxy instead of curling
 * directly.
 *
 * Contract (two equivalent forms):
 *   GET  /api/fetch?url=<encoded>                 → GET that URL, stream body back
 *   POST /api/fetch   {url, method, headers, body} → arbitrary method/headers/body
 * The proxy reflects the UPSTREAM status code and streams the upstream body back
 * verbatim, so plain `curl` and a structured tool both work.
 *
 * Safety: only http/https; blocks loopback, link-local, cloud-metadata and RFC-1918
 * private ranges (basic SSRF guard — this endpoint is public). Caps body size.
 */
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on proxied responses

function isBlockedHost(hostname) {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  // IPv4 literal → check private / loopback / link-local / metadata ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 unique-local / link-local.
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

function parseTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "invalid url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "only http/https allowed" };
  if (isBlockedHost(url.hostname)) return { error: `blocked host: ${url.hostname}` };
  return { url };
}

async function readJsonBody(req) {
  if (req.body != null) {
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    try {
      return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : String(req.body));
    } catch {
      return {};
    }
  }
  return {};
}

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, "http://x");

  let targetRaw = reqUrl.searchParams.get("url") || "";
  let method = (reqUrl.searchParams.get("method") || "").toUpperCase();
  let extraHeaders = {};
  let fwdBody;

  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const j = await readJsonBody(req);
    targetRaw = j.url || targetRaw;
    method = (j.method || method || "GET").toUpperCase();
    if (j.headers && typeof j.headers === "object") extraHeaders = j.headers;
    if (j.body != null) fwdBody = typeof j.body === "string" ? j.body : JSON.stringify(j.body);
  }
  if (!method) method = "GET";

  if (!targetRaw) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "missing 'url' (query param or JSON body)" }));
    return;
  }

  const parsed = parseTarget(targetRaw);
  if (parsed.error) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: parsed.error, url: targetRaw }));
    return;
  }

  // Build forwarded headers: a browser-ish default UA + Accept, plus any caller extras.
  const headers = {
    "User-Agent":
      extraHeaders["User-Agent"] ||
      extraHeaders["user-agent"] ||
      "Mozilla/5.0 (compatible; TelemachusProxy/1.0; +https://telemachus-dashboard.vercel.app)",
    Accept: extraHeaders["Accept"] || extraHeaders["accept"] || "*/*",
  };
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v == null) continue;
    headers[k] = String(v);
  }

  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD" && fwdBody != null) init.body = fwdBody;

  try {
    const upstream = await fetch(parsed.url.toString(), init);
    res.statusCode = upstream.status;
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.setHeader("X-Proxy-Status", String(upstream.status));
    res.setHeader("X-Proxy-Url", parsed.url.toString());
    res.setHeader("Cache-Control", "no-store");

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf.length > MAX_BYTES ? buf.subarray(0, MAX_BYTES) : buf);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ error: "fetch_proxy_failed", url: parsed.url.toString(), detail: String((err && err.message) || err) })
    );
  }
};
