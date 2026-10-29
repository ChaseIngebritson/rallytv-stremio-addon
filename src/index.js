'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const rally = require('./rallytv');

// Avoid 7000 — macOS AirPlay Receiver (ControlCenter/AirTunes) often owns it.
const PORT = Number(process.env.PORT || 3000);

const CATALOGS = [
  {
    id: 'live',
    type: 'tv',
    name: 'Live TV',
    extra: [],
  },
  {
    id: 'latest',
    type: 'movie',
    name: 'Latest Videos',
    extra: [{ name: 'skip', isRequired: false }],
  },
  {
    id: 'stages',
    type: 'movie',
    name: 'Stage Replays',
    extra: [{ name: 'skip', isRequired: false }],
  },
  {
    id: 'highlights',
    type: 'movie',
    name: 'Highlights',
    extra: [{ name: 'skip', isRequired: false }],
  },
  {
    id: 'search',
    type: 'movie',
    name: 'Rally.tv Search',
    extra: [
      { name: 'search', isRequired: true },
      { name: 'skip', isRequired: false },
    ],
  },
];

const SEARCH_QUERIES = {
  latest: '2026',
  stages: 'Full Stage Replay',
  highlights: 'Highlights',
};

const manifest = {
  id: 'community.rallytv.personal',
  version: '1.0.0',
  name: 'Rally.tv (Personal)',
  description:
    'Personal LAN addon for Rally.tv. Plays clear HLS only; DRM-protected assets are refused. Optional Auth0 token for entitlement.',
  logo: 'https://res.cloudinary.com/hhhkasdw4/image/upload/f_png/streaming-platform/smarttv/rallytv/logos/logo_samsung_continue_watching.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'tv'],
  idPrefixes: [rally.ID_PREFIX],
  catalogs: CATALOGS,
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
  config: [
    {
      key: 'authToken',
      type: 'password',
      title: 'Auth0 access token (optional)',
    },
    {
      key: 'locale',
      type: 'text',
      title: 'Locale (default en)',
      default: 'en',
    },
    {
      key: 'country',
      type: 'text',
      title: 'Country code (default us / session)',
      default: 'us',
    },
  ],
};

const builder = new addonBuilder(manifest);

function pageSlice(items, skip) {
  const offset = Number(skip) || 0;
  return items.slice(offset, offset + 40);
}

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
  try {
    if (id === 'live' && type === 'tv') {
      return {
        metas: [rally.liveChannelMeta()],
        cacheMaxAge: 300,
      };
    }

    const query =
      id === 'search'
        ? (extra && extra.search) || ''
        : SEARCH_QUERIES[id];

    if (!query) {
      return { metas: [] };
    }

    const { json } = await rally.search(query, { limit: 50, config: config || {} });
    const videos = rally.collectPlayableVideos(json);
    const metas = pageSlice(videos, extra && extra.skip).map(rally.itemToMetaPreview);
    return { metas, cacheMaxAge: 300 };
  } catch (err) {
    if (err.code === 'REAUTH') {
      console.error('[catalog] re-auth required');
      return { metas: [] };
    }
    console.error('[catalog]', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id, config }) => {
  const productId = rally.parseId(id);
  if (!productId) return { meta: null };

  if (productId === rally.PRODUCTS.live) {
    const meta = {
      ...rally.liveChannelMeta(),
      type: type === 'tv' ? 'tv' : 'tv',
      videos: [
        {
          id: rally.toMetaId(productId),
          title: 'Live',
          released: new Date().toISOString(),
        },
      ],
    };
    return { meta, cacheMaxAge: 300 };
  }

  const cached = rally.getCachedItem(productId);
  if (cached) {
    const preview = rally.itemToMetaPreview(cached);
    return {
      meta: {
        ...preview,
        type: 'movie',
        runtime: cached.duration ? `${Math.round(cached.duration / 60000)} min` : undefined,
      },
      cacheMaxAge: 600,
    };
  }

  return {
    meta: {
      id: rally.toMetaId(productId),
      type: 'movie',
      name: 'Rally.tv video',
      poster: rally.resourceUrl(productId),
      posterShape: 'landscape',
      background: rally.resourceUrl(productId, 'rbtv_background_landscape'),
    },
    cacheMaxAge: 300,
  };
});

builder.defineStreamHandler(async ({ type, id, config }) => {
  const productId = rally.parseId(id);
  if (!productId) return { streams: [] };

  try {
    const playable = await rally.resolvePlayableStream(productId, config || {});
    const stream = {
      name: 'Rally.tv',
      title: playable.live ? 'Live HLS (clear)' : 'HLS (clear)',
      url: playable.url,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'rallytv-hls',
        proxyHeaders: {
          request: playable.headers,
        },
      },
    };
    if (playable.live) {
      stream.behaviorHints = {
        ...stream.behaviorHints,
      };
    }
    return { streams: [stream], cacheMaxAge: 60 };
  } catch (err) {
    console.error('[stream]', err.message);
    if (err.code === 'DRM') {
      // Stremio cannot play DRM; return no streams (see docs/api-notes.md).
      return { streams: [] };
    }
    if (err.code === 'REAUTH') {
      return { streams: [] };
    }
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();

serveHTTP(addonInterface, { port: PORT })
  .then((server) => {
    const url =
      (server && server.url) ||
      `http://127.0.0.1:${PORT}/manifest.json`;
    const installUrl = url.includes('manifest.json')
      ? url
      : `${String(url).replace(/\/$/, '')}/manifest.json`;
    console.log(`Rally.tv Stremio addon listening`);
    console.log(`Install in Stremio: ${installUrl}`);
    console.log('Optional: configure Auth0 access token in addon settings if play returns 401/403.');
  })
  .catch((err) => {
    console.error('Failed to start addon:', err.message);
    process.exit(1);
  });

module.exports = { addonInterface };
