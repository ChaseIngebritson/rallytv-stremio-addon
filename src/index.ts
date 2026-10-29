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
  handleVodPlaylist,
  handleVodSegment,
  hasFfmpeg,
  parseConfigPath,
  pipeRemuxMpegTs,
  publicBaseUrl,
  remuxPlaylistUrl,
  remuxStreamUrl,
  resolveFfmpegPath,
} from './remux';
import { AddonConfig, EventCatalogKey, isRallyError } from './types/rally';
import { formatRuntimeMs } from './hlsMedia';

// Avoid 7000 — macOS AirPlay Receiver (ControlCenter/AirTunes) often owns it.
const PORT = Number(process.env.PORT || 3000);

/** SDK Args omit config; configurable addons receive it at runtime. */
interface HandlerArgs {
  type: ContentType;
  id: string;
  extra?: {
    search?: string;
    genre?: string;
    skip?: number;
    /** Comma-separated library meta IDs from Stremio Calendar */
    calendarVideosIds?: string;
  };
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
  // Hidden from Discover (extra is required). Stremio Calendar batches library IDs here.
  {
    id: 'calendar-videos',
    type: 'series',
    name: 'Calendar videos',
    // Match Cinemeta: modern `extra` + legacy extraSupported/extraRequired
    extra: [
      {
        name: 'calendarVideosIds' as import('stremio-addon-sdk').Extra,
        isRequired: true,
        optionsLimit: 100,
      },
    ],
    ...({
      extraSupported: ['calendarVideosIds'],
      extraRequired: ['calendarVideosIds'],
    } as object),
  } as ManifestCatalog,
];

const SEARCH_QUERIES: Record<string, string> = {
  stages: 'Full Stage Replay',
  highlights: 'Highlights',
};

const EVENT_CATALOG_IDS = new Set<string>(['featured', 'upcoming', 'wrc', 'erc']);

