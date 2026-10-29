import type { MetaDetail, MetaPreview, MetaVideo } from 'stremio-addon-sdk';
import { inspectPlaylistForDrm } from './drm';
import { formatRuntimeMs } from './hlsMedia';
import { parseMasterPlaylist, pickAudioRendition, pickVideoRendition } from './hlsMaster';
import {
  AddonConfig,
  AnonymousSession,
  EventCatalogKey,
  PlayableStream,
  RallyCollection,
  RallyDynamicProduct,
  RallyEntity,
  RallyError,
  RallyProduct,
  RallySearchResponse,
} from './types/rally';

const API_BASE = 'https://api.redbull.tv';
const TV_API_BASE = 'https://tv-api.redbull.com';
const PLAY_BASE = 'https://play.redbull.com';
const RESOURCES_BASE = 'https://resources.redbull.tv';
const NAMESPACE = 'rallytv';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Known product IDs from the Rally.tv web client config */
export const PRODUCTS = {
  live: '07f960dc-fd36-466c-971f-64a597518b83',
  home: 'cf269838-e40a-5bd9-8868-6b96e03e7598',
  epg: '15fed5e0-382f-5f93-af43-850feae5b47d',
  events: '420b28f8-26c0-566a-bbd5-ed5f171182a7',
  search: 'd7cc4789-db63-5cd1-8d3f-7aece4d36ce6',
} as const;

/**
 * Synthetic series: add once to Stremio Library to populate Calendar with
 * Featured + Upcoming rally weekends (Stremio Calendar only loads library IDs).
 */
export const SEASON_CALENDAR_ID = 'season-calendar';

export function seasonCalendarMetaId(): string {
  return toMetaId(SEASON_CALENDAR_ID);
}

export function isSeasonCalendarId(productId: string | null | undefined): boolean {
  return productId === SEASON_CALENDAR_ID;
}

/** Collection labels on the Events hub we surface as Stremio catalogs */
export const EVENT_CATALOG_COLLECTIONS: Record<EventCatalogKey, string> = {
  featured: 'Calendar Featured',
  upcoming: 'Upcoming Events',
  wrc: 'Past WRC Events',
  erc: 'Past ERC Events',
};

/** Skip recommendation / related rails when building a rally series */
const SKIP_COLLECTION_TYPES = new Set(['recommendations']);
const SKIP_COLLECTION_LABELS = new Set(['Related events', 'Related videos']);

export const ID_PREFIX = 'rallytv:';

let cachedSession: AnonymousSession | null = null;
const itemCache = new Map<string, RallyEntity>();
const productCache = new Map<string, RallyProduct>();

/** Short-lived playable cache — VOD remux hits resolve on every HLS segment. */
const PLAYABLE_TTL_MS = 2 * 60 * 1000;
const playableCache = new Map<string, { value: PlayableStream; expiresAt: number }>();

function playableCacheKey(productId: string, config: AddonConfig): string {
  return `${productId}|${config.authToken || ''}|${config.locale || 'en'}|${config.country || ''}`;
}

export function rememberItem<T extends RallyEntity>(item: T): T {
  if (item?.id) itemCache.set(item.id, item);
  return item;
}

export function getCachedItem(productId: string): RallyEntity | null {
  return itemCache.get(productId) || null;
}

export function resourceUrl(id: string, kind = 'rbtv_display_art_portrait'): string {
  return `${RESOURCES_BASE}/${id}/${kind}/`;
}

function mediaUrl(entity: RallyEntity | undefined, kind = 'rbtv_display_art_landscape'): string | undefined {
  const raw = entity?.media_resources?.[kind as keyof NonNullable<RallyEntity['media_resources']>]?.url;
  if (raw) return raw.replace('{im}', 'f_auto,c_limit,w_1280,q_80');
  if (entity?.id) return resourceUrl(entity.id, kind);
  return undefined;
}

