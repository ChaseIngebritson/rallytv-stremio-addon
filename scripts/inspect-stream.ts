/**
 * Spike helper: obtain an anonymous session, search once, fetch one VOD + live
 * playlist, and print a DRM verdict. Does not store secrets.
 *
 * Usage:
 *   npm run inspect
 *   npm run inspect -- "Full Stage Replay"
 *   RALLYTV_AUTH_TOKEN=... npm run inspect
 */

import { inspectPlaylistForDrm } from '../src/drm';
import * as rally from '../src/rallytv';
import type { AddonConfig } from '../src/types/rally';

async function inspectProduct(
  label: string,
  productId: string,
  config: AddonConfig,
): Promise<boolean> {
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
    const message = err instanceof Error ? err.message : String(err);
    console.error('FAILED:', message);
    return false;
  }
}

async function main(): Promise<void> {
  const query = process.argv[2] || 'Full Stage Replay';
  const config: AddonConfig = {
    authToken: process.env.RALLYTV_AUTH_TOKEN || '',
    locale: process.env.RALLYTV_LOCALE || 'en',
    country: process.env.RALLYTV_COUNTRY || 'us',
  };

  const session = await rally.getAnonymousSession();
  console.log(
    'Anonymous session ok; country=',
    session.country,
    'expires=',
    new Date(session.expiresAt).toISOString(),
  );

  const { json } = await rally.search(query, { limit: 10, config });
  const videos = rally.collectPlayableVideos(json);
  console.log(`Search "${query}" → ${videos.length} playable videos`);
  for (const v of videos.slice(0, 5)) {
    console.log('-', v.id, v.title, v.content_entitlements || []);
  }

  const vodId = videos[0]?.id;
  const results: Array<[string, boolean]> = [];
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
