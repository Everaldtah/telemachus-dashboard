/**
 * /api/state — same-origin bridge between the browser dashboard and the Telemachus
 * host sandbox. Reads the per-session swarm event log (~/swarm/<session>.jsonl) from
 * the always-on Daytona host sandbox via the Daytona toolbox exec API, and returns
 * the NEW lines since the client's cursor. The browser never talks to Daytona
 * directly, so there is no CORS / preview-token friction and the Daytona key stays
 * server-side.
 *
 * Query: ?s=<session>&cursor=<lineCount>
 * Returns: { cursor, events:[…], host } — events are parsed JSON objects.
 */
const API = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
const KEY = process.env.DAYTONA_API_KEY || "";

let hostCache = { id: null, at: 0 };

async function daytona(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`daytona ${res.status} ${method} ${path}: ${text.slice(0, 160)}`);
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function hostId() {
  if (hostCache.id && Date.now() - hostCache.at < 30000) return hostCache.id;
  const list = await daytona("GET", "/sandbox");
  const arr = Array.isArray(list) ? list : list.items || list.sandboxes || [];
  const host = arr.find((s) => s.labels && s.labels.role === "host" && s.state === "started")
    || arr.find((s) => s.labels && s.labels.role === "host");
  if (!host) throw new Error("no telemachus host sandbox found");
  hostCache = { id: host.id, at: Date.now() };
  return host.id;
}

async function exec(id, command, timeoutS = 20) {
  const r = await daytona("POST", `/toolbox/${id}/toolbox/process/execute`, { command, timeout: timeoutS });
  return { code: typeof r.exitCode === "number" ? r.exitCode : null, out: String(r.result ?? "") };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const url = new URL(req.url, "http://x");
    const session = String(url.searchParams.get("s") || "");
    const cursor = Math.max(0, parseInt(url.searchParams.get("cursor") || "0", 10) || 0);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid session" }));
    }
    if (!KEY) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: "DAYTONA_API_KEY not configured" }));
    }
    const id = await hostId();
    // Print new lines since `cursor`. File-not-yet-created → empty (2>/dev/null).
    const r = await exec(id, `tail -n +${cursor + 1} "$HOME/swarm/${session}.jsonl" 2>/dev/null || true`, 20);
    const rawLines = r.out.split("\n").filter((l) => l.trim().length);
    const events = [];
    for (const line of rawLines) {
      try { events.push(JSON.parse(line)); } catch { /* skip partial line */ }
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ cursor: cursor + rawLines.length, events, host: id }));
  } catch (err) {
    res.statusCode = 200; // soft-fail so the client keeps polling
    res.end(JSON.stringify({ cursor: Math.max(0, parseInt(new URL(req.url, "http://x").searchParams.get("cursor") || "0", 10) || 0), events: [], error: String(err.message || err) }));
  }
};
