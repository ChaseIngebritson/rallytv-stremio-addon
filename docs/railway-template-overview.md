# Deploy and Host Rally.tv Addon for Stremio with Railway

A private [Stremio](https://www.stremio.com/) addon for [Rally.tv](https://www.rally.tv): live TV, WRC & ERC events, stage replays, highlights, search, and calendar-friendly schedules. Deploy your own instance, configure it with your Auth0 access token, and install the configured manifest URL in Stremio.

**Not affiliated with Rally.tv, WRC Promoter, or Red Bull.** Use with your own subscription only. This may conflict with Rally.tv’s Terms of Service — do not redistribute or host a public copy for others.

## About Hosting Rally.tv Addon for Stremio

This template runs a single Node.js service that speaks the Stremio addon protocol and proxies clear HLS from Rally.tv. Demuxed audio/video is remuxed on the fly (system `ffmpeg`) so Stremio can seek and play. After deploy, open `/configure`, paste your Auth0 access token from a logged-in rally.tv session, then install the **configured** HTTPS manifest URL in Stremio — not the bare `/manifest.json`. Tokens are embedded in that install URL; keep it private. Optional locale, country, and base-URL variables can be set at deploy time; most users configure locale/country in the addon settings UI instead.

## Common Use Cases

- Watch the 24/7 Rally.tv live channel in Stremio
- Browse featured, upcoming, and past WRC & ERC events
- Stream full stage replays and event highlights
- Search Rally.tv catalog content from Stremio
- Add “WRC & Rally Calendar” (or individual rallies) to your Library for timed stages on Stremio’s Calendar

## Dependencies for Rally.tv Addon for Stremio Hosting

- Node.js 18+ runtime (provided by the build)
- System `ffmpeg` for remuxing demuxed HLS (included via Railpack / `railpack.json`)
- A Rally.tv account / subscription for entitlement-gated titles
- [Stremio](https://www.stremio.com/) desktop or mobile client
- An Auth0 access token from a logged-in [rally.tv](https://www.rally.tv) browser session

### Deployment Dependencies

- [Source repository](https://github.com/ChaseIngebritson/rallytv-stremio-addon)
- [Rally.tv](https://www.rally.tv)
- [Stremio](https://www.stremio.com/)
- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)

### Implementation Details

- Builder: Railpack (`railpack.json` installs system `ffmpeg`)
- Infrastructure as Code: `.railway/railway.ts`
- Healthcheck: `GET /health`
- Configure UI: `GET /configure`
- Start command: `npx tsx src/index.ts`
- After deploy, use the generated public domain, open `/configure`, then install the configured manifest in Stremio
- DRM-protected titles (Widevine / FairPlay) are not playable in Stremio

### Why Deploy Rally.tv Addon for Stremio on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Rally.tv Addon for Stremio on Railway, you get a private addon URL with HTTPS, healthchecks, and one-click updates from GitHub — without managing servers yourself.
