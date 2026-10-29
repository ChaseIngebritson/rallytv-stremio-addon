# Railway Infrastructure as Code

This directory defines the Railway project for the Rally.tv Stremio addon.

- Authoring file: [`railway.ts`](./railway.ts)
- Build packages (system `ffmpeg`): [`../railpack.json`](../railpack.json)

## Commands

```bash
npx railway link                 # once, if this directory is not linked
npx railway config plan          # preview changes
npx railway config apply         # apply after review
```

Railway does **not** read `.railway/` during deploys. Plan/apply via the CLI (or CI) updates the linked project and environment. Builds still use `railpack.json` automatically.

Docs: https://docs.railway.com/infrastructure-as-code
