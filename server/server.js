/**
 * Sakura Dash — backend
 * Plain Node.js (no Express, no frameworks). Talks to Supabase's
 * PostgREST API directly over https using the built-in https module.
 *
 * Routes:
 *   GET  /api/scores?limit=10   -> top N scores, highest first
 *   POST /api/scores            -> { name, score } create a new score row
 *   GET  /*                     -> static files from ../public
 *
 * Env vars (see .env.example):
 *   SUPABASE_URL              e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY service role key (server-side only, never expose to client)
 *   PORT                      defaults to 3000
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

loadDotEnvIfPresent();

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "scores";

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ---------------------------------------------------------
 * tiny .env loader (so we don't need the `dotenv` package)
 * --------------------------------------------------------- */
function loadDotEnvIfPresent() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/* ---------------------------------------------------------
 * Supabase REST helper (PostgREST) over plain https
 * --------------------------------------------------------- */
function supabaseRequest({ method, pathAndQuery, body, extraHeaders }) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      reject(new Error("Supabase is not configured on the server (missing env vars)."));
      return;
    }

    const base = new URL(SUPABASE_URL);
    const options = {
      hostname: base.hostname,
      path: `/rest/v1${pathAndQuery}`,
      method,
      headers: Object.assign(
        {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
        extraHeaders || {}
      ),
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`Supabase error ${res.statusCode}: ${JSON.stringify(parsed)}`));
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getTopScores(limit) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  // order by score desc, then oldest-first as tiebreak; select only public-safe columns
  const query = `/${TABLE}?select=name,score,created_at&order=score.desc,created_at.asc&limit=${safeLimit}`;
  const rows = await supabaseRequest({ method: "GET", pathAndQuery: query });
  return Array.isArray(rows) ? rows : [];
}

async function insertScore(name, score) {
  const body = [{ name, score }];
  const rows = await supabaseRequest({
    method: "POST",
    pathAndQuery: `/${TABLE}`,
    body,
    extraHeaders: { Prefer: "return=representation" },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

/* ---------------------------------------------------------
 * Validation
 * --------------------------------------------------------- */
function validateScorePayload(payload) {
  if (!payload || typeof payload !== "object") return "Missing request body.";
  const { name, score } = payload;
  if (typeof name !== "string" || !name.trim()) return "Name is required.";
  if (name.trim().length > 12) return "Name must be 12 characters or fewer.";
  if (!/^[A-Za-z0-9_\- ]+$/.test(name.trim())) return "Name has unsupported characters.";
  if (typeof score !== "number" || !Number.isFinite(score)) return "Score must be a number.";
  if (score < 0 || score > 1_000_000) return "Score out of allowed range.";
  return null;
}

/* ---------------------------------------------------------
 * Static file serving (no framework)
 * --------------------------------------------------------- */
function serveStatic(req, res, urlPath) {
  let safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  if (safePath === "/" || safePath === "") safePath = "/index.html";

  const filePath = path.join(PUBLIC_DIR, safePath);

  // prevent path traversal outside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-style fallback to index.html for unknown routes
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not found");
        } else {
          res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
          res.end(indexData);
        }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------------------------------------------------
 * Request body reader
 * --------------------------------------------------------- */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    const MAX_BYTES = 10_000; // small payload, plenty for {name, score}
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*", // same-origin in production; relax for local dev convenience
  });
  res.end(body);
}

/* ---------------------------------------------------------
 * Very small in-memory rate limiter (per IP) for POST /api/scores
 * Not meant to replace real infra (e.g. a WAF) — just stops accidental
 * spam/double-submits without needing a package.
 * --------------------------------------------------------- */
const recentPosts = new Map(); // ip -> timestamp[]
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip) {
  const now = Date.now();
  const history = (recentPosts.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  history.push(now);
  recentPosts.set(ip, history);
  return history.length > RATE_LIMIT_MAX;
}

/* ---------------------------------------------------------
 * Server
 * --------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = parsedUrl;

  // CORS preflight (harmless to include even for same-origin deployments)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    if (pathname === "/api/scores" && req.method === "GET") {
      const limit = parsedUrl.searchParams.get("limit") || "10";
      const scores = await getTopScores(limit);
      sendJson(res, 200, { scores });
      return;
    }

    if (pathname === "/api/scores" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "unknown";
      if (isRateLimited(ip)) {
        sendJson(res, 429, { error: "Too many submissions — slow down a little." });
        return;
      }

      const payload = await readJsonBody(req);
      const error = validateScorePayload(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }

      const row = await insertScore(payload.name.trim(), Math.floor(payload.score));
      sendJson(res, 201, { saved: row });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Unknown API route." });
      return;
    }

    // everything else: static assets
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Sakura Dash server running at http://localhost:${PORT}`);
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn(
      "⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — /api/scores will fail until configured (see server/.env.example)."
    );
  }
});
