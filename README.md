# Rally.tv for Stremio

Watch Rally.tv live TV, stage replays, highlights, and event schedules in [Stremio](https://www.stremio.com/).

**Not affiliated with Rally.tv, WRC Promoter, or Red Bull.** Use with your own subscription only. This may conflict with Rally.tv’s Terms of Service — do not redistribute or host a public copy for others.

## Deploy

Host your own private instance (recommended on [Railway](https://railway.com)):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/ChaseIngebritson/rallytv-stremio-addon&utm_medium=integration&utm_source=button&utm_campaign=rallytv-stremio-addon)

After deploy:

1. Open the service → **Settings** → **Networking** → **Generate Domain**
2. Visit `https://<your-domain>/configure`
3. Paste your Auth0 access token and use **Install in Stremio** / **Copy HTTPS manifest**
4. Install that **configured** URL in Stremio — not the bare `/manifest.json`

Local development: see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Sign in (recommended)

Many titles need a Rally.tv subscription. Login is **email OTP** (no password).

1. Log into [rally.tv](https://www.rally.tv) in a browser
2. Open your instance’s `/configure` page and paste your Auth0 access token  
   *(tip: run `npm run login-helper` locally if you need help finding it)*
3. Install the configured manifest URL from that page

When the token expires, paste a fresh one and reinstall the configured URL.

Your Auth0 token is embedded in the install URL — keep that URL private and do not share it.

## What’s included

| Catalog | Contents |
|---|---|
| Live TV | 24/7 Rally.tv channel |
| Featured / Upcoming / Past Events | Events hub (WRC & ERC) |
| Stage Replays | Full stage replays |
| Highlights | Event highlights |
| Rally.tv Search | Search events and videos |
| Calendar | Timed stages once events are in your Library |

Opening a rally loads its page rails (Schedule, Full Stage Replays, highlights, clips, …) as seasons.

### Calendar tip

Stremio’s Calendar only shows series you’ve **added to Library**.

1. Open **Featured Events** or **Upcoming Events**
2. Open **WRC & Rally Calendar** (pinned at the top) → **Add to Library**
3. Open Calendar (signed in) and jump to the event month

You can also Library individual rallies. When Rally publishes a Schedule rail, stages appear on those air dates; otherwise the addon uses the event weekend.

## Limitations

- Stremio cannot play DRM (Widevine / FairPlay). If Rally.tv enables DRM on a title, it won’t be playable here.
- Season labels in Stremio always say “Season N”; rail names (Schedule, Full Stage Replays, …) are shown on episode titles instead.
- Entitlement rules can change — keep a valid Auth0 token handy.

## Self-hosting & development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for local setup, remux details, env vars, and spike scripts.
