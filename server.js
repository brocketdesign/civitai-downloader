const express = require('express');
const archiver = require('archiver');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;
const CIVITAI_API = 'https://civitai.com/api/v1';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    if (cursor) params.set('cursor', cursor);
    if (nsfw === 'true') params.set('nsfw', 'true');

    const data = await civitaiFetch(`/images?${params}`, apiKey);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/images]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

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
  const { items, apiKey } = req.body;

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

  await downloadWithConcurrency(items, 5, async (item) => {
    const r = await fetch(item.url, { headers });
    if (!r.ok) {
      console.warn(`  ✗ ${item.filename}: HTTP ${r.status}`);
      return;
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    archive.append(buffer, { name: item.filename });
    console.log(`  ✓ ${item.filename} (${Math.round(buffer.length / 1024)}KB)`);
  });

  await archive.finalize();
  console.log('[download] Zip complete.');
});

app.listen(PORT, () => {
  console.log('\n🖼  Civit.ai Downloader');
  console.log(`   http://localhost:${PORT}\n`);
});
