const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;
const CIVITAI_API = 'https://civitai.com/api/v1';

// ---- Public site / branding ----
// SITE_URL is the origin this app is served from once it is online; canonical
// and Open Graph URLs are built from it. Unset, we fall back to the request
// host, which is right locally but wrong behind a proxy.
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const BRAND_NAME = 'MyAIModelManager';
const BRAND_URL = (process.env.BRAND_URL || 'https://myaimodelmanager.com').replace(/\/$/, '');
const MAM_API = process.env.MAM_API_URL || BRAND_URL;

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
    .replaceAll('{{BRAND_NAME}}', BRAND_NAME)
    .replaceAll('{{BRAND_URL}}', BRAND_URL);
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
    'Allow: /$\n' +
    'Disallow: /api/\n' +
    `\nSitemap: ${siteUrl(req)}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const root = siteUrl(req);
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url><loc>${root}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
    `  <url><loc>${root}/gallery</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>\n` +
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
 *  MyAIModelManager proxy
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
      `No ${BRAND_NAME} API key. Add one on the Gallery page — create an ` +
      `account at ${BRAND_URL} and generate a key there.`
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
    resp = await fetch(`${MAM_API}${urlPath}`, {
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
        ? `${BRAND_NAME} took too long to respond.`
        : `Could not reach ${BRAND_NAME}: ${err.message}`
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
        : payload.error || payload.message || `${BRAND_NAME} returned ${resp.status}`
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
// MyAIModelManager fetches it itself, so nothing is proxied through here.
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
  return slug ? `${BRAND_URL}/character/${slug}` : `${BRAND_URL}/chat/${chatId}`;
}

app.listen(PORT, () => {
  console.log('\n🖼  Civit.ai Downloader');
  console.log(`   http://localhost:${PORT}\n`);
});