const manifest: Manifest = {
  id: 'community.rallytv',
  version: '1.4.1',
  name: 'Rally.tv',
  description:
    'Stremio addon for Rally.tv. Configure with your Auth0 token to get a private install URL. Events, stage replays, highlights. Clear HLS; demuxed A/V remuxed for Stremio. Add “WRC & Rally Calendar” to your Library for Stremio Calendar.',
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

    // Stremio Calendar: /catalog/series/calendar-videos/calendarVideosIds=id1,id2.json
    if (id === 'calendar-videos' && type === 'series') {
      const rawIds = extra?.calendarVideosIds || '';
      const allIds = String(rawIds)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ids = allIds.filter((s) => s.startsWith(rally.ID_PREFIX));
      console.log(
        `[catalog] calendarVideosIds total=${allIds.length} rallytv=${ids.length}`,
        ids.slice(0, 5),
      );
      if (!ids.length) {
        // No Rally.tv series in library — Calendar will stay empty for this addon.
        return { metasDetailed: [], cacheMaxAge: 300 } as unknown as { metas: MetaDetail[] };
      }
      const metasDetailed = await rally.buildCalendarMetasDetailed(ids, config || {});
      console.log(`[catalog] calendar metasDetailed=${metasDetailed.length}`);
      return {
        metasDetailed,
        cacheMaxAge: 600,
      } as unknown as { metas: MetaDetail[] };
    }

    if (EVENT_CATALOG_IDS.has(id) && type === 'series') {
      const skip = Number(extra?.skip) || 0;
      const metas = await rally.listEventCatalog(id as EventCatalogKey, config || {}, { skip });
      // Pin season calendar at the top of Featured / Upcoming so users can Library it once.
      if (skip === 0 && (id === 'featured' || id === 'upcoming')) {
        return { metas: [rally.seasonCalendarPreview(), ...metas], cacheMaxAge: 600 };
      }
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
    if (rally.isSeasonCalendarId(productId)) {
      const meta = await rally.buildSeasonCalendarMeta(config || {});
      return { meta, cacheMaxAge: 600 };
    }

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
          runtime: formatRuntimeMs(cached.duration, cached.formatted_duration),
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
            runtime: formatRuntimeMs(product.duration, product.formatted_duration),
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

    // Demuxed masters hang in Stremio — remux default audio + ~720p video.
    // VOD: muxed HLS (seekable + duration). Live: progressive MPEG-TS pipe.
    if (playable.remux?.videoUrl && playable.remux.audioUrl && hasFfmpeg()) {
      const base = publicBaseUrl(PORT);
      const configPath = encodeConfigPath(cfg);
      const stream = {
        name: 'Rally.tv',
        title: playable.live ? 'Live remux (A/V)' : 'Remuxed HLS (A/V, seekable)',
        url: playable.live
          ? remuxStreamUrl(base, productId, configPath)
          : remuxPlaylistUrl(base, productId, configPath),
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
app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});
app.get('/configure', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(landing);
});

function remuxConfigFromReq(req: express.Request): AddonConfig {
  const configParam = req.params.config;
  return parseConfigPath(Array.isArray(configParam) ? configParam[0] : configParam);
}

function parseProductId(req: express.Request): string | null {
  const productId = String(req.params.productId || '');
  return /^[0-9a-f-]{36}$/i.test(productId) ? productId : null;
}

/** Live progressive MPEG-TS remux. */
async function handleRemuxLive(req: express.Request, res: express.Response): Promise<void> {
  const productId = parseProductId(req);
  if (!productId) {
    res.status(400).type('text/plain').send('invalid product id');
    return;
  }

  const config = remuxConfigFromReq(req);
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
    console.log('[remux] live pipe', productId, audioUrl ? 'A/V' : 'video-only');
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

/** Seekable VOD: muxed HLS playlist. */
async function handleRemuxVodPlaylist(req: express.Request, res: express.Response): Promise<void> {
  const productId = parseProductId(req);
  if (!productId) {
    res.status(400).type('text/plain').send('invalid product id');
    return;
  }
  if (!hasFfmpeg()) {
    res.status(503).type('text/plain').send('ffmpeg not installed on addon host');
    return;
  }

  try {
    const config = remuxConfigFromReq(req);
    const playable = await rally.resolvePlayableStream(productId, config);
    const videoUrl = playable.remux?.videoUrl;
    if (!videoUrl) {
      res.status(404).type('text/plain').send('no remuxable renditions for this title');
      return;
    }
    console.log('[remux] vod playlist', productId);
    await handleVodPlaylist({
      productId,
      videoUrl,
      audioUrl: playable.remux?.audioUrl || null,
      headers: playable.headers,
      res,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[remux] playlist', message);
    if (!res.headersSent) res.status(502).type('text/plain').send(message);
  }
}

/** Seekable VOD: on-demand muxed MPEG-TS segment. */
async function handleRemuxVodSegment(req: express.Request, res: express.Response): Promise<void> {
  const productId = parseProductId(req);
  if (!productId) {
    res.status(400).type('text/plain').send('invalid product id');
    return;
  }
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).type('text/plain').send('invalid segment index');
    return;
  }
  if (!hasFfmpeg()) {
    res.status(503).type('text/plain').send('ffmpeg not installed on addon host');
    return;
  }

  try {
    const config = remuxConfigFromReq(req);
    const playable = await rally.resolvePlayableStream(productId, config);
    const videoUrl = playable.remux?.videoUrl;
    if (!videoUrl) {
      res.status(404).type('text/plain').send('no remuxable renditions for this title');
      return;
    }
    await handleVodSegment({
      productId,
      videoUrl,
      audioUrl: playable.remux?.audioUrl || null,
      headers: playable.headers,
      index,
      res,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[remux] segment', index, message);
    if (!res.headersSent) res.status(502).type('text/plain').send(message);
  }
}

// Must be registered before the SDK router so /:config/... is not swallowed.
app.get('/remux/:productId/stream.ts', (req, res) => {
  void handleRemuxLive(req, res);
});
app.get('/:config/remux/:productId/stream.ts', (req, res) => {
  void handleRemuxLive(req, res);
});
app.get('/remux/:productId/index.m3u8', (req, res) => {
  void handleRemuxVodPlaylist(req, res);
});
app.get('/:config/remux/:productId/index.m3u8', (req, res) => {
  void handleRemuxVodPlaylist(req, res);
});
app.get('/remux/:productId/seg/:index.ts', (req, res) => {
  void handleRemuxVodSegment(req, res);
});
app.get('/:config/remux/:productId/seg/:index.ts', (req, res) => {
  void handleRemuxVodSegment(req, res);
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
