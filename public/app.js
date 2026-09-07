/* ---- State ---- */
const state = {
  username:       '',
  apiKey:         localStorage.getItem('civitai_api_key') || '',
  nsfw:           localStorage.getItem('civitai_nsfw') === 'true',
  speedLimit:     parseFloat(localStorage.getItem('civitai_speed_limit')) || 0, // MB/s, 0 = unlimited
  items:          [],
  selected:       new Set(),
  lastClickedIndex: -1,   // for shift-click range selection
  cursor:         null,
  hasMore:        false,
  loading:        false,
  _loadGen:       0,      // increments each fresh load; lets new requests supersede stale ones
  lightboxIndex:  -1,
  type:           'all',
  sort:           'Newest',
  currentPage:    1,
  totalPages:     null,
  totalItems:     null,
  pageCursors:    { 1: null }, // maps pageNum → starting cursor (cursor-walk cache)
};

/* ---- Utilities ---- */

function parseUsername(input) {
  input = input.trim();
  try {
    const url = new URL(input);
    const m = url.pathname.match(/\/user\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
  } catch {}
  return input; // plain username
}

function thumbUrl(url, width = 400) {
  if (!url) return '';
  return url.includes('original=true')
    ? url.replace('original=true', `width=${width}`)
    : url;
}

function fileExt(url) {
  return (url.split('?')[0].split('.').pop() || 'jpg').toLowerCase().slice(0, 4);
}

function getFilename(item) {
  return `${item.username}_${item.id}.${fileExt(item.url)}`;
}

function isVideo(item) {
  return item.type === 'video' || item.type === 'animation';
}

function fmtStats({ heartCount = 0, likeCount = 0, commentCount = 0 } = {}) {
  return `❤️ ${heartCount}  👍 ${likeCount}  💬 ${commentCount}`;
}

/* ---- API ---- */

async function fetchPage(cursor = null) {
  const p = new URLSearchParams({
    username: state.username,
    sort:     state.sort,
    limit:    100,
  });
  if (state.type !== 'all') p.set('type', state.type);
  if (cursor != null)        p.set('cursor', cursor);
  if (state.apiKey)          p.set('apiKey', state.apiKey);
  if (state.nsfw)            p.set('nsfw', 'true');

  const url = `/api/images?${p}`;
  console.debug('[fetchPage] GET', url);
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function extractNextCursor(data) {
  const meta = data.metadata || {};
  let cursor = meta.nextCursor ?? data.nextCursor ?? null;
  if (!cursor && meta.nextPage) {
    try { cursor = new URL(meta.nextPage).searchParams.get('cursor') || null; }
    catch {}
  }
  return cursor || null;
}

/* ---- Gallery ---- */

function buildCard(item, globalIndex) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id    = String(item.id);
  card.dataset.index = String(globalIndex);

  const vid      = isVideo(item);
  const thumb    = thumbUrl(item.url, 400);
  const selected = state.selected.has(item.id);

  card.innerHTML = `
    <div class="card-inner">
      ${vid
        ? `<video class="card-media" src="${item.url}" muted loop preload="metadata" poster="${thumb}"></video>`
        : `<img  class="card-media" src="${thumb}" loading="lazy" alt="${item.id}" />`
      }
      <div class="card-overlay ${selected ? 'selected' : ''}">
        <label class="checkbox-wrap" title="Select">
          <input type="checkbox" class="card-check" data-id="${item.id}" ${selected ? 'checked' : ''} />
          <span class="checkbox-custom"></span>
        </label>
        ${item.nsfw ? '<span class="badge nsfw-badge">NSFW</span>'  : ''}
        ${vid       ? '<span class="badge vid-badge">▶ VIDEO</span>' : ''}
      </div>
      <button class="preview-btn" title="Preview">⤢</button>
      <div class="card-stats">${fmtStats(item.stats)}</div>
    </div>
  `;

  // Hover play for videos
  if (vid) {
    const video = card.querySelector('video');
    card.addEventListener('mouseenter', () => video.play().catch(() => {}));
    card.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
  }

  // Click card → toggle selection (shift+click = range select)
  card.querySelector('.card-inner').addEventListener('click', (e) => {
    if (e.target.closest('.preview-btn') || e.target.closest('.checkbox-wrap')) return;

    if (e.shiftKey && state.lastClickedIndex !== -1) {
      // Select the range between lastClickedIndex and globalIndex
      const from = Math.min(state.lastClickedIndex, globalIndex);
      const to   = Math.max(state.lastClickedIndex, globalIndex);
      const shouldSelect = !state.selected.has(item.id);
      for (let i = from; i <= to; i++) {
        const rangeItem = state.items[i];
        if (rangeItem) {
          if (shouldSelect) state.selected.add(rangeItem.id);
          else              state.selected.delete(rangeItem.id);
        }
      }
    } else {
      const cb = card.querySelector('.card-check');
      cb.checked = !cb.checked;
      toggleSelect(item.id, cb.checked);
    }

    state.lastClickedIndex = globalIndex;
    syncSelectionUI();
  });

  // Preview button → open lightbox
  card.querySelector('.preview-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(globalIndex);
  });

  // Checkbox toggle
  card.querySelector('.card-check').addEventListener('change', (e) => {
    toggleSelect(item.id, e.target.checked);
  });

  return card;
}

