# Development

Local setup, remux internals, and maintainer notes. For install and day-to-day use, see the [main README](../README.md).

## Requirements

- Node.js 18+
- **ffmpeg** on PATH (Railway installs via `nixpacks.toml`; locally `brew install ffmpeg`). `ffmpeg-static` is a last-resort fallback and can crash on Linux HLS remux.
- Stremio Desktop (or another client that can install a local addon URL)
- Optional: Rally.tv account (email OTP) if play requires auth

## Run locally

```bash
npm install
npm run start:daemon   # background
# or
npm start              # foreground (leave terminal open)
```

```bash
npm run typecheck      # tsc --noEmit
npm run stop           # stop daemon
```

Confirm it’s alive:

```
http://127.0.0.1:3000/
http://127.0.0.1:3000/manifest.json
```

Install in Stremio from `http://127.0.0.1:3000/manifest.json` (or your LAN IP for other devices).

Default port is **3000**. Avoid `7000` — macOS AirPlay Receiver often owns it (HTTP 403).

Configure auth at `http://127.0.0.1:3000/configure` the same way as production: paste the Auth0 token and install the configured manifest URL.

## Auth0 token helper

Rally.tv login is email OTP, not a password.

```bash
npm run login-helper
npm run login-helper -- --check
```

Anonymous device sessions for search are obtained automatically. Renew the Auth0 token and reinstall the configured URL when it expires.

## Environment

See [.env.example](../.env.example) for script-only overrides (`PORT`, `RALLYTV_AUTH_TOKEN`, locale/country, `ADDON_BASE_URL`). Stremio user data is configured in the addon settings UI and encoded into the install URL.

Set `ADDON_BASE_URL` if the auto-detected public URL is wrong (Railway uses `RAILWAY_PUBLIC_DOMAIN`).

## DRM policy

Stremio cannot play Widevine/FairPlay. Before returning a stream, the addon:

- Fetches the master (and first media) playlist
- **Refuses** anything with `EXT-X-KEY`, SAMPLE-AES, Widevine, or FairPlay signaling

Spike (2026-10-29): Live 24/7 + sample entitled stage replays were **clear HLS** — see [api-notes.md](api-notes.md).

## Playback / remux

Many Rally.tv titles serve a **demuxed** HLS master (separate video + audio). Stremio hangs on that shape.

When ffmpeg is available, the stream handler returns an addon remux URL:

| Content | URL | Behavior |
|---|---|---|
| **VOD** | `/remux/{productId}/index.m3u8` | Muxed HLS with on-demand A/V segments — seekable, full duration |
| **Live** | `/remux/{productId}/stream.ts` | Progressive MPEG-TS pipe (live; no scrubbing) |

Configured installs use `/{config}/remux/...`.

Without ffmpeg, demuxed titles fall back to a **video-only** media playlist (often silent). VOD remux runs ffmpeg per HLS segment (cached briefly); heavy seeking still costs CPU on the host.

## Spike scripts

```bash
npm run inspect              # session + search + live/VOD DRM check
npm run inspect -- "onboard"
npm run login-helper
npm run login-helper -- --check
```

## API notes

- Legacy `api.redbull.tv/v3/products/{id}` returns 404; events use **tv-api** `products/v5.2` + `collections/v5.2` (same payload as [rally.tv event pages](https://www.rally.tv/en/page/a70781d8-b56e-4a5f-9f0b-83e83659933e)).
- More detail: [api-notes.md](api-notes.md)
