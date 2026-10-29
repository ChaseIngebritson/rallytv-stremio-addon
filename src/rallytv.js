'use strict';

const { inspectPlaylistForDrm } = require('./drm');

const API_BASE = 'https://api.redbull.tv';
const PLAY_BASE = 'https://play.redbull.com';
const RESOURCES_BASE = 'https://resources.redbull.tv';
const NAMESPACE = 'rallytv';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Known product IDs from the Rally.tv web client config */
const PRODUCTS = {
  live: '07f960dc-fd36-466c-971f-64a597518b83',
  home: 'cf269838-e40a-5bd9-8868-6b96e03e7598',
  epg: '15fed5e0-382f-5f93-af43-850feae5b47d',
  events: '420b28f8-26c0-566a-bbd5-ed5f171182a7',
  search: 'd7cc4789-db63-5cd1-8d3f-7aece4d36ce6',
};

const ID_PREFIX = 'rallytv:';

let cachedSession = null;
/** @type {Map<string, object>} */
const itemCache = new Map();

function rememberItem(item) {
  if (item?.id) itemCache.set(item.id, item);
  return item;
}

function getCachedItem(productId) {
  return itemCache.get(productId) || null;
}

function resourceUrl(id, kind = 'rbtv_display_art_portrait') {
  return `${RESOURCES_BASE}/${id}/${kind}/`;
}

function playUrl(productId, { locale = 'en', country = 'us' } = {}) {
  return `${PLAY_BASE}/main/v1/${NAMESPACE}/${locale}/${country}/personal_computer/http/${productId}.m3u8?device_group=group_5`;
}

function parseId(id) {
  if (!id || !id.startsWith(ID_PREFIX)) return null;
  return id.slice(ID_PREFIX.length);
}

function toMetaId(productId) {
  return `${ID_PREFIX}${productId}`;
}

async function fetchText(url, headers = {}) {
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

async function fetchJson(url, headers = {}) {
  const { ok, status, text } = await fetchText(url, {
    Accept: 'application/json',
    ...headers,
  });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok, status, json, text };
}

async function getAnonymousSession(force = false) {
  if (!force && cachedSession && cachedSession.expiresAt > Date.now() + 60_000) {
    return cachedSession;
  }
  const { ok, json, text, status } = await fetchJson(
    `${API_BASE}/v3/session?category=personal_computer&os_family=http&locale=en`
  );
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

function userAuthHeader(config = {}) {
  const userToken = (config.authToken || '').trim();
  if (!userToken) return {};
  return {
    Authorization: userToken.startsWith('Bearer ') ? userToken : `Bearer ${userToken}`,
  };
}

async function apiHeaders() {
  const session = await getAnonymousSession();
  return {
    headers: { Authorization: session.token },
    session,
  };
}

async function search(query, { limit = 40, config = {} } = {}) {
  const { headers, session } = await apiHeaders();
  const url = `${API_BASE}/v3/search?namespace=${NAMESPACE}&q=${encodeURIComponent(query)}&limit=${limit}`;
  const { ok, json, status, text } = await fetchJson(url, headers);
  if (!ok || !json) {
    if (status === 401 || status === 403) {
      const err = new Error('re-auth required');
      err.code = 'REAUTH';
      throw err;
    }
    throw new Error(`Search failed (${status}): ${text.slice(0, 200)}`);
  }
  return { json, session };
}

function collectPlayableVideos(searchJson) {
  const out = [];
  const seen = new Set();
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

function itemToMetaPreview(item) {
  const poster = resourceUrl(item.id, 'rbtv_display_art_portrait');
  const background = resourceUrl(item.id, 'rbtv_background_landscape');
  return {
    id: toMetaId(item.id),
    type: 'movie',
    name: item.title || 'Rally.tv video',
    poster,
    posterShape: 'landscape',
    background,
    description: item.long_description || item.short_description || item.subheading || '',
    releaseInfo: item.year ? String(item.year) : undefined,
  };
}

function liveChannelMeta() {
  const id = PRODUCTS.live;
  return {
    id: toMetaId(id),
    type: 'tv',
    name: 'Rally.TV 24/7',
    poster: resourceUrl(id, 'rbtv_display_art_landscape'),
    posterShape: 'landscape',
    background: resourceUrl(id, 'rbtv_background_landscape'),
    description: 'Official Rally.TV linear channel — live coverage, highlights, and archive programming.',
  };
}

async function resolvePlayableStream(productId, config = {}) {
  const session = await getAnonymousSession();
  const locale = config.locale || 'en';
  const country = config.country || session.country || 'us';
  const url = playUrl(productId, { locale, country });

  const headers = {
    'User-Agent': USER_AGENT,
    Origin: 'https://www.rally.tv',
    Referer: 'https://www.rally.tv/',
    ...userAuthHeader(config),
  };

  const { ok, status, text } = await fetchText(url, headers);
  if (status === 401 || status === 403) {
    const err = new Error('re-auth required — paste a fresh Auth0 access token in addon settings');
    err.code = 'REAUTH';
    throw err;
  }
  if (!ok) {
    throw new Error(`Play URL failed (${status}): ${text.slice(0, 200)}`);
  }

  const drm = inspectPlaylistForDrm(text);
  if (!drm.ok) {
    const err = new Error(`DRM blocked: ${drm.reason}`);
    err.code = 'DRM';
    throw err;
  }

  // Also inspect first media variant when present
  const mediaLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('http') && l.includes('.m3u8'));
  if (mediaLine) {
    const media = await fetchText(mediaLine, headers);
    if (media.ok) {
      const mediaDrm = inspectPlaylistForDrm(media.text);
      if (!mediaDrm.ok) {
        const err = new Error(`DRM blocked on media playlist: ${mediaDrm.reason}`);
        err.code = 'DRM';
        throw err;
      }
    }
  }

  return {
    url,
    headers,
    live: productId === PRODUCTS.live,
  };
}

module.exports = {
  PRODUCTS,
  ID_PREFIX,
  USER_AGENT,
  parseId,
  toMetaId,
  resourceUrl,
  playUrl,
  getAnonymousSession,
  search,
  collectPlayableVideos,
  itemToMetaPreview,
  liveChannelMeta,
  resolvePlayableStream,
  getCachedItem,
  rememberItem,
};
