/* Gallery — connect a companion-app account and manage its characters.
 *
 * The API key never leaves this browser except as a header on the visitor's
 * own requests. The server holds nothing, so each visitor only ever sees the
 * characters belonging to the key they typed in.
 */

const MAM_KEY = 'mam_api_key';

// Injected by the page (server-templated) so the brand lives in one place.
const BRAND_URL = window.BRAND_URL;
const BRAND_NAME = window.BRAND_NAME;

const getKey = () => localStorage.getItem(MAM_KEY) || '';
const $ = id => document.getElementById(id);

function authHeaders(extra = {}) {
  return { 'X-MAM-Key': getKey(), ...extra };
}

function maskKey(key) {
  if (!key) return '';
  return key.length <= 12 ? `${key.slice(0, 2)}…` : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function setStatus(el, message, kind = '') {
  el.className = `modal-status ${kind}`;
  el.textContent = message;
}

function renderBadge(user) {
  const badge = $('keyBadge');
  if (!getKey()) {
    badge.className = 'badge off';
    badge.textContent = 'Not connected';
    return;
  }
  badge.className = 'badge ok';
  const who = user && (user.username || user.email || user.name);
  badge.textContent = who
    ? `Connected as ${who} · ${maskKey(getKey())}`
    : `Key ${maskKey(getKey())}`;
}

/* ---- key ---- */

async function connect(showEmpty = true) {
  const status = $('keyStatus');
  if (!getKey()) {
    renderBadge(null);
    if (showEmpty) setStatus(status, 'No key saved yet.', '');
    $('charList').innerHTML = '';
    setStatus($('charStatus'), 'Add your API key above to see your characters.', '');
    return false;
  }

  setStatus(status, 'Checking key…', '');
  try {
    const res = await fetch('/api/mam/me', { headers: authHeaders() });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    renderBadge(body.user || body);
    setStatus(status, 'Connected.', 'ok');
    await loadCharacters();
    return true;
  } catch (err) {
    renderBadge(null);
    $('keyBadge').className = 'badge err';
    $('keyBadge').textContent = 'Key rejected';
    setStatus(status, err.message, 'err');
    return false;
  }
}

function saveKey() {
  const value = $('mamKey').value.trim();
  if (!value) {
    setStatus($('keyStatus'), 'Paste a key first.', 'err');
    return;
  }
  localStorage.setItem(MAM_KEY, value);
  $('mamKey').value = '';
  connect();
}

function clearKey() {
  localStorage.removeItem(MAM_KEY);
  $('mamKey').value = '';
  $('charList').innerHTML = '';
  renderBadge(null);
  setStatus($('keyStatus'), 'Key removed from this browser.', '');
  setStatus($('charStatus'), 'Add your API key above to see your characters.', '');
}

/* ---- characters ---- */

async function loadCharacters() {
  const status = $('charStatus');
  const list = $('charList');
  if (!getKey()) return;

  setStatus(status, 'Loading characters…', '');
  try {
    const res = await fetch('/api/mam/characters?limit=100', { headers: authHeaders() });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);

    const characters = body.characters || [];
    if (!characters.length) {
      list.innerHTML = '';
      setStatus(status, 'No characters yet — create one below, or send Civit.ai images from the downloader.', '');
      return;
    }

    setStatus(status, '');
    list.innerHTML = characters.map(renderCharacter).join('');
  } catch (err) {
    list.innerHTML = '';
    setStatus(status, err.message, 'err');
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCharacter(c) {
  const id = c.chatId || c._id || c.id || '';
  const name = escapeHtml(c.name || 'Untitled');
  const thumb = c.thumbnail || c.imageUrl || c.image || '';
  const intro = escapeHtml((c.intro || c.description || '').slice(0, 140));
  const href = c.slug ? `${BRAND_URL}/character/${c.slug}` : `${BRAND_URL}/chat/${id}`;

  return `
    <article class="charcard">
      ${thumb
        ? `<img class="charcard-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" />`
        : '<div class="charcard-img charcard-img--empty">🎭</div>'}
      <div class="charcard-body">
        <h3>${name}</h3>
        ${intro ? `<p>${intro}</p>` : ''}
      </div>
      <a class="charcard-cta" href="${escapeHtml(href)}" target="_blank" rel="noopener">Chat ↗</a>
    </article>`;
}

async function createCharacter() {
  const status = $('createStatus');
  const btn = $('createBtn');

  if (!getKey()) {
    setStatus(status, 'Add your API key first.', 'err');
    return;
  }

  const name = $('newName').value.trim();
  if (!name) {
    setStatus(status, 'A name is required.', 'err');
    return;
  }

  btn.disabled = true;
  setStatus(status, 'Creating…', '');
  try {
    const res = await fetch('/api/mam/characters', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name,
        description: $('newDesc').value.trim(),
        tags: $('newTags').value.trim(),
        portraitUrl: $('newPortrait').value.trim(),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);

    status.className = 'modal-status ok';
    status.innerHTML = `Created. <a href="${body.url}" target="_blank" rel="noopener">Open on ${BRAND_NAME} ↗</a>`;
    ['newName', 'newTags', 'newDesc', 'newPortrait'].forEach(id => { $(id).value = ''; });
    loadCharacters();
  } catch (err) {
    setStatus(status, err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---- wire up ---- */

$('saveKeyBtn').addEventListener('click', saveKey);
$('clearKeyBtn').addEventListener('click', clearKey);
$('createBtn').addEventListener('click', createCharacter);
$('refreshBtn').addEventListener('click', loadCharacters);
$('mamKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });

connect();