function appendCards(newItems, offset) {
  const gallery  = document.getElementById('gallery');
  const fragment = document.createDocumentFragment();
  newItems.forEach((item, i) => fragment.appendChild(buildCard(item, offset + i)));
  gallery.appendChild(fragment);
}

function rebuildGallery() {
  document.getElementById('gallery').innerHTML = '';
  appendCards(state.items, 0);
}

/* ---- Selection ---- */

function toggleSelect(id, checked) {
  if (checked) state.selected.add(id);
  else         state.selected.delete(id);
  syncSelectionUI();
}

function syncSelectionUI() {
  const n = state.selected.size;
  document.getElementById('selectedCount').textContent = `${n} selected`;

  const hasSelected = n > 0;
  document.getElementById('downloadZipBtn').disabled  = !hasSelected;
  document.getElementById('copyUrlsBtn').disabled     = !hasSelected;
  document.getElementById('downloadListBtn').disabled = !hasSelected;
  document.getElementById('sendCharBtn').disabled     = !hasSelected;

  // Sync card overlays
  document.querySelectorAll('.card-overlay').forEach(overlay => {
    const cb = overlay.querySelector('.card-check');
    if (!cb) return;
    const id  = parseInt(cb.dataset.id, 10);
    const sel = state.selected.has(id);
    cb.checked = sel;
    overlay.classList.toggle('selected', sel);
  });
}

/* ---- Load ---- */

