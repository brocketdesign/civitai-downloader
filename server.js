const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

// Load .env when one is present (Railway injects real env vars instead).
try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const { BRAND, API_ORIGIN } = require('./lib/brand');
const store = require('./lib/store');
const { mintQuietly } = require('./lib/mint');
const seo = require('./lib/seo');

const app = express();
const PORT = process.env.PORT || 3456;
const CIVITAI_API = 'https://civitai.com/api/v1';

// SITE_URL is the origin this app is served from once it is online; canonical
// and Open Graph URLs are built from it. Unset, we fall back to the request
// host, which is right locally but wrong behind a proxy.
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

app.use(express.json({ limit: '1mb' }));

// ---- HTML pages (templated, so they can carry absolute SEO URLs) ----

const PAGES = { '/': 'index.html', '/gallery': 'gallery.html' };

function siteUrl(req) {
  return SITE_URL || `${req.protocol}://${req.get('host')}`;
}

function renderPage(req, file) {
  const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  return html
    .replaceAll('{{SITE_URL}}', siteUrl(req))
    .replaceAll('{{BRAND_NAME}}', BRAND.name)
    .replaceAll('{{BRAND_URL}}', BRAND.url)
    .replaceAll('{{BRAND_LOGIN_URL}}', BRAND.loginUrl)
    .replaceAll('{{BRAND_LOGO}}', BRAND.logo)
    .replaceAll('{{BRAND_TAGLINE}}', BRAND.tagline);
}

for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => {
    try {
      res.type('html').send(renderPage(req, file));
    } catch (err) {
      console.error(`[page ${route}]`, err.message);
      res.status(500).send('Page unavailable');
    }
  });
}

// index:false so the templated '/' above wins over the raw file on disk.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Disallow: /api/\n' +
    'Disallow: /gallery\n' +
    `\nSitemap: ${siteUrl(req)}/sitemap.xml\n`
  );
});

/* ---- Search-minted SEO pages ----
 *
 * Nothing here is authored by hand. A creator or model page exists because a
 * visitor searched for it, and becomes indexable once it has enough real
 * content to be worth a crawl (see seo.MIN_ITEMS). Below that threshold the
 * page still renders for anyone who follows a link, but ships noindex and stays
 * out of the sitemap.
 */

function seoRoute(handler) {
  return async (req, res) => {
    try {
      const db = await store.getDb();
      if (!db) return res.status(503).type('html').send(notFound('Pages are warming up. Try again shortly.'));
      const html = await handler(db, siteUrl(req), req);
      if (!html) return res.status(404).type('html').send(notFound('Nothing indexed under that name yet.'));
      res.type('html').send(html);
    } catch (err) {
      console.error(`[seo ${req.path}]`, err.message);
      res.status(500).type('html').send(notFound('That page could not be built.'));
    }
  };
}

