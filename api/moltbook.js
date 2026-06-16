/**
 * /api/moltbook/* — authenticated reverse proxy to Moltbook (https://www.moltbook.com/api/v1).
 *
 * Moltbook is the social network for AI agents. Two problems this solves:
 *  1. The Telemachus agent's Daytona EU sandbox can't reach moltbook.com (egress reset).
 *  2. Moltbook's #1 security rule: the API key must ONLY ever be sent to www.moltbook.com.
 *
 * So this endpoint injects the key SERVER-SIDE from the Vercel env (MOLTBOOK_API_KEY) and
 * forwards ONLY to https://www.moltbook.com/api/v1/*. The agent/sandbox never sees the key,
 * and the key never transits any host other than Moltbook. The caller's own Authorization
 * header is ignored (the agent must never carry the key).
 *
 * Routing: vercel.json rewrites `/api/moltbook/:path*` → this function with the upstream
 * sub-path in `__p` (same trick as api/nim.js).
 *
 *   GET  /api/moltbook/home                 -> GET  .../api/v1/home
 *   POST /api/moltbook/posts  {json}        -> POST .../api/v1/posts
 *   POST /api/moltbook/verify {json}        -> POST .../api/v1/verify
 */
const MOLTBOOK_BASE = "https://www.moltbook.com/api/v1";
const API_KEY = process.env.MOLTBOOK_API_KEY || "";

module.exports = async (req, res) => {
  const u = new URL(req.url, "http://x");
  let sub = u.searchParams.get("__p") || u.pathname.replace(/^\/api\/moltbook\/?/, "");
  sub = sub.replace(/^\/+/, "").replace(/^api\/v1\/?/, ""); // tolerate callers that prefix api/v1
  u.searchParams.delete("__p");
  const qs = u.searchParams.toString();
  const target = `${MOLTBOOK_BASE}/${sub}${qs ? `?${qs}` : ""}`;

  if (!API_KEY) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "moltbook_key_unset", hint: "Set MOLTBOOK_API_KEY in the Vercel project env." }));
    return;
  }

  // Key is injected here and ONLY here — never accepted from the caller.
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  headers["Accept"] = req.headers["accept"] || "application/json";

  let body;
  if (req.method !== "GET" && req.method !== "HEAD" && req.body != null) {
    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
  }

  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    res.statusCode = upstream.status;
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    // Pass through rate-limit headers so the agent can budget requests.
    for (const h of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "no-store");
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "moltbook_proxy_failed", detail: String((err && err.message) || err) }));
  }
};
