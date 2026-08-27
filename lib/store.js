/* MongoDB access.
 *
 * The store exists only to back the SEO pages: it remembers the images seen by
 * searches so those searches can be turned into crawlable pages later. Nothing
 * the downloader itself does depends on it, so a missing MONGODB_URI degrades
 * to "SEO pages are off" rather than to a broken site.
 */

const { MongoClient } = require('mongodb');

const URI    = process.env.MONGODB_URI || '';
const DBNAME = process.env.MONGODB_DB  || 'civitai_seo';

let clientPromise = null;
let warned = false;

const enabled = () => Boolean(URI);

async function connect() {
  const client = new MongoClient(URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
  });
  await client.connect();
  const db = client.db(DBNAME);
  await ensureIndexes(db);
  console.log(`[store] connected to ${DBNAME}`);
  return db;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('images').createIndex({ usernameLower: 1, reactions: -1 }),
    db.collection('images').createIndex({ versionIds: 1 }),
    db.collection('images').createIndex({ baseModelSlug: 1 }),
    db.collection('images').createIndex({ mintedAt: -1 }),
    db.collection('modelversions').createIndex({ slug: 1, type: 1 }),
    db.collection('creators').createIndex({ lastSearchedAt: -1 }),
  ]);
}

/** Resolves to a Db, or null when the store is switched off or unreachable. */
async function getDb() {
  if (!enabled()) {
    if (!warned) {
      warned = true;
      console.warn('[store] MONGODB_URI not set — SEO pages and minting are disabled.');
    }
    return null;
  }
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      console.error('[store] connection failed:', err.message);
      clientPromise = null;   // let a later request try again
      return null;
    });
  }
  return clientPromise;
}

module.exports = { getDb, enabled };
