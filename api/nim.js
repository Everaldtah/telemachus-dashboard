/**
 * /api/nim/* — transparent reverse proxy to NVIDIA NIM (https://integrate.api.nvidia.com/v1).
 *
 * Why: the Telemachus bot runs in a Daytona EU sandbox whose egress RESETS connections to
 * integrate.api.nvidia.com (verified — HTTP 000 in ~8ms). Vercel Functions run WITH NVIDIA
 * egress AND are reachable from the Daytona host (200), so the bot points its NVIDIA base URL
 * at this proxy and NIM works from the cloud.
 *
 * Routing: vercel.json rewrites `/api/nim/:path*` to this single function and passes the
 * upstream sub-path in the `__p` query param (a no-framework catch-all `[...path].js` only
 * matched a single segment here, so we capture the path explicitly instead).
 *
 * Model-agnostic: forwards ANY path under /v1, ANY model, the caller's Authorization
 * (nvapi- key), remaining query params, and body verbatim, then streams the upstream response
 * back (JSON or SSE). Stateless/keyless by default — caller supplies the key; NVIDIA_API_KEY
 * in the Vercel env is used only as a fallback when no Authorization header is sent.
 *
 *   GET  /api/nim/models            -> GET  https://integrate.api.nvidia.com/v1/models
 *   POST /api/nim/chat/completions  -> POST https://integrate.api.nvidia.com/v1/chat/completions
 */
const NIM_BASE = "https://integrate.api.nvidia.com/v1";
const FALLBACK_KEY = process.env.NVIDIA_API_KEY || "";

module.exports = async (req, res) => {
  const u = new URL(req.url, "http://x");
  // Sub-path comes from the rewrite (__p); fall back to stripping the /api/nim prefix.
  let sub = u.searchParams.get("__p") || u.pathname.replace(/^\/api\/nim\/?/, "");
  sub = sub.replace(/^\/+/, "");
  // Preserve any other query params (drop our internal __p).
  u.searchParams.delete("__p");
  const qs = u.searchParams.toString();
  const target = `${NIM_BASE}/${sub}${qs ? `?${qs}` : ""}`;

  const headers = {};
  const auth = req.headers["authorization"] || (FALLBACK_KEY ? `Bearer ${FALLBACK_KEY}` : "");
  if (auth) headers["Authorization"] = auth;
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  if (req.headers["accept"]) headers["Accept"] = req.headers["accept"];

  // Vercel's Node runtime parses JSON bodies into req.body; re-serialize for forwarding.
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
    const rct = upstream.headers.get("content-type");
    if (rct) res.setHeader("Content-Type", rct);
    res.setHeader("Cache-Control", "no-store");

    if (upstream.body && typeof upstream.body.getReader === "function") {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "nim_proxy_failed", target, detail: String((err && err.message) || err) }));
  }
};
