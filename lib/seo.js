/* Server-rendered SEO pages.
 *
 * These are the pages searches mint. Each one aggregates real content (a
 * creator's gallery, everything made with one checkpoint or LoRA) and carries
 * the two calls to action this site exists to serve: turn the art into a
 * character you can talk to, and animate a still into video. Both land on the
 * brand's login page, so the cost of the feature falls after the signup rather
 * than before it.
 *
 * A page is only allowed into the index once it clears MIN_ITEMS. Below that it
 * still renders — a visitor who follows a link gets something — but it is
 * marked noindex and kept out of the sitemap, so thin pages never become the
 * site's reputation.
 */

const { getDb } = require('./store');
const { BRAND } = require('./brand');

const MIN_ITEMS  = Number(process.env.SEO_MIN_ITEMS || 12);
const GRID_LIMIT = 48;

/* ---- Escaping ----
 * Usernames and model names are third-party input rendered into HTML, so
 * everything user-derived goes through esc() or attr().
 */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const attr = esc;
const jsonld = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

const thumb = (url, w = 450) =>
  String(url || '').includes('original=true')
    ? String(url).replace('original=true', `width=${w}`)
    : String(url || '');

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/* ---- Layout ---- */

function layout({ site, title, description, canonical, indexable, ogImage, structured, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${attr(description)}" />
<link rel="canonical" href="${attr(canonical)}" />
<meta name="robots" content="${indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow'}" />
<link rel="icon" type="image/png" sizes="256x256" href="${attr(BRAND.logo)}" />
<meta name="theme-color" content="#0a0810" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Civit.ai Downloader" />
<meta property="og:title" content="${attr(title)}" />
<meta property="og:description" content="${attr(description)}" />
<meta property="og:url" content="${attr(canonical)}" />
<meta property="og:image" content="${attr(ogImage || site + BRAND.logo)}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="stylesheet" href="/style.css" />
${structured ? `<script type="application/ld+json">${jsonld(structured)}</script>` : ''}
</head>
<body>

<header class="header">
  <div class="header-top">
    <div class="brandbar">
      <div class="brandmark">
        <img src="${attr(BRAND.logo)}" alt="${attr(BRAND.name)}" width="36" height="36" />
        <div>
          <h1>Civit.ai Downloader</h1>
          <p class="tagline">Browse, download, and bring AI art to life.</p>
        </div>
      </div>
      <nav class="sitenav">
        <a href="/">Downloader</a>
        <a href="/creators">Creators</a>
        <a href="/models">Models</a>
        <a href="/gallery">Gallery</a>
      </nav>
    </div>
  </div>
</header>

<main class="page">
${body}
</main>

<footer class="sitefoot">
  <img src="${attr(BRAND.logo)}" alt="" width="28" height="28" loading="lazy" />
  <p>A free tool by <a href="${attr(BRAND.url)}" rel="noopener">${esc(BRAND.name)}</a>, ${esc(BRAND.tagline)}.</p>
</footer>

</body>
</html>`;
}

/* ---- Shared blocks ---- */

/* The conversion block. Anchors vary per page so the site is not repeating one
 * keyword-stuffed link sitewide, which is the pattern link-spam detection is
 * built to catch. */
function ctaPanel(subject, firstImage) {
  const portrait = firstImage ? `?portrait=${encodeURIComponent(firstImage.url)}` : '';
  return `
  <section class="panel">
    <div class="panel-head"><h2>Bring ${esc(subject)} to life</h2></div>
    <p class="panel-note">
      A gallery is a dead end — the art just sits there. On
      <a href="${attr(BRAND.url)}" rel="noopener">${esc(BRAND.name)}</a> you can
      hand any of these images a personality and start talking to it, or take a
      still and animate it into a short video.
    </p>
    <div class="modal-actions">
      <a class="btn btn-primary" href="${attr(BRAND.loginUrl + portrait)}" rel="noopener">Chat with a character built from this art</a>
      <a class="btn btn-outline" href="${attr(BRAND.loginUrl)}" rel="noopener">Animate an image into video</a>
    </div>
  </section>`;
}

function grid(images) {
  if (!images.length) return '<p class="muted-text">Nothing here yet.</p>';
  return `<div class="gallery">${images.map((img) => {
    const alt = `AI ${img.type === 'video' ? 'video' : 'art'} by ${img.username}${img.baseModel ? `, made with ${img.baseModel}` : ''}`;
    return `
    <div class="card"><div class="card-inner">
      ${img.type === 'video'
        ? `<video class="card-media" src="${attr(img.url)}" muted loop preload="none" poster="${attr(thumb(img.url))}"></video>`
        : `<img class="card-media" src="${attr(thumb(img.url))}" loading="lazy" width="${img.width || ''}" height="${img.height || ''}" alt="${attr(alt)}" />`}
      <div class="card-stats">&#10084;&#65039; ${(img.stats?.heartCount || 0)} &nbsp; &#128172; ${(img.stats?.commentCount || 0)}</div>
    </div></div>`;
  }).join('')}</div>`;
}

function linkList(heading, links) {
  if (!links.length) return '';
  return `
  <section class="panel">
    <div class="panel-head"><h2>${esc(heading)}</h2></div>
    <div class="history-list">
      ${links.map((l) => `<a class="history-chip" href="${attr(l.href)}"><span class="history-name">${esc(l.label)}</span></a>`).join('')}
    </div>
  </section>`;
}

/* ---- Queries ---- */

async function versionsForImages(db, images) {
  const ids = [...new Set(images.flatMap((i) => i.versionIds || []))];
  if (!ids.length) return [];
  return db.collection('modelversions')
    .find({ _id: { $in: ids }, dead: { $ne: true }, nsfw: false, poi: false })
    .limit(24).toArray();
}

/* ---- Creator page ---- */

async function creatorPage(db, site, username) {
  const key = String(username).toLowerCase();
  const images = await db.collection('images')
    .find({ usernameLower: key }).sort({ reactions: -1 }).limit(GRID_LIMIT).toArray();
  if (!images.length) return null;

  const total     = await db.collection('images').countDocuments({ usernameLower: key });
  const display   = images[0].username;
  const indexable = total >= MIN_ITEMS;
  const videos    = images.filter((i) => i.type === 'video').length;
  const versions  = await versionsForImages(db, images);

  const related = await db.collection('images').aggregate([
    { $match: { versionIds: { $in: images.flatMap((i) => i.versionIds || []) }, usernameLower: { $ne: key } } },
    { $group: { _id: '$usernameLower', username: { $first: '$username' }, n: { $sum: 1 } } },
    { $match: { n: { $gte: 3 } } }, { $sort: { n: -1 } }, { $limit: 8 },
  ]).toArray();

  const canonical   = `${site}/creator/${encodeURIComponent(display)}`;
  const title       = `${display} — AI art gallery and bulk downloader`;
  const description = `Browse and download ${plural(total, 'image', 'images')} by Civit.ai creator ${display}. Grab the whole gallery as a ZIP, or turn any piece into an AI character you can chat with.`;

  const body = `
  <section class="panel">
    <div class="panel-head"><h2>${esc(display)}</h2></div>
    <p class="panel-note">
      ${esc(display)} has ${plural(total, 'safe-for-work post', 'safe-for-work posts')} indexed here${videos ? `, including ${plural(videos, 'video', 'videos')}` : ''}.
      Open this creator in the downloader to page through everything, select what
      you want, and take it as individual files or one ZIP.
    </p>
    <div class="modal-actions">
      <a class="btn btn-primary" href="/?u=${attr(encodeURIComponent(display))}">Open ${esc(display)} in the downloader</a>
      <a class="btn btn-sm" href="https://civitai.com/user/${attr(encodeURIComponent(display))}" rel="noopener nofollow">View on Civit.ai</a>
    </div>
  </section>

  ${ctaPanel(`${display}'s art`, images[0])}

  <section class="panel">
    <div class="panel-head"><h2>Gallery</h2></div>
    ${grid(images)}
  </section>

  ${linkList('Models this creator works with', versions.map((v) => ({
    href: `/${v.type === 'lora' ? 'lora' : 'model'}/${encodeURIComponent(v.slug)}`,
    label: v.modelName,
  })))}

  ${linkList('Creators with a similar style', related.map((r) => ({
    href: `/creator/${encodeURIComponent(r.username)}`,
    label: r.username,
  })))}`;

  return layout({
    site, title, description, canonical, indexable,
    ogImage: thumb(images[0].url, 1200),
    structured: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title,
      url: canonical,
      description,
      about: { '@type': 'Person', name: display, url: `https://civitai.com/user/${display}` },
      mainEntity: {
        '@type': 'ImageGallery',
        numberOfItems: total,
        associatedMedia: images.slice(0, 12).map((i) => ({
          '@type': i.type === 'video' ? 'VideoObject' : 'ImageObject',
          contentUrl: i.url, width: i.width, height: i.height, creator: { '@type': 'Person', name: i.username },
        })),
      },
    },
    body,
  });
}

