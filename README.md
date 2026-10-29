# Rally.tv → Stremio (personal)

Personal LAN Stremio addon that catalogs Rally.tv content and plays **clear HLS only** using the official Red Bull / Rally.tv play service.

**Not affiliated with Rally.tv, WRC Promoter, or Red Bull.** Personal use with your own subscription only. May conflict with Rally.tv Terms of Service. Do not redistribute or host publicly.

## DRM policy

Stremio cannot play Widevine/FairPlay. This addon:

- Fetches the master (and first media) playlist before returning a stream
- **Refuses** anything with `EXT-X-KEY`, SAMPLE-AES, Widevine, or FairPlay signaling
- Spike result (2026-10-29): Live 24/7 + sample entitled stage replays were **clear HLS** — see [docs/api-notes.md](docs/api-notes.md)

## Requirements

- Node.js 18+
- Stremio Desktop (or another client that can install a local addon URL)
- Optional: Rally.tv account (email OTP) if play starts requiring auth

## Install / run

```bash
cd ~/Code/rallytv-stremio-addon
npm install
npm run start:daemon   # keeps running in the background
```

Or foreground (terminal must stay open):

```bash
npm start              # tsx runs TypeScript directly
npm run typecheck      # tsc --noEmit
npm run build          # emit dist/ (optional; Railway/prod)
```

Then open in a browser to confirm it’s alive:

```
http://127.0.0.1:3000/
http://127.0.0.1:3000/manifest.json
```

In Stremio → Addons → install from URL:

```
http://127.0.0.1:3000/manifest.json
```

> **Note:** Default port is **3000**. Avoid `7000` — macOS AirPlay Receiver often owns it (HTTP 403).  
> If the browser shows connection refused, the Node process is not running — use `npm start` (leave the terminal open) or `npm run start:daemon`. Stop with `npm run stop`.

Other devices on your LAN: use your machine’s LAN IP instead of `127.0.0.1` (firewall permitting).

### Auth0 token → configured manifest

Rally.tv login is **email one-time code**, not a password.

1. Log into https://www.rally.tv and copy the Auth0 access token (see `npm run login-helper`)
2. Open the configure page: `https://YOUR-HOST/configure` (local: `http://127.0.0.1:3000/configure`)
3. Paste the token, then **Copy HTTPS manifest** / **Install in Stremio**
4. Install that **configured** URL (it looks like `https://YOUR-HOST/%7B%22authToken%22...%7D/manifest.json`) — not the bare `/manifest.json`

Anonymous device sessions for search are still obtained automatically. Renew the Auth0 token and reinstall the configured URL when it expires.

## Catalogs

Structured like the Rally.tv Events hub. Opening a rally loads the full page rails (Schedule, Full Stage Replays, highlights, clips, …) as series seasons.

| Catalog | Source |
|---|---|
| Live TV | Fixed 24/7 channel product |
| Featured Events | Events hub → Calendar Featured |
| Upcoming Events | Events hub → Upcoming Events |
| Past WRC Events | Events hub → Past WRC Events |
| Past ERC Events | Events hub → Past ERC Events |
| Stage Replays | Search `Full Stage Replay` |
| Highlights | Search `Highlights` |
| Rally.tv Search | Stremio search (events + videos) |

Event detail uses `tv-api.redbull.com` products + collections (same payload as [rally.tv event pages](https://www.rally.tv/en/page/a70781d8-b56e-4a5f-9f0b-83e83659933e)).

## Spike scripts

```bash
npm run inspect              # session + search + live/VOD DRM check
npm run inspect -- "onboard"
npm run login-helper
npm run login-helper -- --check
```

## Configuration

See [.env.example](.env.example) for script-only env vars (`PORT`, `RALLYTV_AUTH_TOKEN`, locale/country). Stremio user data is configured in the addon settings UI and encoded into the install URL by Stremio.

## Limitations

- Legacy `api.redbull.tv/v3/products/{id}` returns 404; events use **tv-api** `products/v5.2` + `collections/v5.2`
- Stremio seasons are numbered (Season 1 = Schedule, Season 2 = Full Stage Replays, …); section names are in the series description
- Entitlement enforcement may tighten later — keep an Auth0 token ready
- If Rally.tv enables DRM on an asset, that title will simply have **no playable stream**
