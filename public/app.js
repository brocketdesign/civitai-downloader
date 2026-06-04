/* ---- State ---- */
const state = {
  username:       '',
  apiKey:         localStorage.getItem('civitai_api_key') || '',
  nsfw:           localStorage.getItem('civitai_nsfw') === 'true',
  items:          [],
  selected:       new Set(),
  lastClickedIndex: -1,   // for shift-click range selection
  cursor:         null,
  hasMore:        false,
  loading:        false,
  lightboxIndex:  -1,
  type:           'all',
  sort:           'Newest',
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
  if (cursor)               p.set('cursor', cursor);
  if (state.apiKey)         p.set('apiKey', state.apiKey);
  if (state.nsfw)           p.set('nsfw', 'true');

  const res = await fetch(`/api/images?${p}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
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

async function loadImages(append = false) {
  if (state.loading) return;
  state.loading = true;
  showSpinner(true);
  hideError();

  try {
    const cursor = append ? state.cursor : null;
    if (!append) {
      state.items = [];
      state.selected.clear();
      state.lastClickedIndex = -1;
      document.getElementById('gallery').innerHTML = '';
    }

    const data     = await fetchPage(cursor);
    const newItems = data.items || [];
    const offset   = state.items.length;

    state.items  = [...state.items, ...newItems];
    state.cursor = data.metadata?.nextCursor || null;
    state.hasMore = Boolean(state.cursor);

    appendCards(newItems, offset);
    updateControlBar();
    syncSelectionUI();
  } catch (err) {
    showError(err.message);
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
    progress.textContent = `Loading… (${state.items.length} loaded)`;
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

  progress.textContent = `✓ ${state.items.length} items loaded`;
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

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: toDownload, apiKey: state.apiKey }),
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
  renderHistory(); // refresh active chip highlight
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

  // Render history chips
  renderHistory();

  // Auto-restore last visited username
  const lastUsername = localStorage.getItem('civitai_last_username');
  if (lastUsername) {
    urlInput.value = lastUsername;
    state.username = lastUsername;
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

  // Pagination
  document.getElementById('loadMoreBtn').addEventListener('click', () => loadImages(true));
  document.getElementById('loadAllBtn').addEventListener('click', loadAll);

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
