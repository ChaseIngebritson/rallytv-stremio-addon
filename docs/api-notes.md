# Rally.tv API / DRM spike notes

Date: 2026-10-29  
Product: Rally.tv (Red Bull streaming platform, formerly WRC+)

## Verdict: DRM gate **PASS**

Clear HLS was observed for:

| Content | Product / ID | DRM tags |
|---|---|---|
| Free clip | `c4add243-7293-573b-bf5d-39de3305ad44` | None (`EXT-X-KEY` absent on master + media) |
| Entitled stage replay (`content_entitlements: ["rally-content"]`) | `6055f43e-db94-5fb6-88e6-08c7e1e2f30f` | None |
| 24/7 Live TV channel | `07f960dc-fd36-466c-971f-64a597518b83` | None (Akamai TS HLS) |

Player config mentions `drm_momento_host`, so DRM may exist for some future/geo assets. The addon refuses any playlist containing `EXT-X-KEY`, `SAMPLE-AES`, Widevine, or FairPlay signaling.

## Stack

- Web app: Next.js on `https://www.rally.tv`
- Auth0 passwordless (email OTP): `login.rally.tv`, client_id `zL90h7Q1y0684rRPC2O3UwZQqPodIiVX`
- CIAM gateway: `https://abs-gateway.redbull.com`
- Account UI: `https://account.rally.tv`
- Catalog/search API: `https://api.redbull.tv` (`namespace=rallytv`)
- Play service: `https://play.redbull.com`
- Segment CDN: `https://cs.liiift.io` (VOD), `https://rally-tv-live.akamaized.net` (live)

## Auth

### Anonymous device session (required for search API)

```
GET https://api.redbull.tv/v3/session?category=personal_computer&os_family=http&locale=en
```

Response shape (secrets redacted):

```json
{
  "uid": "<uuid>",
  "token": "<jwt>",
  "country_code": "us",
  "category": "personal_computer",
  "expires": "ISO-8601",
  "locale": "en",
  "os_family": "http"
}
```

Use header: `Authorization: <token>` (raw JWT, not `Bearer`).

### User login (email OTP)

Passwords are disabled. Flow is Auth0 passwordless on `login.rally.tv`. For the addon, paste an Auth0 access token from the browser after login (optional today — play URLs currently work anonymously for tested assets).

## Catalog

Known product IDs from web client config:

| Key | UUID |
|---|---|
| `live_product` (24/7 channel) | `07f960dc-fd36-466c-971f-64a597518b83` |
| `home_product` | `cf269838-e40a-5bd9-8868-6b96e03e7598` |
| `epg_product` | `15fed5e0-382f-5f93-af43-850feae5b47d` |
| `events_product` | `420b28f8-26c0-566a-bbd5-ed5f171182a7` |
| `search_product` | `d7cc4789-db63-5cd1-8d3f-7aece4d36ce6` |

`GET https://api.redbull.tv/v3/products/{uuid}?namespace=rallytv` returns 404 for Rally.tv UUIDs. Use **tv-api** instead:

### Event / page products (mirrors www.rally.tv/en/page/{id})

```
GET https://tv-api.redbull.com/products/v5.2/rallytv/{locale}/{country}/{id}
GET https://tv-api.redbull.com/products/dynamic/v5.2/rallytv/{locale}/{country}/{id}
GET https://tv-api.redbull.com/collections/v5.2/rallytv/{locale}/{country}/{collectionId}
```

- Product `type: "page"`, `content_type: "stop"` = a rally weekend (e.g. Italia Sardegna).
- Product response lists collection **stubs** (`{ id }`); hydrate each via `/collections/v5.2/...`.
- Dynamic endpoint adds badges, start/end time, location, `default_live_program`.
- Typical rails on a stop page: Schedule, Full Stage Replays, Extended Highlights, Quick Recaps, Must-See Clips, …
- Events hub (`events_product`) collections: Calendar Featured, Upcoming Events, Past WRC Events, Past ERC Events, …

Pagination: collection `meta.next` / `?offset=N`.

### Search (clips / fallback discovery)

```
GET https://api.redbull.tv/v3/search?namespace=rallytv&q=<query>&limit=20
Authorization: <session token>
```

Returns collections (`Top Results`, `Videos`, `Films`, `Events`). Playable items have `type: "video"` and `playable: true`. Event pages appear as `type: "page"`, `content_type: "stop"`.

Artwork: `https://resources.redbull.tv/<id>/<resource>/` (tv-api also returns `media_resources.*.url` with an `{im}` transform placeholder).

## Playback

```
GET https://play.redbull.com/main/v1/rallytv/{locale}/{country}/personal_computer/http/{productId}.m3u8
```

Recommended headers: `Origin: https://www.rally.tv`, `Referer: https://www.rally.tv/`.

Optional query: `device_group=group_5`.

VOD masters list fMP4 variants under `play.redbull.com/video/...` and `play.redbull.com/audio/...`.  
Live master points at `rally-tv-live.akamaized.net` TS variants.

## Hard fail criteria (from plan)

Abort playback (do not return a Stremio stream) if the playlist contains:

- `#EXT-X-KEY`
- `SAMPLE-AES`
- Widevine / FairPlay / `com.widevine` / `com.apple.streamingkeydelivery`
- DASH `ContentProtection` (if an MPD is returned instead of HLS)