function notFound(message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>Not found</title><meta name="robots" content="noindex, follow" />` +
    `<link rel="stylesheet" href="/style.css" /></head><body><main class="page">` +
    `<section class="panel"><div class="panel-head"><h2>Not found</h2></div>` +
    `<p class="panel-note">${message}</p>` +
    `<div class="modal-actions"><a class="btn btn-primary" href="/">Search for a creator</a></div>` +
    `</section></main></body></html>`;
}

app.get('/creators', seoRoute((db, site) => seo.creatorIndex(db, site)));
app.get('/models',   seoRoute((db, site) => seo.modelIndex(db, site)));

app.get('/creator/:username', seoRoute((db, site, req) =>
  seo.creatorPage(db, site, req.params.username)));

app.get('/model/:slug', seoRoute((db, site, req) =>
  seo.modelPage(db, site, 'checkpoint', req.params.slug)));

app.get('/lora/:slug', seoRoute((db, site, req) =>
  seo.modelPage(db, site, 'lora', req.params.slug)));

// The sitemap is derived from the corpus rather than maintained alongside it,
// so it cannot list a page that would not render. Cached briefly because the
// aggregation grows with the database.
let sitemapCache = { xml: null, at: 0 };
const SITEMAP_TTL = 15 * 60 * 1000;

app.get('/sitemap.xml', async (req, res) => {
  const root = siteUrl(req);
  const statics =
    `  <url><loc>${root}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
    `  <url><loc>${root}/creators</loc><changefreq>daily</changefreq><priority>0.6</priority></url>\n` +
    `  <url><loc>${root}/models</loc><changefreq>daily</changefreq><priority>0.6</priority></url>\n`;

  let dynamic = '';
  try {
    if (Date.now() - sitemapCache.at < SITEMAP_TTL && sitemapCache.xml !== null) {
      dynamic = sitemapCache.xml;
    } else {
      const db = await store.getDb();
      if (db) {
        const urls = await seo.sitemapUrls(db);
        dynamic = urls.map(u =>
          `  <url><loc>${root}${u.loc}</loc>` +
          (u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : '') +
          `<priority>${u.priority}</priority></url>`
        ).join('\n') + (urls.length ? '\n' : '');
        sitemapCache = { xml: dynamic, at: Date.now() };
      }
    }
  } catch (err) {
    console.error('[sitemap]', err.message);   // still serve the static entries
  }

  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    statics + dynamic +
    '</urlset>\n'
  );
});

// ---- Civit.ai API proxy ----

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function civitaiFetch(endpoint, apiKey, retries = 3) {
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const url = `${CIVITAI_API}${endpoint}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (networkErr) {
      if (attempt === retries) throw Object.assign(new Error(`Network error: ${networkErr.message}`), { status: 503 });
      console.warn(`[retry ${attempt}/${retries}] network error: ${networkErr.message}`);
      await sleep(attempt * 1000);
      continue;
    }

    if (res.ok) return res.json();

    // 5xx = transient server error → retry with backoff
    if (res.status >= 500 && attempt < retries) {
      const body = await res.text().catch(() => '');
      console.warn(`[retry ${attempt}/${retries}] HTTP ${res.status}: ${body.slice(0, 80)}`);
      await sleep(attempt * 1500);
      continue;
    }

    // 4xx or final 5xx → throw with real status
    const body = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Civit.ai API ${res.status}: ${res.statusText}${body ? ' — ' + body.slice(0, 120) : ''}`),
      { status: res.status }
    );
  }
}

