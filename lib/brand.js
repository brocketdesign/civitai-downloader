/* Brand configuration.
 *
 * The site is a promo surface for an AI companion app, and the app is sold
 * under more than one name. Everything user-facing comes from BRAND; the API
 * origin is deliberately NOT derived from it, because the branding URL changes
 * while the backend it talks to does not.
 */

const strip = (s) => String(s || '').replace(/\/$/, '');

const url = strip(process.env.BRAND_URL || 'https://chatlamix.com');

const BRAND = {
  name:     process.env.BRAND_NAME || 'Chatlamix',
  url,
  loginUrl: strip(process.env.BRAND_LOGIN_URL) || `${url}/login`,
  logo:     process.env.BRAND_LOGO || '/img/mam-logo.png',
  tagline:  process.env.BRAND_TAGLINE || 'the AI companion app',
};

// The upstream API. Same backend regardless of which brand name is on the tin,
// so it defaults to its own origin rather than to BRAND.url.
const API_ORIGIN = strip(process.env.MAM_API_URL || 'https://myaimodelmanager.com');

// Where a character ends up, chosen per character from its image style and use
// case: photorealistic professional -> MyAIModelManager, photorealistic casual
// -> Chatlamix, anime -> Seisei. Each exposes the same external API.
const DESTINATIONS = {
  mymodelmanager: {
    key: 'mymodelmanager',
    name: 'MyAIModelManager',
    api: API_ORIGIN,
    url: strip(process.env.MAM_PRO_URL || 'https://mymodelmanager.com'),
  },
  chatlamix: {
    key: 'chatlamix',
    name: 'Chatlamix',
    api: strip(process.env.MAM_CASUAL_API_URL || 'https://chatlamix.com'),
    url: strip(process.env.MAM_CASUAL_URL || 'https://chatlamix.com'),
  },
  seisei: {
    key: 'seisei',
    name: 'Seisei',
    api: strip(process.env.MAM_ANIME_API_URL || 'https://seisei.me'),
    url: strip(process.env.MAM_ANIME_URL || 'https://seisei.me'),
  },
};

module.exports = { BRAND, API_ORIGIN, DESTINATIONS };