export function playUrl(
  productId: string,
  { locale = 'en', country = 'us' }: { locale?: string; country?: string } = {},
): string {
  return `${PLAY_BASE}/main/v1/${NAMESPACE}/${locale}/${country}/personal_computer/http/${productId}.m3u8?device_group=group_5`;
}

export function parseId(id: string | undefined | null): string | null {
  if (!id || !id.startsWith(ID_PREFIX)) return null;
  return id.slice(ID_PREFIX.length);
}

export function toMetaId(productId: string): string {
  return `${ID_PREFIX}${productId}`;
}

function localeCountry(config: AddonConfig = {}, session: Partial<AnonymousSession> = {}) {
  return {
    locale: config.locale || 'en',
    country: config.country || session.country || 'us',
  };
}

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Origin: 'https://www.rally.tv',
      Referer: 'https://www.rally.tv/',
      ...headers,
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function fetchJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; json: T | null; text: string }> {
  const { ok, status, text } = await fetchText(url, {
    Accept: 'application/json',
    ...headers,
  });
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = null;
  }
  return { ok, status, json, text };
}

export async function getAnonymousSession(force = false): Promise<AnonymousSession> {
  if (!force && cachedSession && cachedSession.expiresAt > Date.now() + 60_000) {
    return cachedSession;
  }
  const { ok, json, text, status } = await fetchJson<{
    token?: string;
    uid?: string;
    country_code?: string;
    expires?: string;
  }>(`${API_BASE}/v3/session?category=personal_computer&os_family=http&locale=en`);
  if (!ok || !json?.token) {
    throw new Error(`Rally.tv session failed (${status}): ${text.slice(0, 200)}`);
  }
  const expiresAt = json.expires ? Date.parse(json.expires) : Date.now() + 4 * 24 * 3600_000;
  cachedSession = {
    token: json.token,
    uid: json.uid,
    country: json.country_code || 'us',
    expiresAt,
  };
  return cachedSession;
}

function userAuthHeader(config: AddonConfig = {}): Record<string, string> {
  const userToken = (config.authToken || '').trim();
  if (!userToken) return {};
  return {
    Authorization: userToken.startsWith('Bearer ') ? userToken : `Bearer ${userToken}`,
  };
}

async function apiHeaders(): Promise<{ headers: Record<string, string>; session: AnonymousSession }> {
  const session = await getAnonymousSession();
  return {
    headers: { Authorization: session.token },
    session,
  };
}

function tvApiHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    Origin: 'https://www.rally.tv',
    Referer: 'https://www.rally.tv/',
  };
}

export async function getProduct(productId: string, config: AddonConfig = {}): Promise<RallyProduct> {
  const cached = productCache.get(productId);
  if (cached) return cached;
  const session = await getAnonymousSession();
  const { locale, country } = localeCountry(config, session);
  const url = `${TV_API_BASE}/products/v5.2/${NAMESPACE}/${locale}/${country}/${productId}`;
  const { ok, status, json, text } = await fetchJson<RallyProduct>(url, tvApiHeaders());
  if (!ok || !json) {
    throw new Error(`Product fetch failed (${status}): ${text.slice(0, 200)}`);
  }
  productCache.set(productId, json);
  rememberItem(json);
  return json;
}

export async function getDynamicProduct(
  productId: string,
  config: AddonConfig = {},
): Promise<RallyDynamicProduct | null> {
  const session = await getAnonymousSession();
  const { locale, country } = localeCountry(config, session);
  const url = `${TV_API_BASE}/products/dynamic/v5.2/${NAMESPACE}/${locale}/${country}/${productId}`;
  const { ok, json } = await fetchJson<RallyDynamicProduct>(url, tvApiHeaders());
  if (!ok || !json) return null;
  return json;
}