async function loadImages(append = false, startCursor = null, pageLabel = null) {
  let myGen;

  if (!append) {
    // Bump generation — any older fresh-load waiting will bail out
    myGen = ++state._loadGen;
    // Wait for any in-progress load to finish
    while (state.loading) await sleep(50);
    // If a newer request arrived while we were waiting, step aside
    if (state._loadGen !== myGen) return;
  } else {
    if (state.loading) return;
    myGen = state._loadGen;
  }

  state.loading = true;
  showSpinner(true);
  hideError();

  try {
    const cursor = append ? state.cursor : startCursor;

    if (!append) {
      state.items = [];
      state.selected.clear();
      state.lastClickedIndex = -1;
      state.currentPage = pageLabel || 1;
      // Full reset only on true fresh loads (from the beginning, no startCursor)
      if (startCursor === null) {
        state.pageCursors = { 1: null };
        state.totalPages  = null;
        state.totalItems  = null;
      }
      document.getElementById('gallery').innerHTML = '';
    }

    const data     = await fetchPage(cursor);

    // DEBUG — open browser console to see this
    const meta = data.metadata || {};
    console.debug('[loadImages] sort:', state.sort, '| append:', append, '| cursor:', cursor, '| items received:', (data.items||[]).length,
      '| metadata:', JSON.stringify(meta));

    // Discard result if a newer load has already taken over
    if (state._loadGen !== myGen) return;

    const newItems = data.items || [];
    const offset   = state.items.length;

    state.items = [...state.items, ...newItems];

    // Update totals if the API provides them
    if (meta.totalPages != null) state.totalPages = meta.totalPages;
    if (meta.totalItems != null) state.totalItems = meta.totalItems;

    // Increment page counter for appended loads
    if (append) state.currentPage++;

    // Extract cursor and cache it for the next page
    const nextCursor = extractNextCursor(data);
    if (nextCursor) state.pageCursors[state.currentPage + 1] = nextCursor;

    // Update page jump max when total is known
    if (state.totalPages) {
      const jumpInput = document.getElementById('pageJumpInput');
      if (jumpInput) jumpInput.max = state.totalPages;
    }

    state.cursor  = nextCursor;
    state.hasMore = Boolean(nextCursor);
    console.debug('[loadImages] → cursor:', state.cursor, '| hasMore:', state.hasMore, '| currentPage:', state.currentPage);

    appendCards(newItems, offset);
    updateControlBar();
    syncSelectionUI();
  } catch (err) {
    if (state._loadGen === myGen) showError(err.message);
  } finally {
    state.loading = false;
    showSpinner(false);
  }
}

async function loadAll() {
  const progress = document.getElementById('loadAllProgress');
  progress.textContent = 'Loading…';

  await loadImages(false);

  let consecutiveErrors = 0;
  while (state.hasMore) {
    const pageOf = state.totalPages ? `/${state.totalPages}` : '';
    progress.textContent = `Loading… page ${state.currentPage}${pageOf} (${state.items.length} loaded)`;
    await sleep(400);
    try {
      await loadImages(true);
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        progress.textContent = `⚠ Stopped after 3 errors (${state.items.length} loaded)`;
        return;
      }
      progress.textContent = `⚠ Retrying… (${state.items.length} loaded)`;
      await sleep(consecutiveErrors * 2000);
    }
  }

  const totalLabel = state.totalItems ? ` of ${state.totalItems.toLocaleString()}` : '';
  progress.textContent = `✓ ${state.items.length}${totalLabel} items loaded`;
  setTimeout(() => { progress.textContent = ''; }, 4000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---- Download ---- */

async function downloadZip() {
  const toDownload = state.items
    .filter(item => state.selected.has(item.id))
    .map(item => ({ url: item.url, filename: getFilename(item) }));

  if (!toDownload.length) return;

  setDownloadStatus(`⏳ Fetching & zipping ${toDownload.length} files… this may take a while.`);
  document.getElementById('downloadZipBtn').disabled = true;

  const speedLimitBytes = state.speedLimit > 0
    ? Math.round(state.speedLimit * 1024 * 1024)
    : 0;

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: toDownload, apiKey: state.apiKey, speedLimit: speedLimitBytes }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const blob = await res.blob();
    triggerDownload(blob, `civitai-${state.username}-${Date.now()}.zip`);
    setDownloadStatus(`✅ Downloaded ${toDownload.length} files as ZIP`);
  } catch (err) {
    setDownloadStatus(`❌ ${err.message}`);
  } finally {
    document.getElementById('downloadZipBtn').disabled = state.selected.size === 0;
    setTimeout(() => setDownloadStatus(''), 6000);
  }
}

/* ---- Send to a companion-app character ---- */

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MAM_KEY = 'mam_api_key';
const mamKey = () => localStorage.getItem(MAM_KEY) || '';

