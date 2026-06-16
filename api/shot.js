/**
 * /api/shot — render a URL to a PNG screenshot, for the Telemachus agent's vision.
 *
 * The agent's Daytona sandbox has no direct egress and no headless browser, so it
 * asks this Vercel endpoint to render a page. We delegate the actual rendering to a
 * keyless screenshot service (default: microlink) and stream the PNG back. The
 * service is configurable via the SHOT_TEMPLATE env var ({url} = encoded target,
 * {full} = "true"/"false") so you can swap providers or point at a paid renderer
 * without code changes.
 *
 *   GET  /api/shot?url=<encoded>[&full=1]
 *   POST /api/shot   {url, full_page}
 */
const DEFAULT_TEMPLATE =
  process.env.SHOT_TEMPLATE ||
  "https://api.microlink.io/?url={url}&screenshot=true&meta=false&embed=screenshot.url&fullPage={full}";

function isBlockedHost(hostname) {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

async function readJsonBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : String(req.body));
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, "http://x");
  let targetRaw = reqUrl.searchParams.get("url") || "";
  let full = reqUrl.searchParams.get("full") === "1" || reqUrl.searchParams.get("full") === "true";

  if (req.method === "POST" || req.method === "PUT") {
    const j = await readJsonBody(req);
    targetRaw = j.url || targetRaw;
    if (j.full_page != null) full = !!j.full_page;
  }

  if (!targetRaw) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "missing 'url'" }));
    return;
  }

  let target;
  try {
    target = new URL(targetRaw);
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid url", url: targetRaw }));
    return;
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || isBlockedHost(target.hostname)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "blocked or non-http(s) url", url: targetRaw }));
    return;
  }

  const renderUrl = DEFAULT_TEMPLATE.replace("{url}", encodeURIComponent(target.toString())).replace(
    "{full}",
    full ? "true" : "false"
  );

  try {
    const upstream = await fetch(renderUrl, {
      redirect: "follow",
      headers: { Accept: "image/png,image/*,*/*", "User-Agent": "TelemachusShot/1.0" },
    });
    const ct = upstream.headers.get("content-type") || "";
    const buf = Buffer.from(await upstream.arrayBuffer());
    // If the renderer returned an image, stream it. Otherwise surface the error JSON/text.
    if (upstream.ok && ct.startsWith("image/")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    } else {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "screenshot_render_failed",
          renderStatus: upstream.status,
          contentType: ct,
          detail: buf.toString("utf-8").slice(0, 400),
        })
      );
    }
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "shot_proxy_failed", detail: String((err && err.message) || err) }));
  }
};