/* ---- Model / LoRA page ---- */

async function modelPage(db, site, kind, slug) {
  const versions = await db.collection('modelversions')
    .find({ slug, type: kind, dead: { $ne: true }, nsfw: false, poi: false }).toArray();
  if (!versions.length) return null;

  const ids = versions.map((v) => v._id);
  const images = await db.collection('images')
    .find({ versionIds: { $in: ids } }).sort({ reactions: -1 }).limit(GRID_LIMIT).toArray();
  if (!images.length) return null;

  const total     = await db.collection('images').countDocuments({ versionIds: { $in: ids } });
  const name      = versions[0].modelName;
  const label     = kind === 'lora' ? 'LoRA' : 'checkpoint';
  const indexable = total >= MIN_ITEMS;

  const creators = await db.collection('images').aggregate([
    { $match: { versionIds: { $in: ids } } },
    { $group: { _id: '$usernameLower', username: { $first: '$username' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 12 },
  ]).toArray();

  const base = versions[0].baseModel;
  const siblings = base ? await db.collection('modelversions').aggregate([
    { $match: { baseModel: base, slug: { $ne: slug }, dead: { $ne: true }, nsfw: false, poi: false } },
    { $group: { _id: '$slug', modelName: { $first: '$modelName' }, type: { $first: '$type' } } },
    { $limit: 10 },
  ]).toArray() : [];

  const canonical   = `${site}/${kind}/${encodeURIComponent(slug)}`;
  const title       = `${name} — ${label} gallery, examples and downloads`;
  const description = `${plural(total, 'AI image', 'AI images')} made with the ${name} ${label}${base ? ` (${base})` : ''}. See what it looks like in practice, download the examples, or turn one into a character you can talk to.`;

  const body = `
  <section class="panel">
    <div class="panel-head"><h2>${esc(name)}</h2></div>
    <p class="panel-note">
      A ${esc(label)}${base ? ` built on ${esc(base)}` : ''}, shown here through
      ${plural(total, 'safe-for-work example', 'safe-for-work examples')} from
      ${plural(creators.length, 'creator', 'creators')}. Every image links back to
      the creator who made it, so you can see how the ${esc(label)} behaves in
      different hands before you commit to it.
    </p>
  </section>

  ${ctaPanel(`art made with ${name}`, images[0])}

  <section class="panel">
    <div class="panel-head"><h2>Examples</h2></div>
    ${grid(images)}
  </section>

  ${linkList('Creators using it', creators.map((c) => ({
    href: `/creator/${encodeURIComponent(c.username)}`, label: c.username,
  })))}

  ${linkList(base ? `Other ${base} models` : 'Related models', siblings.map((s) => ({
    href: `/${s.type === 'lora' ? 'lora' : 'model'}/${encodeURIComponent(s._id)}`, label: s.modelName,
  })))}`;

  return layout({
    site, title, description, canonical, indexable,
    ogImage: thumb(images[0].url, 1200),
    structured: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title, url: canonical, description,
      mainEntity: { '@type': 'ImageGallery', numberOfItems: total },
    },
    body,
  });
}

/* ---- Index pages ---- */

async function creatorIndex(db, site) {
  const rows = await db.collection('images').aggregate([
    { $group: { _id: '$usernameLower', username: { $first: '$username' }, n: { $sum: 1 } } },
    { $match: { n: { $gte: MIN_ITEMS } } }, { $sort: { n: -1 } }, { $limit: 500 },
  ]).toArray();

  return layout({
    site,
    title: 'Civit.ai creators — browse and download full galleries',
    description: 'Every Civit.ai creator indexed here, with safe-for-work galleries you can browse, bulk download, or turn into an AI character.',
    canonical: `${site}/creators`,
    indexable: rows.length > 0,
    body: `
    <section class="panel">
      <div class="panel-head"><h2>Creators</h2></div>
      <p class="panel-note">${plural(rows.length, 'creator', 'creators')} indexed. These pages build themselves — a creator appears once someone searches for them here.</p>
    </section>
    ${linkList('All creators', rows.map((r) => ({ href: `/creator/${encodeURIComponent(r.username)}`, label: `${r.username} (${r.n})` })))}`,
  });
}

async function modelIndex(db, site) {
  const rows = await db.collection('modelversions').aggregate([
    { $match: { dead: { $ne: true }, nsfw: false, poi: false } },
    { $group: { _id: '$slug', modelName: { $first: '$modelName' }, type: { $first: '$type' }, base: { $first: '$baseModel' } } },
    { $sort: { modelName: 1 } }, { $limit: 500 },
  ]).toArray();

  const checkpoints = rows.filter((r) => r.type !== 'lora');
  const loras       = rows.filter((r) => r.type === 'lora');

  return layout({
    site,
    title: 'AI models and LoRAs — example galleries from Civit.ai',
    description: 'Checkpoints and LoRAs seen on Civit.ai, each with a gallery of safe-for-work examples showing what the model actually produces.',
    canonical: `${site}/models`,
    indexable: rows.length > 0,
    body: `
    <section class="panel">
      <div class="panel-head"><h2>Models and LoRAs</h2></div>
      <p class="panel-note">What each model actually produces, shown through real posts rather than cherry-picked cover images.</p>
    </section>
    ${linkList('Checkpoints', checkpoints.map((r) => ({ href: `/model/${encodeURIComponent(r._id)}`, label: r.modelName })))}
    ${linkList('LoRAs', loras.map((r) => ({ href: `/lora/${encodeURIComponent(r._id)}`, label: r.modelName })))}`,
  });
}

/* ---- Sitemap ----
 * Derived from the corpus, so it can never drift from what actually renders.
 * Only entities past the quality gate are listed. */

async function sitemapUrls(db) {
  const [creators, models] = await Promise.all([
    db.collection('images').aggregate([
      { $group: { _id: '$usernameLower', username: { $first: '$username' }, n: { $sum: 1 }, last: { $max: '$lastSeenAt' } } },
      { $match: { n: { $gte: MIN_ITEMS } } }, { $sort: { n: -1 } }, { $limit: 20000 },
    ]).toArray(),
    // Counted through the images, not the versions: a model must clear the same
    // content gate its page enforces, or the sitemap would advertise URLs that
    // render noindex. Grouping by (slug, image) first keeps an image that uses
    // two versions of the same model from being counted twice.
    db.collection('images').aggregate([
      { $unwind: '$versionIds' },
      { $lookup: { from: 'modelversions', localField: 'versionIds', foreignField: '_id', as: 'v' } },
      { $unwind: '$v' },
      { $match: { 'v.dead': { $ne: true }, 'v.nsfw': false, 'v.poi': false } },
      { $group: { _id: { slug: '$v.slug', image: '$_id' }, type: { $first: '$v.type' } } },
      { $group: { _id: '$_id.slug', type: { $first: '$type' }, n: { $sum: 1 } } },
      { $match: { n: { $gte: MIN_ITEMS } } },
      { $sort: { n: -1 } }, { $limit: 20000 },
    ]).toArray(),
  ]);

  return [
    ...creators.map((c) => ({ loc: `/creator/${encodeURIComponent(c.username)}`, lastmod: c.last, priority: '0.8' })),
    ...models.map((m) => ({ loc: `/${m.type === 'lora' ? 'lora' : 'model'}/${encodeURIComponent(m._id)}`, priority: '0.7' })),
  ];
}

module.exports = { creatorPage, modelPage, creatorIndex, modelIndex, sitemapUrls, MIN_ITEMS };