export async function getCollection(
  collectionId: string,
  config: AddonConfig = {},
  { offset = 0 }: { offset?: number } = {},
): Promise<RallyCollection> {
  const session = await getAnonymousSession();
  const { locale, country } = localeCountry(config, session);
  let path = `/collections/v5.2/${NAMESPACE}/${locale}/${country}/${collectionId}`;
  if (offset) path += `?offset=${offset}`;
  const url = `${TV_API_BASE}${path}`;
  const { ok, status, json, text } = await fetchJson<RallyCollection>(url, tvApiHeaders());
  if (!ok || !json) {
    throw new Error(`Collection fetch failed (${status}): ${text.slice(0, 200)}`);
  }
  for (const card of json.cards || []) rememberItem(card);
  return json;
}

/** Fetch a collection and follow pagination until exhausted or maxCards. */
export async function getCollectionAll(
  collectionId: string,
  config: AddonConfig = {},
  { maxCards = 200 }: { maxCards?: number } = {},
): Promise<RallyCollection> {
  const cards: RallyEntity[] = [];
  let offset = 0;
  let label: string | undefined;
  let type: string | undefined;
  let list_type: string | undefined;
  let meta: RallyCollection['meta'] = {};

  while (cards.length < maxCards) {
    const col = await getCollection(collectionId, config, { offset });
    label = col.label;
    type = col.type;
    list_type = col.list_type;
    meta = col.meta || {};
    const batch = col.cards || [];
    cards.push(...batch);
    if (!meta.next || batch.length === 0) break;
    offset = cards.length;
  }

  return { id: collectionId, label, type, list_type, meta, cards: cards.slice(0, maxCards) };
}

export async function search(
  query: string,
  { limit = 40 }: { limit?: number; config?: AddonConfig } = {},
): Promise<{ json: RallySearchResponse; session: AnonymousSession }> {
  const { headers, session } = await apiHeaders();
  const url = `${API_BASE}/v3/search?namespace=${NAMESPACE}&q=${encodeURIComponent(query)}&limit=${limit}`;
  const { ok, json, status, text } = await fetchJson<RallySearchResponse>(url, headers);
  if (!ok || !json) {
    if (status === 401 || status === 403) {
      throw new RallyError('re-auth required', 'REAUTH');
    }
    throw new Error(`Search failed (${status}): ${text.slice(0, 200)}`);
  }
  return { json, session };
}

export function collectPlayableVideos(searchJson: RallySearchResponse): RallyEntity[] {
  const out: RallyEntity[] = [];
  const seen = new Set<string>();
  for (const collection of searchJson.collections || []) {
    for (const item of collection.items || []) {
      if (!item?.id || seen.has(item.id)) continue;
      if (item.type !== 'video' || item.playable === false) continue;
      seen.add(item.id);
      out.push(rememberItem(item));
    }
  }
  return out;
}

export function collectEventPages(searchJson: RallySearchResponse): RallyEntity[] {
  const out: RallyEntity[] = [];
  const seen = new Set<string>();
  for (const collection of searchJson.collections || []) {
    for (const item of collection.items || []) {
      if (!item?.id || seen.has(item.id)) continue;
      if (item.type !== 'page' || item.content_type !== 'stop') continue;
      seen.add(item.id);
      out.push(rememberItem(item));
    }
  }
  return out;
}

/** Catalog meta may carry a few MetaDetail fields Stremio still accepts. */
export type CatalogMeta = MetaPreview & Pick<MetaDetail, 'releaseInfo' | 'genres'>;

export function itemToMetaPreview(item: RallyEntity): CatalogMeta {
  const isEvent =
    item.type === 'page' && (item.content_type === 'stop' || item.content_type === 'event');
  const poster =
    mediaUrl(item, 'rbtv_display_art_landscape') || resourceUrl(item.id, 'rbtv_display_art_landscape');
  const background =
    mediaUrl(item, 'rbtv_background_landscape') || resourceUrl(item.id, 'rbtv_background_landscape');
  return {
    id: toMetaId(item.id),
    type: isEvent ? 'series' : 'movie',
    name: item.title || 'Rally.tv video',
    poster,
    posterShape: 'landscape',
    background,
    description: item.long_description || item.short_description || item.subheading || '',
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: Array.isArray(item.tags) ? item.tags : undefined,
  };
}