function selectedItems() {
  return state.items.filter(i => state.selected.has(i.id));
}

function setSendStatus(message, kind = '') {
  const el = document.getElementById('sendStatus');
  el.className = `modal-status ${kind}`;
  el.innerHTML = message;
}

async function openSendModal() {
  const items = selectedItems();
  if (!items.length) return;

  document.getElementById('sendModal').style.display = 'flex';
  document.getElementById('sendSummary').textContent =
    `${items.length} item${items.length === 1 ? '' : 's'} selected.`;
  setSendStatus('');

  const hasKey = Boolean(mamKey());
  document.getElementById('sendNeedsKey').style.display = hasKey ? 'none' : 'block';
  document.getElementById('sendForm').style.display = hasKey ? 'block' : 'none';
  document.getElementById('sendConfirmBtn').disabled = !hasKey;
  if (!hasKey) return;

  const select = document.getElementById('sendCharSelect');
  select.innerHTML = '<option value="">Loading your characters…</option>';

  try {
    const res = await fetch('/api/mam/characters?limit=100', {
      headers: { 'X-MAM-Key': mamKey() },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);

    const options = (body.characters || [])
      .map(c => `<option value="${c.chatId || c._id || c.id}">${escapeHtml(c.name || 'Untitled')}</option>`)
      .join('');
    select.innerHTML = `<option value="__new__">✨ Create a new character…</option>${options}`;
    onSendCharChange();
  } catch (err) {
    select.innerHTML = '<option value="__new__">✨ Create a new character…</option>';
    setSendStatus(escapeHtml(err.message), 'err');
    onSendCharChange();
  }
}

// Creating a character is a multi-minute AI pipeline on the remote side, so the
// server hands back a job id and we wait it out here.
async function awaitCharacterJob(jobId, headers) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let waited = 0;
  // A deploy restart or a proxy blip mid-poll returns a non-JSON 5xx; ride it
  // out instead of aborting a build that is still running remotely.
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    waited += 3;
    setSendStatus(`Creating the character… (${waited}s — this takes a minute or two)`);

    try {
      const res = await fetch(`/api/mam/characters/job/${encodeURIComponent(jobId)}`, { headers });
      const text = await res.text();
      if (!res.ok) {
        // Safari's res.json() on an HTML error page yields "The string did not
        // match the expected pattern." — parse defensively and show something sane.
        let body = {};
        try { body = JSON.parse(text); } catch { /* gateway HTML or empty body */ }
        throw new Error(body.error || `Error ${res.status}`);
      }
      consecutiveFailures = 0;
      const body = JSON.parse(text);
      if (body.chatId) return body;
    } catch (err) {
      // A job the remote marked failed is final — surface it. Anything else
      // (network drop, 502/504 gateway page) is transient; keep polling.
      if (err.message && !/^Error 5/.test(err.message) && !/failed to fetch/i.test(err.message)) {
        throw err;
      }
      if (++consecutiveFailures >= 10) {
        throw new Error('Lost contact with the server while building. The character may still finish — check the site in a moment.');
      }
    }
  }

  throw new Error(`The character is taking unusually long to build. Check ${window.BRAND_NAME} in a moment.`);
}

function onSendCharChange() {
  const isNew = document.getElementById('sendCharSelect').value === '__new__';
  document.getElementById('sendNewFields').style.display = isNew ? 'block' : 'none';
  // Anime characters always go to Seisei, so the use case only matters for
  // photorealistic ones.
  const style = document.getElementById('sendCharStyle').value;
  document.getElementById('sendUseCaseField').style.display =
    isNew && style !== 'anime' ? 'block' : 'none';
}

function closeSendModal() {
  document.getElementById('sendModal').style.display = 'none';
}