// GET /api/images — proxy to Civit.ai images endpoint
app.get('/api/images', async (req, res) => {
  try {
    const { username, type, sort, cursor, limit = 100, apiKey, nsfw } = req.query;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const params = new URLSearchParams({
      username: username.trim(),
      limit: Math.min(Number(limit) || 100, 200),
      sort: sort || 'Newest',
    });
    if (type && type !== 'all') params.set('type', type);
    if (cursor != null && cursor !== '') params.set('cursor', cursor);
    if (nsfw === 'true') params.set('nsfw', 'true');

    const data = await civitaiFetch(`/images?${params}`, apiKey);

    // Every search feeds the SEO corpus. Safe-for-work items only, and never
    // awaited — a slow or broken store must not slow down a search.
    mintQuietly(data.items);

    const meta = data.metadata || {};
    console.log('[civitai] sort:', sort, '| cursor in:', cursor || '(none)', '| items:', (data.items||[]).length, '| nextCursor:', meta.nextCursor, '| nextPage:', meta.nextPage ? meta.nextPage.slice(0, 80) : null);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/images]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Token-bucket throttle ----

class TokenBucket {
  constructor(bytesPerSec) {
    this.rate      = bytesPerSec; // 0 = unlimited
    this.tokens    = bytesPerSec;
    this.lastFill  = Date.now();
  }

  async consume(bytes) {
    if (!this.rate) return;
    while (true) {
      const now     = Date.now();
      const elapsed = (now - this.lastFill) / 1000;
      this.tokens   = Math.min(this.rate, this.tokens + elapsed * this.rate);
      this.lastFill = now;
      if (this.tokens >= bytes) { this.tokens -= bytes; return; }
      const waitMs = Math.ceil(((bytes - this.tokens) / this.rate) * 1000);
      await sleep(Math.max(1, waitMs));
    }
  }
}

// ---- Concurrent download helper ----

async function downloadWithConcurrency(items, concurrency, onEach) {
  const queue = [...items];
  let i = 0;

  async function worker() {
    while (i < queue.length) {
      const item = queue[i++];
      try {
        await onEach(item);
      } catch (e) {
        console.error(`  ✗ ${item.filename}: ${e.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
}

// POST /api/download — bulk zip download
app.post('/api/download', async (req, res) => {
  const { items, apiKey, speedLimit } = req.body; // speedLimit in bytes/sec, 0 = unlimited

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  console.log(`[download] Starting zip of ${items.length} items...`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="civitai-${Date.now()}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (err) => {
    console.error('[archive error]', err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const bucket  = new TokenBucket(speedLimit > 0 ? speedLimit : 0);
  if (speedLimit > 0) {
    console.log(`[download] Speed limit: ${(speedLimit / 1024 / 1024).toFixed(2)} MB/s`);
  }

  await downloadWithConcurrency(items, 5, async (item) => {
    const r = await fetch(item.url, { headers });
    if (!r.ok) {
      console.warn(`  ✗ ${item.filename}: HTTP ${r.status}`);
      return;
    }

    // Stream with optional throttle
    const chunks = [];
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await bucket.consume(value.length);
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    archive.append(buffer, { name: item.filename });
    console.log(`  ✓ ${item.filename} (${Math.round(buffer.length / 1024)}KB)`);
  });

  await archive.finalize();
  console.log('[download] Zip complete.');
});

/* ------------------------------------------------------------------ *
 *  Companion-app API proxy
 *
 *  Every visitor brings their own API key. It arrives on the X-MAM-Key
 *  header, is used for exactly one upstream call, and is never written to
 *  disk or held in a module variable — so two people using the site at the
 *  same time can only ever see their own characters. The browser keeps the
 *  key in its own localStorage; this server is a stateless relay.
 * ------------------------------------------------------------------ */

const MAM_TIMEOUT = 120_000;

function mamKey(req) {
  const key = (req.get('X-MAM-Key') || '').trim();
  if (!key) {
    const err = new Error(
      `No ${BRAND.name} API key. Add one on the Gallery page — create an ` +
      `account at ${BRAND.url} and generate a key there.`
    );
    err.status = 401;
    throw err;
  }
  return key;
}

async function mam(req, method, urlPath, body) {
  const key = mamKey(req);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAM_TIMEOUT);

  let resp;
  try {
    resp = await fetch(`${API_ORIGIN}${urlPath}`, {
      method,
      headers: {
        'X-API-Key': key,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const wrapped = new Error(
      err.name === 'AbortError'
        ? `${BRAND.name} took too long to respond.`
        : `Could not reach ${BRAND.name}: ${err.message}`
    );
    wrapped.status = 502;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(
      resp.status === 401
        ? 'API key rejected. Check the key on the Gallery page.'
        : payload.error || payload.message || `${BRAND.name} returned ${resp.status}`
    );
    err.status = resp.status;
    throw err;
  }
  return payload;
}

function mamRoute(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (err) {
      // Never echo the key back, even in an error.
      res.status(err.status || 500).json({ error: err.message });
    }
  };
}

// Verify a key and report who it belongs to.
app.get('/api/mam/me', mamRoute(req => mam(req, 'GET', '/api/external/me')));

// The visitor's own characters.
app.get('/api/mam/characters', mamRoute(async req => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const data = await mam(req, 'GET', `/api/external/characters?limit=${limit}`);
  return { characters: data.characters || [] };
}));

// Create a character. A Civit.ai image URL can stand in as the portrait —
// The platform fetches it itself, so nothing is proxied through here.
const IMAGE_STYLES = ['photorealistic', 'anime'];

app.post('/api/mam/characters', mamRoute(async req => {
  const { name, description, tags, portraitUrl, nsfw, visuals, imageStyle } = req.body || {};
  if (!name || !String(name).trim()) {
    const err = new Error('A character name is required.');
    err.status = 400;
    throw err;
  }

  const payload = {
    name: String(name).trim(),
    tags: String(tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 5),
    nsfw: Boolean(nsfw),
    generateCharacterSheet: Boolean(visuals),
    generateCloseup: Boolean(visuals),
    closeupAsThumbnail: false,
    imageStyle: IMAGE_STYLES.includes(imageStyle) ? imageStyle : 'photorealistic',
  };

  const desc = String(description || '').trim();
  if (desc) payload.personalityInput = desc;

  if (portraitUrl) payload.imageUrl = portraitUrl;
  else if (desc) payload.imagePrompt = desc;   // let the remote draw one
  else {
    const err = new Error(
      'Pick an image as the portrait, or write a description to generate one from.'
    );
    err.status = 400;
    throw err;
  }

  // Creation is an AI pipeline that runs for minutes, so the remote answers
  // 202 + a jobId and we hand that back for the browser to poll.
  const result = await mam(req, 'POST', '/api/external/create-character', payload);
  const done = characterFromJob(result);
  if (done) return done;

  const jobId = String(result.jobId || '');
  if (!jobId) {
    console.error('create-character returned neither chatId nor jobId:', JSON.stringify(result).slice(0, 1000));
    throw new Error('No character was created (the API returned no chatId).');
  }
  return { jobId, status: result.status || 'pending' };
}));

// Poll a character-creation job. `pending` means keep asking.
app.get('/api/mam/characters/job/:jobId', mamRoute(async req => {
  const jobId = encodeURIComponent(req.params.jobId);
  const job = await mam(req, 'GET', `/api/external/create-character/job/${jobId}`);

  if (job.status === 'failed') {
    const err = new Error(job.error || 'The character could not be created.');
    err.status = 502;
    throw err;
  }

  // The visuals may still be generating; the character itself is already usable.
  const done = characterFromJob(job);
  return done || { jobId: req.params.jobId, status: job.status || 'pending' };
}));

// A completed job (or a legacy synchronous reply) carries chatId + slug.
function characterFromJob(body) {
  const chatId = String(body.chatId || body.character?._id || '');
  if (!chatId) return null;
  const slug = body.slug || '';
  return { chatId, slug, status: 'completed', url: characterUrl(chatId, slug) };
}

// Attach selected Civit.ai media to a character, one call per item so a
// single bad URL never strands the rest of the batch.
app.post('/api/mam/characters/:chatId/media', mamRoute(async req => {
  const { chatId } = req.params;
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
  if (!items.length) {
    const err = new Error('Nothing selected to send.');
    err.status = 400;
    throw err;
  }

  const added = [];
  const failed = [];

  for (const item of items) {
    const isVideo = item.type === 'video' || item.type === 'animation';
    const endpoint = isVideo ? 'add-video' : 'add-image';
    const body = {
      prompt: String(item.prompt || '').slice(0, 2000),
      nsfw: Boolean(item.nsfw),
      isPrivate: false,
      [isVideo ? 'videoUrl' : 'imageUrl']: item.url,
    };
    try {
      await mam(req, 'POST', `/api/external/character/${chatId}/${endpoint}`, body);
      added.push(item.url);
    } catch (err) {
      failed.push({ url: item.url, error: err.message });
    }
  }

  return { added: added.length, failed, total: items.length };
}));

function characterUrl(chatId, slug) {
  return slug ? `${BRAND.url}/character/${slug}` : `${BRAND.url}/chat/${chatId}`;
}

app.listen(PORT, () => {
  console.log('\n🖼  Civit.ai Downloader');
  console.log(`   http://localhost:${PORT}\n`);
});