export function eventCardToMetaPreview(
  card: RallyEntity,
  dynamic: RallyDynamicProduct | null = null,
): CatalogMeta {
  const location =
    card.subheading || dynamic?.header_badges?.find((b) => b.type === 'location')?.value || '';
  const start = dynamic?.start_time || card.start_time;
  const end = dynamic?.end_time || card.end_time;
  const badge = dynamic?.badges?.[0]?.value;
  const dateInfo = formatEventDates(start, end);
  const descriptionParts = [
    location,
    dateInfo,
    badge,
    card.short_description || card.long_description || '',
  ].filter(Boolean);

  return {
    id: toMetaId(card.id),
    type: 'series',
    name: card.title || 'Rally event',
    poster:
      mediaUrl(card, 'rbtv_display_art_landscape') || resourceUrl(card.id, 'rbtv_display_art_landscape'),
    posterShape: 'landscape',
    background:
      mediaUrl(card, 'rbtv_background_landscape') || resourceUrl(card.id, 'rbtv_background_landscape'),
    description: descriptionParts.join(' · '),
    releaseInfo: start ? String(new Date(start).getUTCFullYear()) : undefined,
    genres: Array.isArray(card.tags) ? card.tags : undefined,
  };
}

function formatEventDates(start?: string, end?: string): string {
  if (!start) return '';
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (!e || Number.isNaN(e.getTime())) return s.toLocaleDateString('en-US', opts);
  return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
}

export function liveChannelMeta(): CatalogMeta {
  const id = PRODUCTS.live;
  return {
    id: toMetaId(id),
    type: 'tv',
    name: 'Rally.TV 24/7',
    poster: resourceUrl(id, 'rbtv_display_art_landscape'),
    posterShape: 'landscape',
    background: resourceUrl(id, 'rbtv_background_landscape'),
    description:
      'Official Rally.TV linear channel — live coverage, highlights, and archive programming.',
  };
}

function shouldIncludeCollection(col: RallyCollection | null): col is RallyCollection {
  if (!col) return false;
  if (col.label && SKIP_COLLECTION_LABELS.has(col.label)) return false;
  if (col.id && String(col.id).includes(':recommendations:')) return false;
  if (col.type && SKIP_COLLECTION_TYPES.has(col.type)) return false;
  const playable = (col.cards || []).filter((c) => c.type === 'video' && c.playable !== false);
  return playable.length > 0;
}

function cardToVideoEntry(card: RallyEntity, season: number, episode: number): MetaVideo {
  rememberItem(card);
  const badge = (card.badges || [])
    .map((b) => b.value)
    .filter(Boolean)
    .join(' ')
    .trim();
  const runtime = formatRuntimeMs(card.duration, card.formatted_duration);
  const overview =
    [runtime, badge, card.short_description, card.subheading].filter(Boolean).join(' — ') ||
    undefined;
  const baseTitle = card.title || `Episode ${episode}`;
  return {
    id: toMetaId(card.id),
    title: runtime ? `${baseTitle} (${runtime})` : baseTitle,
    season,
    episode,
    // MetaVideo typings require released; fall back when schedule has no start_time
    released: card.start_time || new Date(0).toISOString(),
    thumbnail:
      mediaUrl(card, 'rbtv_display_art_landscape') || resourceUrl(card.id, 'rbtv_display_art_landscape'),
    overview,
  };
}

/**
 * Load a full rally (stop) page as a Stremio series meta, with seasons
 * matching Rally.tv rails (Schedule, Full Stage Replays, …).
 */
