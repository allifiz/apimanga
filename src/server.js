import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Database from 'better-sqlite3';

const app = Fastify({ logger: true });
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4000);
const upstreamBaseUrl = trimSlash(process.env.SANKA_BASE_URL || 'https://www.sankavollerei.web.id');
const provider = process.env.SANKA_PROVIDER || 'bacakomik';
const maxUpstreamPerMinute = Number(process.env.SANKA_MAX_REQUESTS_PER_MINUTE || 30);
const timeoutMs = Number(process.env.SANKA_TIMEOUT_MS || 15000);
const dbPath = process.env.CACHE_DB_PATH || './data/cache.sqlite';

const ttl = {
  latest: Number(process.env.TTL_LATEST || 600),
  popular: Number(process.env.TTL_POPULAR || 3600),
  top: Number(process.env.TTL_TOP || 3600),
  recommended: Number(process.env.TTL_RECOMMENDED || 3600),
  genres: Number(process.env.TTL_GENRES || 86400),
  genre: Number(process.env.TTL_GENRE || 3600),
  search: Number(process.env.TTL_SEARCH || 1800),
  detail: Number(process.env.TTL_DETAIL || 21600),
  chapter: Number(process.env.TTL_CHAPTER || 604800),
};

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS cache_entries (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, status_code INTEGER NOT NULL DEFAULT 200, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
db.exec('CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache_entries(expires_at)');

const getCache = db.prepare('SELECT payload, status_code, created_at, expires_at FROM cache_entries WHERE cache_key = ?');
const setCache = db.prepare('INSERT INTO cache_entries (cache_key, payload, status_code, created_at, expires_at) VALUES (@cacheKey, @payload, @statusCode, @createdAt, @expiresAt) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, status_code = excluded.status_code, created_at = excluded.created_at, expires_at = excluded.expires_at');
const cleanCache = db.prepare('DELETE FROM cache_entries WHERE expires_at < ?');

await app.register(cors, { origin: true });
await app.register(rateLimit, {
  max: Number(process.env.PUBLIC_RATE_LIMIT_MAX || 120),
  timeWindow: process.env.PUBLIC_RATE_LIMIT_WINDOW || '1 minute',
});

let upstreamQueue = Promise.resolve();
const upstreamHits = [];

app.get('/', async () => ({ name: 'apimanga', status: 'ok', upstream: upstreamBaseUrl, provider }));
app.get('/health', async () => ({ ok: true, uptime: process.uptime(), now: new Date().toISOString() }));
app.get('/cache/stats', async () => cacheStats());

app.get('/comic/latest', async (req, reply) => proxy(reply, 'latest', ttl.latest, route('latest'), req.query.refresh));
app.get('/comic/popular', async (req, reply) => proxy(reply, 'popular', ttl.popular, route('populer'), req.query.refresh));
app.get('/comic/top', async (req, reply) => proxy(reply, 'top', ttl.top, route('top'), req.query.refresh));
app.get('/comic/recommended', async (req, reply) => proxy(reply, 'recommended', ttl.recommended, route('recomen'), req.query.refresh));
app.get('/comic/genres', async (req, reply) => proxy(reply, 'genres', ttl.genres, route('genres'), req.query.refresh));

app.get('/comic/search', async (req, reply) => {
  const q = String(req.query.q || req.query.query || '').trim();
  if (!q) return reply.code(400).send({ error: 'Query parameter q is required' });
  return proxy(reply, `search:${q.toLowerCase()}`, ttl.search, route(`search/${encodeURIComponent(q)}`), req.query.refresh);
});

app.get('/comic/genre/:slug', async (req, reply) => proxy(reply, `genre:${req.params.slug}`, ttl.genre, route(`genre/${encodeURIComponent(req.params.slug)}`), req.query.refresh));
app.get('/comic/detail/:slug', async (req, reply) => proxy(reply, `detail:${req.params.slug}`, ttl.detail, route(`detail/${encodeURIComponent(req.params.slug)}`), req.query.refresh));
app.get('/comic/chapter/:slug', async (req, reply) => proxy(reply, `chapter:${req.params.slug}`, ttl.chapter, route(`chapter/${encodeURIComponent(req.params.slug)}`), req.query.refresh));

app.get('/comic/only/:type', async (req, reply) => {
  const type = String(req.params.type || '').toLowerCase();
  if (!['manga', 'manhwa', 'manhua'].includes(type)) return reply.code(400).send({ error: 'Type must be manga, manhwa, or manhua' });
  return proxy(reply, `only:${type}`, ttl.genre, route(`only/${type}`), req.query.refresh);
});

async function proxy(reply, key, ttlSeconds, upstreamPath, refresh) {
  const current = now();
  const cached = getCache.get(key);
  const force = refresh === '1' || refresh === 'true';
  reply.header('x-cache-key', key);

  if (!force && cached && cached.expires_at > current) {
    reply.header('x-cache', 'HIT');
    return reply.code(cached.status_code).send(JSON.parse(cached.payload));
  }

  try {
    const payload = await enqueue(() => fetchJson(upstreamPath));
    const createdAt = now();
    setCache.run({ cacheKey: key, payload: JSON.stringify(payload), statusCode: 200, createdAt, expiresAt: createdAt + ttlSeconds });
    reply.header('x-cache', cached ? 'STALE-REFRESHED' : 'MISS');
    reply.header('x-upstream', 'sanka');
    return reply.send(payload);
  } catch (error) {
    if (cached) {
      reply.header('x-cache', 'STALE-FALLBACK');
      return reply.code(cached.status_code).send(JSON.parse(cached.payload));
    }
    return reply.code(502).send({ error: error.message || 'Upstream error' });
  }
}

function enqueue(task) {
  const run = upstreamQueue.then(async () => {
    await waitSlot();
    return task();
  });
  upstreamQueue = run.catch(() => undefined);
  return run;
}

async function waitSlot() {
  const windowMs = 60000;
  while (true) {
    const current = Date.now();
    while (upstreamHits.length && current - upstreamHits[0] > windowMs) upstreamHits.shift();
    if (upstreamHits.length < maxUpstreamPerMinute) {
      upstreamHits.push(current);
      return;
    }
    await sleep(Math.max(250, windowMs - (current - upstreamHits[0]) + 25));
  }
}

async function fetchJson(upstreamPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${upstreamBaseUrl}${upstreamPath}`, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'apimanga-proxy-cache/1.0' },
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function cacheStats() {
  cleanCache.run(now());
  const total = db.prepare('SELECT COUNT(*) AS count FROM cache_entries').get().count;
  const expired = db.prepare('SELECT COUNT(*) AS count FROM cache_entries WHERE expires_at < ?').get(now()).count;
  return { total, expired, active: total - expired };
}

function route(segment) {
  return `/comic/${provider}/${segment}`;
}
function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}
function now() {
  return Math.floor(Date.now() / 1000);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.listen({ host, port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
