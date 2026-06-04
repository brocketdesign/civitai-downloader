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