export async function buildEventSeriesMeta(
  pageId: string,
  config: AddonConfig = {},
): Promise<MetaDetail> {
  const [product, dynamic] = await Promise.all([
    getProduct(pageId, config),
    getDynamicProduct(pageId, config),
  ]);

  const collectionStubs = product.collections || [];
  const collections = await Promise.all(
    collectionStubs.map(async (stub) => {
      try {
        return await getCollectionAll(stub.id, config, { maxCards: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[rallytv] collection failed', stub.id, message);
        return null;
      }
    }),
  );

  const videos: MetaVideo[] = [];
  const seasonNames: string[] = [];
  let season = 0;

  for (const col of collections) {
    if (!shouldIncludeCollection(col)) continue;
    season += 1;
    seasonNames.push(col.label || `Season ${season}`);
    let episode = 0;
    for (const card of col.cards || []) {
      if (card.type !== 'video' || card.playable === false) continue;
      episode += 1;
      videos.push(cardToVideoEntry(card, season, episode));
    }
  }

  const preview = eventCardToMetaPreview(product, dynamic);
  const location =
    dynamic?.header_badges?.find((b) => b.type === 'location')?.value || product.subheading;
  const seasonLegend = seasonNames.map((name, i) => `Season ${i + 1}: ${name}`).join(' · ');
  const description = [
    product.short_description || product.long_description || '',
    location ? `Location: ${location}` : '',
    formatEventDates(dynamic?.start_time, dynamic?.end_time),
    seasonLegend,
  ]
    .filter(Boolean)
    .join('\n\n');

  const eventStart = dynamic?.start_time || product.start_time;
  const hasScheduledVideos = videos.some((v) => isCalendarReleased(v.released));

  return {
    ...preview,
    type: 'series',
    description,
    videos,
    released: eventStart || undefined,
    website: product.share_url || `https://www.rally.tv/en/page/${pageId}`,
    // Stremio calendar / UPCOMING badge (undocumented; American spelling)
    behaviorHints: hasScheduledVideos ? { hasScheduledVideos: true } : undefined,
  } as MetaDetail;
}

/** True when `released` is a real air date (not the epoch fallback used when Rally omits start_time). */
export function isCalendarReleased(released: string | undefined | null): boolean {
  if (!released) return false;
  const t = Date.parse(released);
  return Number.isFinite(t) && t > Date.UTC(1970, 0, 2);
}

/**
 * When Rally hasn't published a timed Schedule yet, place one calendar entry per UTC day
 * between event start and end so the weekend still shows in Stremio Calendar.
 */
function synthesizeEventWeekendVideos(
  pageId: string,
  title: string,
  startIso: string,
  endIso?: string,
): MetaVideo[] {
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return [];
  const endMs = endIso ? Date.parse(endIso) : startMs;
  const end = Number.isFinite(endMs) ? endMs : startMs;

  const cursor = new Date(startMs);
  cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setUTCHours(0, 0, 0, 0);

  // Guard runaway ranges (bad API data)
  const maxDays = 14;
  const videos: MetaVideo[] = [];
  let day = 0;
  while (cursor.getTime() <= last.getTime() && day < maxDays) {
    day += 1;
    const released = new Date(cursor);
    // Keep the first day's clock from the real start_time; later days at noon UTC
    if (day === 1) {
      released.setTime(startMs);
    } else {
      released.setUTCHours(12, 0, 0, 0);
    }
    const dateLabel = cursor.toISOString().slice(0, 10);
    videos.push({
      id: `${toMetaId(pageId)}:cal:${dateLabel}`,
      title: day === 1 ? title : `${title} — Day ${day}`,
      season: 0,
      episode: day,
      released: released.toISOString(),
      overview: 'Rally weekend (detailed stage times publish closer to the event)',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return videos;
}

/** Preview card for Discover — pin at the top of Featured / Upcoming. */
export function seasonCalendarPreview(): CatalogMeta {
  return {
    id: seasonCalendarMetaId(),
    type: 'series',
    name: 'WRC & Rally Calendar',
    poster: resourceUrl(PRODUCTS.events, 'rbtv_display_art_landscape'),
    posterShape: 'landscape',
    background: resourceUrl(PRODUCTS.events, 'rbtv_background_landscape'),
    description:
      'Add this to your Library to show Featured + Upcoming rally weekends on the Stremio Calendar page.',
    releaseInfo: `${new Date().getUTCFullYear()}-`,
    genres: ['Motorsport', 'WRC', 'Rally'],
  };
}

/**
 * Aggregated series meta: one video per day of each Featured/Upcoming event weekend.
 * Uses dynamic start/end only (fast) so Calendar requests stay within client timeouts.
 */
export async function buildSeasonCalendarMeta(config: AddonConfig = {}): Promise<MetaDetail> {
  const [featured, upcoming] = await Promise.all([
    listEventCatalog('featured', config),
    listEventCatalog('upcoming', config),
  ]);
  const seen = new Set<string>();
  const previews = [...featured, ...upcoming].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const batches = await Promise.all(
    previews.map(async (preview) => {
      const productId = parseId(preview.id);
      if (!productId) return [] as MetaVideo[];
      try {
        const dynamic = await getDynamicProduct(productId, config);
        const start = dynamic?.start_time;
        if (!start || !isCalendarReleased(start)) return [] as MetaVideo[];
        return synthesizeEventWeekendVideos(
          productId,
          preview.name || 'Rally event',
          start,
          dynamic?.end_time,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[rallytv] season calendar event failed', preview.id, message);
        return [] as MetaVideo[];
      }
    }),
  );

  const videos = batches
    .flat()
    .sort((a, b) => Date.parse(a.released) - Date.parse(b.released))
    .map((v, i) => ({
      ...v,
      season: new Date(v.released).getUTCFullYear() || new Date().getUTCFullYear(),
      episode: i + 1,
    }));

  return {
    ...seasonCalendarPreview(),
    type: 'series',
    videos,
    behaviorHints: { hasScheduledVideos: true },
  } as MetaDetail;
}

/**
 * Stremio Calendar batches library series IDs via catalog extra `calendarVideosIds`.
 * Return full metas with dated videos only (keeps payloads small; calendar keys off `released`).
 */
export async function buildCalendarMetasDetailed(
  metaIds: string[],
  config: AddonConfig = {},
): Promise<MetaDetail[]> {
  const unique = [...new Set(metaIds.map((id) => id.trim()).filter(Boolean))];
  const results = await Promise.all(
    unique.map(async (metaId) => {
      const productId = parseId(metaId);
      if (!productId) return null;
      try {
        if (isSeasonCalendarId(productId)) {
          const season = await buildSeasonCalendarMeta(config);
          return season.videos?.length ? season : null;
        }

        const meta = await buildEventSeriesMeta(productId, config);
        let videos = (meta.videos || []).filter((v) => isCalendarReleased(v.released));

        // Upcoming rallies often have no Schedule rail yet — fall back to event dates.
        if (!videos.length && meta.released && isCalendarReleased(meta.released)) {
          const dynamic = await getDynamicProduct(productId, config).catch(() => null);
          const start = dynamic?.start_time || meta.released;
          videos = synthesizeEventWeekendVideos(
            productId,
            meta.name || 'Rally event',
            start,
            dynamic?.end_time,
          );
        }

        if (!videos.length) return null;
        videos.sort(
          (a, b) =>
            Date.parse(a.released) - Date.parse(b.released) || (a.episode || 0) - (b.episode || 0),
        );
        return {
          ...meta,
          videos,
          behaviorHints: { hasScheduledVideos: true },
        } as MetaDetail;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[rallytv] calendar meta failed', metaId, message);
        return null;
      }
    }),
  );
  return results.filter((m): m is MetaDetail => Boolean(m));
}

/** Resolve Events-hub collection IDs by label (Calendar Featured, Past WRC, …). */
export async function getEventsHubCollections(config: AddonConfig = {}): Promise<RallyCollection[]> {
  const product = await getProduct(PRODUCTS.events, config);
  const resolved: RallyCollection[] = [];
  for (const stub of product.collections || []) {
    try {
      const col = await getCollection(stub.id, config, { offset: 0 });
      resolved.push(col);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[rallytv] events hub collection failed', stub.id, message);
    }
  }
  return resolved;
}

export async function listEventCatalog(
  catalogKey: EventCatalogKey,
  config: AddonConfig = {},
  { skip = 0 }: { skip?: number } = {},
): Promise<CatalogMeta[]> {
  const wantedLabel = EVENT_CATALOG_COLLECTIONS[catalogKey];
  if (!wantedLabel) return [];

  const hub = await getEventsHubCollections(config);
  const match = hub.find((c) => c.label === wantedLabel);
  if (!match) return [];

  let col = match;
  if (skip > 0) {
    col = await getCollection(match.id, config, { offset: skip });
  } else if ((match.cards || []).length === 0 && match.meta?.total) {
    col = await getCollection(match.id, config, { offset: 0 });
  }

  const cards = (col.cards || []).filter((c) => c.type === 'page' && c.content_type === 'stop');
  return cards.map((c) => eventCardToMetaPreview(c));
}

export async function resolvePlayableStream(
  productId: string,
  config: AddonConfig = {},
): Promise<PlayableStream> {
  const cacheKey = playableCacheKey(productId, config);
  const cached = playableCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const session = await getAnonymousSession();
  const locale = config.locale || 'en';
  const country = config.country || session.country || 'us';
  const url = playUrl(productId, { locale, country });

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Origin: 'https://www.rally.tv',
    Referer: 'https://www.rally.tv/',
    ...userAuthHeader(config),
  };

  const { ok, status, text } = await fetchText(url, headers);
  if (status === 401 || status === 403) {
    throw new RallyError(
      're-auth required — paste a fresh Auth0 access token in addon settings',
      'REAUTH',
    );
  }
  if (!ok) {
    throw new Error(`Play URL failed (${status}): ${text.slice(0, 200)}`);
  }

  const drm = inspectPlaylistForDrm(text);
  if (!drm.ok) {
    throw new RallyError(`DRM blocked: ${drm.reason}`, 'DRM');
  }

  const master = parseMasterPlaylist(text);
  const video = pickVideoRendition(master.videos);
  const audio = master.demuxed ? pickAudioRendition(master.audios, video?.audioGroup) : null;

  const mediaUrls: string[] = [video?.url, audio?.url].filter((u): u is string => Boolean(u));
  if (!mediaUrls.length) {
    const mediaLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('http') && l.includes('.m3u8'));
    if (mediaLine) mediaUrls.push(mediaLine);
  }

  for (const mediaUrl of mediaUrls) {
    const media = await fetchText(mediaUrl, headers);
    if (!media.ok) continue;
    const mediaDrm = inspectPlaylistForDrm(media.text);
    if (!mediaDrm.ok) {
      throw new RallyError(`DRM blocked on media playlist: ${mediaDrm.reason}`, 'DRM');
    }
  }

  const playable: PlayableStream = {
    url,
    headers,
    live: productId === PRODUCTS.live,
  };

  // Demuxed masters hang in Stremio — expose video(+default audio) for addon remux.
  if (master.demuxed && video?.url) {
    playable.remux = {
      videoUrl: video.url,
      audioUrl: audio?.url || null,
    };
  }

  playableCache.set(cacheKey, { value: playable, expiresAt: Date.now() + PLAYABLE_TTL_MS });
  return playable;
}

export { USER_AGENT };
export type { AddonConfig, EventCatalogKey, PlayableStream };
