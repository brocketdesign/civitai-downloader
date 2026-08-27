# 🖼 Civitai Downloader

> Browse and bulk-download images & videos from any Civitai user profile — powered by the official public API, no scraping.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔗 **Paste any Civitai URL** | Supports `civitai.com` and `civitai.red` (e.g. `.../user/someone/images`) |
| 🖼 **Grid preview** | Lazy-loaded thumbnails with hover-to-play for videos |
| 🎬 **Video support** | Auto-plays on hover in grid; full playback in lightbox |
| 🔍 **Filter & sort** | Filter by type (image / video) and sort by Newest, Most Reactions, etc. |
| ♾ **Load All Pages** | Auto-paginates through all content with progress display |
| ✅ **Multi-select** | Per-card checkboxes + Select All / Deselect All |
| 🔎 **Lightbox** | Full-size preview, arrow key navigation, generation metadata |
| ✨ **Send to a character** | Push a selection to [Chatlamix](https://chatlamix.com) as an AI character you can chat with |
| 🎭 **Gallery dashboard** | Connect your own Chatlamix API key at `/gallery`, create characters, and see the ones you made |
| 🔎 **Search-minted SEO pages** | Every search mints a crawlable creator / model / LoRA page — safe-for-work only, indexed once it has enough content |
| 📦 **Download as ZIP** | Server fetches & streams a ZIP of selected files (5 concurrent) |
| 📋 **Copy URLs** | Clipboard copy for use with aria2, wget, or any download manager |
| 💾 **Save URL list** | Exports a `.txt` TSV file of URLs + filenames |
| 🕐 **Search history** | Recent usernames remembered in localStorage |
| 🔑 **Optional API key** | Stored in localStorage; required for NSFW content |

---

## 🚀 Quick Start

```bash
git clone https://github.com/brocketdesign/civitai-downloader.git
cd civitai-downloader
npm install
npm start
```

Open **http://localhost:3456** in your browser.

> **Node ≥ 18** is required (uses the built-in `fetch` API).

---

## 🖥 Usage

1. **Paste a Civitai profile URL** or just a username into the search bar.  
   Example: `https://civitai.com/user/someone/images`
2. Click **Load** — thumbnails appear in a responsive grid.
3. Use the **type** and **sort** dropdowns to filter.
4. Click **Load All Pages** to fetch every page automatically.
5. **Click cards** (or use checkboxes) to select images/videos.
6. Choose your export:
   - **Download ZIP** — server bundles selected files into a ZIP.
   - **Copy URLs** — paste into aria2, wget, etc.
   - **Save URL list** — download a TSV file.

### NSFW content

1. Go to [Civitai → Settings → API Keys](https://civitai.com/user/account) and generate a key.
2. Click the 🔑 **API Key** button in the app and paste it.
3. Enable the **🔞 NSFW** toggle.

---

## 🎭 Chatlamix integration

Open **`/gallery`**, paste an API key from your own
[Chatlamix](https://chatlamix.com) account, and you can turn
Civitai artwork into a character you can talk to.

The key is held in **your browser's local storage** and travels as an
`X-MAM-Key` header on your own requests. The server never stores it, so two
people using the same deployment only ever see characters belonging to their
own key. Media is passed to the platform as Civitai CDN URLs, which it fetches
itself — nothing is proxied or cached here.

| Variable | Purpose |
|---|---|
| `SITE_URL` | Public origin, used for canonical/Open Graph URLs, `robots.txt` and `sitemap.xml`. Falls back to the request host. |
| `BRAND_NAME` | Display name. Defaults to `Chatlamix`. |
| `BRAND_URL` | Where the promo links point. Defaults to `https://chatlamix.com`. |
| `BRAND_LOGIN_URL` | Where the "chat" / "animate" calls to action land. Defaults to `$BRAND_URL/login`. |
| `BRAND_LOGO` | Logo path served from `public/`. Defaults to `/img/mam-logo.png`. |
| `BRAND_TAGLINE` | Footer descriptor. Defaults to `the AI companion app`. |
| `MAM_API_URL` | API origin. Defaults to `https://myaimodelmanager.com` — deliberately **not** derived from `BRAND_URL`, because the branding changes while the backend does not. |
| `MONGODB_URI` | Enables the SEO pages. Unset, minting and `/creator`, `/model`, `/lora` are switched off and the rest of the app runs normally. |
| `MONGODB_DB` | Database name. Defaults to `civitai_seo`. |
| `SEO_MIN_ITEMS` | Images an entity needs before its page is indexable and enters the sitemap. Defaults to `12`. |

## 🔌 API

The app proxies two endpoints through a local Express server:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/images` | Fetch images for a username (proxied to Civitai API) |
| `POST` | `/api/download` | Bulk-download selected items and stream as ZIP |

Civitai REST API used internally:
```
GET https://civitai.com/api/v1/images?username=X&sort=Newest&limit=100
```

- No auth required for SFW content.
- NSFW requires a Bearer token (`Authorization: Bearer <apiKey>`).
- Pagination via cursor (`metadata.nextCursor`).

---

## 🛠 Tech Stack

- **Backend** — Node.js + Express, `archiver` for ZIP streaming
- **Frontend** — Vanilla JS, no framework
- **Styling** — Plain CSS with CSS variables

---

## 📄 License

[MIT](LICENSE) — free to use, fork, and modify.


---

## 🔎 Search-minted SEO pages

Searching a creator does double duty: the images it pulls are kept in MongoDB,
and that corpus backs a set of server-rendered pages.

| Route | What it is |
|---|---|
| `/creator/:username` | A creator's safe-for-work gallery, the models they use, creators with a similar style |
| `/model/:slug` | Everything made with one checkpoint, and who made it |
| `/lora/:slug` | The same for a LoRA |
| `/creators`, `/models` | Indexes, so no minted page is an orphan |
| `/sitemap.xml` | Derived from the corpus — it cannot list a page that would not render |

Two rules keep this from turning into a thin-page farm:

- **A page must earn its place.** Below `SEO_MIN_ITEMS` images it renders
  `noindex` and stays out of the sitemap. It still works for anyone following a
  link; it just is not offered to crawlers.
- **Nothing adult is indexed.** The gate in `lib/mint.js` fails closed: an image
  is kept only if `nsfw === false` *and* `nsfwLevel === 'None'` *and*
  `browsingLevel <= 1`. Models flagged `nsfw` or `poi` (trained on a real
  person's likeness) never get a page.

Minting is fire-and-forget — a slow or missing database never delays a search.
