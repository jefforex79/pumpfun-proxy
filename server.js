const express = require("express");
const rateLimit = require("express-rate-limit");

// node-fetch v3 is ESM-only; in CommonJS, use dynamic import
const fetch = async (...args) => {
  const mod = await import("node-fetch");
  return mod.default(...args);
};

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

const PUMPFUN_UPSTREAM =
  process.env.PUMPFUN_UPSTREAM ||
  "https://client-api-2-74b1891ee9f9.herokuapp.com/coins/advanced";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 3000);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";

// cache: Map<cacheKey, { expiresAt:number, payload:any, status:number }>
const cache = new Map();

function makeCacheKey(req) {
  const url = new URL(req.originalUrl, `http://localhost:${PORT}`);
  return `${req.path}?${url.searchParams.toString()}`;
}

function setCache(key, value) {
  cache.set(key, value);
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 120),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// CORS (no credentials)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Proxy-Key"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).send();
  next();
});

function requireProxyKey(req, res, next) {
  if (!PROXY_API_KEY) return next();
  const got = req.header("X-Proxy-Key") || "";
  if (got !== PROXY_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized proxy key" });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cacheTtlMs: CACHE_TTL_MS,
    upstream: PUMPFUN_UPSTREAM,
    time: new Date().toISOString()
  });
});

app.get("/pumpfun/coins/advanced", requireProxyKey, async (req, res) => {
  const limit = req.query.limit || "50";
  const offset = req.query.offset || "0";

  const upstreamUrl = new URL(PUMPFUN_UPSTREAM);
  upstreamUrl.searchParams.set("limit", String(limit));
  upstreamUrl.searchParams.set("offset", String(offset));

  const cacheKey = makeCacheKey(req);
  const now = Date.now();

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    res.setHeader("X-Cache", "HIT");
    return res.status(cached.status).json(cached.payload);
  }

  try {
    const t0 = Date.now();
    const upstreamResp = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "pumpfun-proxy/1.0 (+dashboard)",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      },
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 10000))
    });

    const latencyMs = Date.now() - t0;
    const text = await upstreamResp.text();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON",
        upstreamStatus: upstreamResp.status,
        latencyMs,
        bodySnippet: text.slice(0, 500)
      });
    }

    setCache(cacheKey, {
      expiresAt: now + CACHE_TTL_MS,
      payload,
      status: upstreamResp.status
    });

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Upstream-Status", String(upstreamResp.status));
    res.setHeader("X-Upstream-Latency-Ms", String(latencyMs));
    return res.status(upstreamResp.status).json(payload);
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: "Proxy fetch failed",
      details: err?.message || String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`pumpfun-proxy listening on :${PORT}`);
});