async function confirmSend() {
  const items = selectedItems();
  if (!items.length) return;

  const btn = document.getElementById('sendConfirmBtn');
  const select = document.getElementById('sendCharSelect');
  const creating = select.value === '__new__';
  const headers = { 'X-MAM-Key': mamKey(), 'Content-Type': 'application/json' };

  btn.disabled = true;
  try {
    let chatId = select.value;
    let charUrl = '';
    let siteName = window.BRAND_NAME;
    let destination = '';
    let media = items;

    if (creating) {
      // Optional — the server invents a style-matched name when it's blank.
      const name = document.getElementById('sendCharName').value.trim();

      setSendStatus('Creating the character…');
      // The first pick becomes the portrait, so it is not also sent as a
      // gallery image below.
      const [portrait, ...rest] = items;
      const res = await fetch('/api/mam/characters', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          description: document.getElementById('sendCharDesc').value.trim(),
          portraitUrl: portrait.url,
          imageStyle: document.getElementById('sendCharStyle').value,
          useCase: document.getElementById('sendCharUseCase').value,
        }),
      });
      let body = await res.json();
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
      if (!body.chatId && body.jobId) body = await awaitCharacterJob(body.jobId, headers);

      chatId = body.chatId;
      charUrl = body.url;
      siteName = body.siteName || siteName;
      destination = body.destination || '';
      media = rest;
    }

    if (!chatId) throw new Error('Pick a character to send to.');

    let report = { added: 0, failed: [] };
    if (media.length) {
      setSendStatus(`Sending ${media.length} item${media.length === 1 ? '' : 's'}…`);
      const res = await fetch(`/api/mam/characters/${chatId}/media`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          destination,
          items: media.map(i => ({
            url: i.url,
            type: i.type,
            prompt: i.meta?.prompt || '',
            // nsfwLevel is a string ('None' | 'Soft' | 'Mature' | 'X'), so a
            // numeric comparison here silently marked everything safe.
            nsfw: i.nsfw === true || (i.nsfwLevel && i.nsfwLevel !== 'None'),
          })),
        }),
      });
      report = await res.json();
      if (!res.ok) throw new Error(report.error || `Error ${res.status}`);
    }

    const link = charUrl
      ? ` <a href="${charUrl}" target="_blank" rel="noopener">Open on ${escapeHtml(siteName)} ↗</a>`
      : '';
    const failed = report.failed?.length
      ? ` ${report.failed.length} item${report.failed.length === 1 ? '' : 's'} could not be sent.`
      : '';
    setSendStatus(
      `✅ ${creating ? 'Character created. ' : ''}${report.added} item${report.added === 1 ? '' : 's'} added.${failed}${link}`,
      failed ? 'warn' : 'ok'
    );
  } catch (err) {
    setSendStatus(escapeHtml(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
}

function copyUrls() {
  const urls = state.items
    .filter(i => state.selected.has(i.id))
    .map(i => i.url)
    .join('\n');
  navigator.clipboard.writeText(urls).then(() => {
    setDownloadStatus(`✅ ${state.selected.size} URLs copied to clipboard`);
    setTimeout(() => setDownloadStatus(''), 3000);
  });
}

function saveUrlList() {
  const lines = state.items
    .filter(i => state.selected.has(i.id))
    .map(i => `${i.url}\t${getFilename(i)}`)
    .join('\n');
  const blob = new Blob([lines], { type: 'text/plain' });
  triggerDownload(blob, `civitai-urls-${state.username}.txt`);
  setDownloadStatus(`✅ URL list saved (${state.selected.size} items)`);
  setTimeout(() => setDownloadStatus(''), 3000);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/* ---- Lightbox ---- */

function openLightbox(index) {
  const item = state.items[index];
  if (!item) return;
  state.lightboxIndex = index;

  const vid     = isVideo(item);
  const content = document.getElementById('lightboxContent');
  const info    = document.getElementById('lightboxInfo');

  // Replace media (stop any previous video)
  const oldVid = content.querySelector('video');
  if (oldVid) oldVid.pause();

  content.innerHTML = vid
    ? `<video class="lightbox-media" src="${item.url}" controls autoplay muted loop></video>`
    : `<img   class="lightbox-media" src="${item.url}" alt="${item.id}" />`;

  const meta = item.meta || {};
  info.innerHTML = `
    <p>
      <strong>ID:</strong> ${item.id} &nbsp;|&nbsp;
      <strong>User:</strong> ${item.username} &nbsp;|&nbsp;
      ${item.width}×${item.height}
      ${item.nsfw ? ' &nbsp;|&nbsp; <span style="color:var(--danger)">NSFW</span>' : ''}
    </p>
    <p>${fmtStats(item.stats)}</p>
    ${meta.Model   ? `<p><strong>Model:</strong> ${meta.Model}</p>` : ''}
    ${meta.sampler ? `<p><strong>Sampler:</strong> ${meta.sampler}  Steps: ${meta.steps || '?'}  CFG: ${meta.cfgScale || '?'}</p>` : ''}
    ${meta.prompt  ? `<p class="prompt"><strong>Prompt:</strong> ${meta.prompt}</p>` : ''}
    <p style="margin-top:6px">
      <a href="${item.url}" target="_blank" rel="noopener noreferrer">⬆ Open full-size in new tab</a>
      &nbsp;&nbsp;
      <a href="/api/images?username=${item.username}&sort=Newest" target="_blank">👤 API JSON</a>
    </p>
  `;

  document.getElementById('lightbox').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.style.display = 'none';
  document.body.style.overflow = '';

  const oldVid = document.getElementById('lightboxContent').querySelector('video');
  if (oldVid) oldVid.pause();
  state.lightboxIndex = -1;
}

function lightboxNav(dir) {
  const next = state.lightboxIndex + dir;
  if (next >= 0 && next < state.items.length) openLightbox(next);
}

/* ---- History ---- */

const HISTORY_KEY = 'civitai_history';
const MAX_HISTORY = 20;

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function addToHistory(username) {
  const history = getHistory().filter(h => h.username !== username);
  history.unshift({ username, visitedAt: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  localStorage.setItem('civitai_last_username', username);
  renderHistory();
}

function removeFromHistory(username) {
  const updated = getHistory().filter(h => h.username !== username);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  if (localStorage.getItem('civitai_last_username') === username) {
    localStorage.removeItem('civitai_last_username');
  }
  renderHistory();
}

function renderHistory() {
  const bar     = document.getElementById('historyBar');
  const list    = document.getElementById('historyList');
  const history = getHistory();

  if (!history.length) { bar.style.display = 'none'; return; }

  bar.style.display  = 'flex';
  list.innerHTML = history.map(h => `
    <span class="history-chip ${state.username === h.username ? 'active' : ''}" data-username="${h.username}">
      <span class="history-name">${h.username}</span>
      <button class="history-remove" data-username="${h.username}" title="Remove from history">✕</button>
    </span>
  `).join('');

  list.querySelectorAll('.history-chip').forEach(chip => {
    chip.querySelector('.history-name').addEventListener('click', () => {
      const u = chip.dataset.username;
      document.getElementById('urlInput').value = u;
      state.username = u;
      state.apiKey   = document.getElementById('apiKeyInput').value.trim();
      loadImages(false);
    });
    chip.querySelector('.history-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromHistory(chip.dataset.username);
    });
  });
}

/* ---- UI Helpers ---- */

function showSpinner(on) {
  document.getElementById('loadingSpinner').style.display = on ? 'flex' : 'none';
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = `⚠ ${msg}`;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('errorMsg').style.display = 'none';
}

function setDownloadStatus(msg) {
  const bar = document.getElementById('downloadStatusBar');
  if (msg) { bar.textContent = msg; bar.style.display = 'block'; }
  else      { bar.style.display = 'none'; }
}

function updateControlBar() {
  const hasItems = state.items.length > 0;
  document.getElementById('controls').style.display = 'flex';
  document.getElementById('filters').style.display = 'flex';
  document.getElementById('loadMoreContainer').style.display = state.hasMore ? 'flex' : 'none';
  document.getElementById('itemCount').textContent = `${state.items.length} loaded`;
  updatePageInfo();
  renderHistory(); // refresh active chip highlight
}

function updatePageInfo() {
  const el = document.getElementById('pageInfo');
  if (!el) return;
  const parts = [];
  if (state.totalPages) {
    parts.push(`Page ${state.currentPage} of ${state.totalPages}`);
  } else if (state.currentPage > 1) {
    parts.push(`Page ${state.currentPage}`);
  }
  if (state.totalItems != null) {
    parts.push(`${state.totalItems.toLocaleString()} total items`);
  }
  el.textContent = parts.join(' · ');
}

async function jumpToPage(targetPage) {
  if (!targetPage || targetPage < 1 || !state.username) return;

  const progressEl = document.getElementById('loadAllProgress');

  // If we already have the cursor cached for this page, jump directly
  if (state.pageCursors[targetPage] !== undefined) {
    progressEl.textContent = '';
    await loadImages(false, state.pageCursors[targetPage], targetPage);
    return;
  }

  // Find the best starting point in our cursor cache
  let fromPage = 1;
  let walkCursor = null;
  for (let p = targetPage - 1; p >= 1; p--) {
    if (state.pageCursors[p] !== undefined) {
      fromPage = p;
      walkCursor = state.pageCursors[p];
      break;
    }
  }

  // Acquire the load lock (cancel any in-flight operation)
  const gen = ++state._loadGen;
  while (state.loading) await sleep(50);
  if (state._loadGen !== gen) return;

  state.loading = true;
  showSpinner(true);
  hideError();
  document.getElementById('gallery').innerHTML = '';

  const steps = targetPage - fromPage;
  let succeeded = false;

  try {
    for (let step = 0; step < steps; step++) {
      if (state._loadGen !== gen) return; // superseded

      const curPage = fromPage + step;
      progressEl.textContent = `Navigating to page ${targetPage}… (${curPage + 1}/${targetPage})`;

      const data = await fetchPage(walkCursor);
      const nextCursor = extractNextCursor(data);

      if (!nextCursor) {
        progressEl.textContent = `⚠ Only ${curPage} page(s) exist for this user`;
        setTimeout(() => { progressEl.textContent = ''; }, 4000);
        return;
      }

      walkCursor = nextCursor;
      state.pageCursors[curPage + 1] = walkCursor; // cache for future jumps
      await sleep(200); // be polite to the API
    }
    succeeded = true;
  } catch (err) {
    if (state._loadGen === gen) {
      progressEl.textContent = `⚠ Navigation failed: ${err.message}`;
      setTimeout(() => { progressEl.textContent = ''; }, 4000);
    }
  } finally {
    state.loading = false;
    showSpinner(false);
  }

  if (!succeeded || state._loadGen !== gen) return;
  progressEl.textContent = '';
  await loadImages(false, walkCursor, targetPage);
}

/* ---- Init ---- */

function init() {
  const urlInput    = document.getElementById('urlInput');
  const apiKeyInput = document.getElementById('apiKeyInput');

  // Keep --header-h CSS variable in sync so sticky controls bar sits below the header
  const header = document.querySelector('.header');
  const updateHeaderHeight = () =>
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  updateHeaderHeight();
  new ResizeObserver(updateHeaderHeight).observe(header);

  // Restore saved API key and NSFW pref
  apiKeyInput.value = state.apiKey;
  const nsfwCheck = document.getElementById('nsfwCheck');
  nsfwCheck.checked = state.nsfw;

  // Restore saved speed limit
  const speedLimitInput = document.getElementById('speedLimitInput');
  if (state.speedLimit > 0) speedLimitInput.value = state.speedLimit;
  speedLimitInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    state.speedLimit = (val > 0) ? val : 0;
    localStorage.setItem('civitai_speed_limit', state.speedLimit);
  });

  // Render history chips
  renderHistory();

  // A ?u= in the URL comes from a minted creator page and wins over history,
  // so those pages land the visitor straight on that creator's gallery.
  const linked = parseUsername(new URLSearchParams(location.search).get('u') || '');
  const lastUsername = linked || localStorage.getItem('civitai_last_username');
  if (lastUsername) {
    urlInput.value = lastUsername;
    state.username = lastUsername;
    if (linked) addToHistory(linked);
    loadImages(false);
  }

  // Load on button click
  document.getElementById('loadBtn').addEventListener('click', () => {
    const username = parseUsername(urlInput.value);
    if (!username) return;
    state.username = username;
    state.apiKey   = apiKeyInput.value.trim();
    if (state.apiKey) localStorage.setItem('civitai_api_key', state.apiKey);
    addToHistory(username);
    loadImages(false);
  });

  // Load on Enter
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loadBtn').click();
  });

  // Filters
  document.getElementById('typeFilter').addEventListener('change', (e) => {
    state.type = e.target.value;
    if (state.username) loadImages(false);
  });

  document.getElementById('sortFilter').addEventListener('change', (e) => {
    state.sort = e.target.value;
    if (state.username) loadImages(false);
  });

  document.getElementById('nsfwCheck').addEventListener('change', (e) => {
    state.nsfw = e.target.checked;
    localStorage.setItem('civitai_nsfw', state.nsfw);
    if (state.username) loadImages(false);
  });

  // Selection controls
  document.getElementById('selectAllBtn').addEventListener('click', () => {
    state.items.forEach(item => state.selected.add(item.id));
    syncSelectionUI();
  });

  document.getElementById('deselectAllBtn').addEventListener('click', () => {
    state.selected.clear();
    state.lastClickedIndex = -1;
    syncSelectionUI();
  });

  // Download actions
  document.getElementById('downloadZipBtn').addEventListener('click', downloadZip);
  document.getElementById('copyUrlsBtn').addEventListener('click', copyUrls);
  document.getElementById('downloadListBtn').addEventListener('click', saveUrlList);

  document.getElementById('sendCharBtn').addEventListener('click', openSendModal);
  document.getElementById('sendCancelBtn').addEventListener('click', closeSendModal);
  document.getElementById('sendConfirmBtn').addEventListener('click', confirmSend);
  document.getElementById('sendCharSelect').addEventListener('change', onSendCharChange);
  document.getElementById('sendCharStyle').addEventListener('change', onSendCharChange);
  document.getElementById('sendModal').addEventListener('click', (e) => {
    if (e.target.id === 'sendModal') closeSendModal();
  });

  // Pagination
  document.getElementById('loadMoreBtn').addEventListener('click', () => loadImages(true));
  document.getElementById('loadAllBtn').addEventListener('click', loadAll);

  // Page jump
  const pageJumpBtn   = document.getElementById('pageJumpBtn');
  const pageJumpInput = document.getElementById('pageJumpInput');
  pageJumpBtn.addEventListener('click', () => {
    const p = parseInt(pageJumpInput.value, 10);
    if (p > 0 && state.username) jumpToPage(p);
  });
  pageJumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pageJumpBtn.click();
  });

  // Lightbox controls
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxPrev').addEventListener('click', () => lightboxNav(-1));
  document.getElementById('lightboxNext').addEventListener('click', () => lightboxNav(1));

  // Close lightbox on backdrop click
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (state.lightboxIndex < 0) return;
    switch (e.key) {
      case 'Escape':      closeLightbox(); break;
      case 'ArrowLeft':   lightboxNav(-1); break;
      case 'ArrowRight':  lightboxNav(1);  break;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
