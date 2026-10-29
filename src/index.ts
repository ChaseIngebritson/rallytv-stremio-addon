import express from 'express';
import {
  addonBuilder,
  getRouter,
  type ContentType,
  type Manifest,
  type ManifestCatalog,
  type MetaDetail,
} from 'stremio-addon-sdk';
import { configurePage } from './configurePage';
import * as rally from './rallytv';
import {
  encodeConfigPath,
  hasFfmpeg,
  parseConfigPath,
  pipeRemuxMpegTs,
  publicBaseUrl,
  remuxStreamUrl,
  resolveFfmpegPath,
} from './remux';
import { AddonConfig, EventCatalogKey, isRallyError } from './types/rally';

// Avoid 7000 — macOS AirPlay Receiver (ControlCenter/AirTunes) often owns it.
const PORT = Number(process.env.PORT || 3000);

/** SDK Args omit config; configurable addons receive it at runtime. */
interface HandlerArgs {
  type: ContentType;
  id: string;
  extra?: { search?: string; genre?: string; skip?: number };
  config?: AddonConfig;
}

const CATALOGS: ManifestCatalog[] = [
  {
    id: 'live',
    type: 'tv',
    name: 'Live TV',
    extra: [],
  },
  {
    id: 'featured',
    type: 'series',
    name: 'Featured Events',
    extra: [{ name: 'skip', isRequired: false }],
  },
  {
    id: 'upcoming',
    type: 'series',
    name: 'Upcoming Events',
    extra: [{ name: 'skip', isRequired: false }],
  },
  {
    id: 'wrc',
    type: 'series',
    name: 'Past WRC Events',
    extra: [{ name: 'skip', isRequired: false }],
  },
  {
    id: 'erc',
    type: 'series',
    name: 'Past ERC Events',
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

const SEARCH_QUERIES: Record<string, string> = {
  stages: 'Full Stage Replay',
  highlights: 'Highlights',
};

const EVENT_CATALOG_IDS = new Set<string>(['featured', 'upcoming', 'wrc', 'erc']);

const manifest: Manifest = {
  id: 'community.rallytv.personal',
  version: '1.3.0',
  name: 'Rally.tv (Personal)',
  description:
    'Personal addon for Rally.tv. Configure with your Auth0 token to get a private install URL. Events, stage replays, highlights. Clear HLS; demuxed A/V remuxed for Stremio.',
  logo: 'https://res.cloudinary.com/hhhkasdw4/image/upload/f_png/streaming-platform/smarttv/rallytv/logos/logo_samsung_continue_watching.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'tv', 'series'],
  idPrefixes: [rally.ID_PREFIX],
  catalogs: CATALOGS,
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  // @types marks `required` as string; Stremio expects boolean
  config: [
    {
      key: 'authToken',
      type: 'password',
      title: 'Auth0 access token',
      required: true as unknown as string,
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

function pageSlice<T>(items: T[], skip: unknown): T[] {
  const offset = Number(skip) || 0;
  return items.slice(offset, offset + 40);
}

builder.defineCatalogHandler(async (rawArgs) => {
  const { type, id, extra, config } = rawArgs as HandlerArgs;
  try {
    if (id === 'live' && type === 'tv') {
      return {
        metas: [rally.liveChannelMeta()],
        cacheMaxAge: 300,
      };
    }

    if (EVENT_CATALOG_IDS.has(id) && type === 'series') {
      const metas = await rally.listEventCatalog(id as EventCatalogKey, config || {}, {
        skip: Number(extra?.skip) || 0,
      });
      return { metas, cacheMaxAge: 600 };
    }

    const query = id === 'search' ? extra?.search || '' : SEARCH_QUERIES[id];

    if (!query) {
      return { metas: [] };
    }

    const { json } = await rally.search(query, { limit: 50, config: config || {} });

    if (id === 'search') {
      const events = rally.collectEventPages(json).map(rally.itemToMetaPreview);
      const videos = rally.collectPlayableVideos(json).map(rally.itemToMetaPreview);
      const metas = pageSlice([...events, ...videos], extra?.skip);
      return { metas, cacheMaxAge: 300 };
    }

    const videos = rally.collectPlayableVideos(json);
    const metas = pageSlice(videos, extra?.skip).map(rally.itemToMetaPreview);
    return { metas, cacheMaxAge: 300 };
  } catch (err) {
    if (isRallyError(err) && err.code === 'REAUTH') {
      console.error('[catalog] re-auth required');
      return { metas: [] };
    }
    console.error('[catalog]', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async (rawArgs) => {
  const { type, id, config } = rawArgs as HandlerArgs;
  const productId = rally.parseId(id);
  if (!productId) return { meta: null as unknown as MetaDetail };

  if (productId === rally.PRODUCTS.live) {
    const meta: MetaDetail = {
      ...rally.liveChannelMeta(),
      type: 'tv',
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

  try {
    if (type === 'series') {
      const meta = await rally.buildEventSeriesMeta(productId, config || {});
      return { meta, cacheMaxAge: 600 };
    }

    try {
      const product = await rally.getProduct(productId, config || {});
      if (
        product.type === 'page' &&
        (product.content_type === 'stop' || product.content_type === 'event')
      ) {
        const meta = await rally.buildEventSeriesMeta(productId, config || {});
        return { meta, cacheMaxAge: 600 };
      }
    } catch {
      // fall through to video meta
    }

    const cached = rally.getCachedItem(productId);
    if (cached && cached.type === 'video') {
      const preview = rally.itemToMetaPreview(cached);
      return {
        meta: {
          ...preview,
          type: 'movie',
          runtime:
            cached.formatted_duration ||
            (cached.duration ? `${Math.round(cached.duration / 60000)} min` : undefined),
        },
        cacheMaxAge: 600,
      };
    }

    try {
      const product = await rally.getProduct(productId, config || {});
      if (product.type === 'video') {
        const preview = rally.itemToMetaPreview(product);
        return {
          meta: {
            ...preview,
            type: 'movie',
            runtime:
              product.formatted_duration ||
              (product.duration ? `${Math.round(product.duration / 60000)} min` : undefined),
          },
          cacheMaxAge: 600,
        };
      }
    } catch {
      // ignore
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[meta]', message);
    return { meta: null as unknown as MetaDetail };
  }
});

builder.defineStreamHandler(async (rawArgs) => {
  const { id, config } = rawArgs as HandlerArgs;
  const productId = rally.parseId(id);
  if (!productId) return { streams: [] };

  // Event pages themselves are not playable — only their episode video IDs are.
  // Stremio still sends type=series for episode stream requests, so detect by product.
  const cached = rally.getCachedItem(productId);
  if (cached?.type === 'page') {
    return { streams: [] };
  }

  try {
    const playable = await rally.resolvePlayableStream(productId, config || {});
    const cfg = config || {};

    // Demuxed masters hang in Stremio — remux default audio + ~720p video to MPEG-TS.
    if (playable.remux?.videoUrl && playable.remux.audioUrl && hasFfmpeg()) {
      const base = publicBaseUrl(PORT);
      const configPath = encodeConfigPath(cfg);
      const stream = {
        name: 'Rally.tv',
        title: playable.live ? 'Live remux (A/V)' : 'Remuxed TS (A/V)',
        url: remuxStreamUrl(base, productId, configPath),
        behaviorHints: {
          notWebReady: true,
          bingeGroup: 'rallytv-remux',
        },
      } as const;
      return { streams: [stream as unknown as import('stremio-addon-sdk').Stream], cacheMaxAge: 60 };
    }

    // No ffmpeg or audio-less demux: fall back to a single video media playlist (may be silent).
    if (playable.remux?.videoUrl) {
      if (playable.remux.audioUrl && !hasFfmpeg()) {
        console.warn('[stream] demuxed A/V but ffmpeg missing — returning video-only playlist');
      }
      const stream = {
        name: 'Rally.tv',
        title: playable.live ? 'Live video (no mux)' : 'HLS video (may be silent)',
        url: playable.remux.videoUrl,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: 'rallytv-hls',
          proxyHeaders: {
            request: playable.headers,
          },
        },
      } as const;
      return { streams: [stream as unknown as import('stremio-addon-sdk').Stream], cacheMaxAge: 60 };
    }

    // bingeGroup / proxyHeaders are used by Stremio but missing from @types
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
    } as const;
    return { streams: [stream as unknown as import('stremio-addon-sdk').Stream], cacheMaxAge: 60 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stream]', message);
    if (isRallyError(err) && (err.code === 'DRM' || err.code === 'REAUTH')) {
      return { streams: [] };
    }
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();
const app = express();
const landing = configurePage(manifest);

app.get('/', (_req, res) => {
  res.redirect(302, '/configure');
});
app.get('/configure', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(landing);
});

async function handleRemux(req: express.Request, res: express.Response): Promise<void> {
  const productId = String(req.params.productId || '');
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    res.status(400).type('text/plain').send('invalid product id');
    return;
  }

  const configParam = req.params.config;
  const config = parseConfigPath(Array.isArray(configParam) ? configParam[0] : configParam);
  if (!hasFfmpeg()) {
    res.status(503).type('text/plain').send('ffmpeg not installed on addon host');
    return;
  }

  try {
    const playable = await rally.resolvePlayableStream(productId, config);
    const videoUrl = playable.remux?.videoUrl;
    const audioUrl = playable.remux?.audioUrl || null;
    if (!videoUrl) {
      res.status(404).type('text/plain').send('no remuxable renditions for this title');
      return;
    }
    console.log('[remux] start', productId, audioUrl ? 'A/V' : 'video-only');
    pipeRemuxMpegTs({
      videoUrl,
      audioUrl,
      headers: playable.headers,
      req,
      res,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[remux]', message);
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(message);
    }
  }
}

// Must be registered before the SDK router so /:config/... is not swallowed.
app.get('/remux/:productId/stream.ts', (req, res) => {
  void handleRemux(req, res);
});
app.get('/:config/remux/:productId/stream.ts', (req, res) => {
  void handleRemux(req, res);
});

// Stremio protocol: /:config?/manifest.json and catalog/meta/stream routes
app.use(getRouter(addonInterface));

app.listen(PORT, () => {
  console.log(`Rally.tv Stremio addon listening on :${PORT}`);
  console.log(`Configure (get token-aware manifest): http://127.0.0.1:${PORT}/configure`);
  const ff = resolveFfmpegPath();
  console.log(
    ff
      ? `ffmpeg remux: available (${ff})`
      : 'ffmpeg remux: MISSING — demuxed titles fall back to video-only',
  );
  console.log(`Public base URL: ${publicBaseUrl(PORT)}`);
});

export { addonInterface, app };
