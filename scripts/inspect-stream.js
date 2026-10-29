'use strict';

/**
 * Spike helper: obtain an anonymous session, search once, fetch one VOD + live
 * playlist, and print a DRM verdict. Does not store secrets.
 *
 * Usage:
 *   node scripts/inspect-stream.js
 *   node scripts/inspect-stream.js "Full Stage Replay"
 *   RALLYTV_AUTH_TOKEN=... node scripts/inspect-stream.js
 */

const rally = require('../src/rallytv');
const { inspectPlaylistForDrm } = require('../src/drm');

async function inspectProduct(label, productId, config) {
  console.log(`\n=== ${label} (${productId}) ===`);
  try {
    const playable = await rally.resolvePlayableStream(productId, config);
    console.log('play URL:', playable.url);
    const res = await fetch(playable.url, { headers: playable.headers });
    const body = await res.text();
    console.log('HTTP', res.status);
    console.log('master DRM:', inspectPlaylistForDrm(body));
    console.log('master head:\n' + body.split('\n').slice(0, 12).join('\n'));
    return true;
  } catch (err) {
    console.error('FAILED:', err.message);
    return false;
  }
}

async function main() {
  const query = process.argv[2] || 'Full Stage Replay';
  const config = {
    authToken: process.env.RALLYTV_AUTH_TOKEN || '',
    locale: process.env.RALLYTV_LOCALE || 'en',
    country: process.env.RALLYTV_COUNTRY || 'us',
  };

  const session = await rally.getAnonymousSession();
  console.log('Anonymous session ok; country=', session.country, 'expires=', new Date(session.expiresAt).toISOString());

  const { json } = await rally.search(query, { limit: 10, config });
  const videos = rally.collectPlayableVideos(json);
  console.log(`Search "${query}" → ${videos.length} playable videos`);
  for (const v of videos.slice(0, 5)) {
    console.log('-', v.id, v.title, v.content_entitlements || []);
  }

  const vodId = videos[0]?.id;
  const results = [];
  results.push(['live', await inspectProduct('Live 24/7', rally.PRODUCTS.live, config)]);
  if (vodId) {
    results.push(['vod', await inspectProduct('Sample VOD', vodId, config)]);
  } else {
    console.log('No VOD sample from search');
  }

  const failed = results.filter(([, ok]) => !ok);
  if (failed.length) {
    console.error('\nDRM/play gate FAILED for:', failed.map(([n]) => n).join(', '));
    process.exit(2);
  }
  console.log('\nDRM gate PASS — clear HLS available for inspected assets.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
