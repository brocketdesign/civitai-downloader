/* Minting: turning searches into indexable content.
 *
 * Every search a visitor runs already pulls a page of images from Civit.ai.
 * Rather than throw that away, we keep the safe-for-work ones. A creator or a
 * model only ever gets a page here because somebody actually looked it up,
 * which keeps the corpus to things real people search for.
 *
 * Nothing here is allowed to slow a search down or break it: mint() is called
 * without await and swallows its own errors.
 */

const { getDb } = require('./store');

const CIVITAI_API = 'https://civitai.com/api/v1';

/* ---- Safety gate ----
 *
 * This site does not index adult content, so the gate fails closed: an item is
 * kept only when every signal Civit.ai gives us says it is clean. `nsfwLevel`
 * is a STRING ('None', 'Soft', 'Mature', 'X'), not a number — comparing it
 * numerically silently passes everything.
 */
function isSafe(item) {
  return item
    && item.nsfw === false
    && item.nsfwLevel === 'None'
    && Number(item.browsingLevel) <= 1;
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function reactionCount(stats = {}) {
  return (stats.heartCount || 0) + (stats.likeCount || 0) + (stats.laughCount || 0);
}

function normalize(item) {
  if (!isSafe(item)) return null;
  if (!item.id || !item.url) return null;

  return {
    _id:           Number(item.id),
    url:           String(item.url),
    width:         Number(item.width)  || 0,
    height:        Number(item.height) || 0,
    type:          item.type === 'video' || item.type === 'animation' ? 'video' : 'image',
    username:      String(item.username || ''),
    usernameLower: String(item.username || '').toLowerCase(),
    baseModel:     String(item.baseModel || ''),
    baseModelSlug: slugify(item.baseModel),
    versionIds:    (item.modelVersionIds || []).map(Number).filter(Boolean).slice(0, 12),
    stats:         item.stats || {},
    reactions:     reactionCount(item.stats),
    postId:        item.postId || null,
    civitaiAt:     item.createdAt ? new Date(item.createdAt) : null,
  };
}

/* ---- Minting ---- */

async function mint(items) {
  const db = await getDb();
  if (!db) return;

  const docs = (items || []).map(normalize).filter(Boolean);
  if (!docs.length) return;

  const now = new Date();

  await db.collection('images').bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { ...doc, lastSeenAt: now }, $setOnInsert: { mintedAt: now } },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  const username = docs[0].username;
  if (username) {
    await db.collection('creators').updateOne(
      { _id: docs[0].usernameLower },
      {
        $set:         { username, lastSearchedAt: now },
        $setOnInsert: { firstSearchedAt: now },
        $inc:         { searchCount: 1 },
      },
      { upsert: true }
    );
  }

  // Model names are not in the image payload — resolve them separately, in the
  // background, once per version id for the lifetime of the database.
  queueVersions(docs.flatMap((d) => d.versionIds));
}

/** Fire-and-forget wrapper. A failed mint must never surface to the visitor. */
function mintQuietly(items) {
  mint(items).catch((err) => console.error('[mint]', err.message));
}

/* ---- Model version resolution ----
 *
 * /images gives only numeric modelVersionIds. The names, and crucially the
 * Checkpoint/LORA type and the nsfw + poi flags, come from /model-versions/:id.
 * Results are cached permanently; misses are tombstoned so a dead id is not
 * re-fetched on every search.
 */

const pending = new Set();
let draining = false;

function queueVersions(ids) {
  for (const id of new Set(ids)) pending.add(id);
  if (!draining) drain().catch((err) => console.error('[mint:versions]', err.message));
}

async function drain() {
  draining = true;
  try {
    while (pending.size) {
      const db = await getDb();
      if (!db) return;

      const batch = [...pending].slice(0, 25);
      batch.forEach((id) => pending.delete(id));

      const known = await db.collection('modelversions')
        .find({ _id: { $in: batch } }, { projection: { _id: 1 } }).toArray();
      const knownIds = new Set(known.map((k) => k._id));
      const todo = batch.filter((id) => !knownIds.has(id));

      for (const id of todo) {
        await resolveVersion(db, id);
        await new Promise((r) => setTimeout(r, 250));  // stay polite upstream
      }
    }
  } finally {
    draining = false;
  }
}

async function resolveVersion(db, id) {
  let payload = null;
  try {
    const res = await fetch(`${CIVITAI_API}/model-versions/${id}`);
    if (res.ok) payload = await res.json();
    else if (res.status !== 404) return;          // transient — try again later
  } catch {
    return;
  }

  const model = payload?.model || {};
  const name  = String(model.name || '').trim();

  // A 404, or a version with no usable model, is tombstoned so we stop asking.
  if (!payload || !name) {
    await db.collection('modelversions').updateOne(
      { _id: id },
      { $set: { _id: id, dead: true, resolvedAt: new Date() } },
      { upsert: true }
    );
    return;
  }

  const type = String(model.type || '').toUpperCase() === 'LORA' ? 'lora' : 'checkpoint';

  await db.collection('modelversions').updateOne(
    { _id: id },
    {
      $set: {
        _id:         id,
        modelId:     payload.modelId || null,
        modelName:   name,
        versionName: String(payload.name || '').trim(),
        // A name that is entirely non-latin slugifies to nothing; fall back to
        // the model id so the page still has a reachable URL.
        slug:        slugify(name) || `model-${payload.modelId || id}`,
        type,
        baseModel:   String(payload.baseModel || ''),
        // Adult models, and models trained on a real person's likeness, never
        // get a page here regardless of how clean the individual images look.
        nsfw:        Boolean(model.nsfw),
        poi:         Boolean(model.poi),
        resolvedAt:  new Date(),
      },
    },
    { upsert: true }
  );
}

module.exports = { mintQuietly, normalize, isSafe, slugify };
