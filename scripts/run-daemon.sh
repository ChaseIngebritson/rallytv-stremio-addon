#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3000}"
LOG="${LOG:-$ROOT/addon.log}"
PIDFILE="${PIDFILE:-$ROOT/addon.pid}"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PIDFILE")) on port $PORT"
  echo "Manifest: http://127.0.0.1:${PORT}/manifest.json"
  exit 0
fi

export PATH="${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | tail -1)/bin:${PATH}"
export PORT

# Prefer tsx (TypeScript source); fall back to compiled dist if present.
if command -v npx >/dev/null 2>&1; then
  START_CMD=(npx --yes tsx src/index.ts)
elif [[ -f dist/src/index.js ]]; then
  START_CMD=(node dist/src/index.js)
else
  echo "Need tsx (npm install) or a built dist/ — run: npm install && npm run build"
  exit 1
fi

nohup "${START_CMD[@]}" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
sleep 1
if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Failed to start — see $LOG"
  exit 1
fi

echo "Started pid $(cat "$PIDFILE")"
echo "Log: $LOG"
echo "Configure: http://127.0.0.1:${PORT}/configure"
echo "Manifest:  http://127.0.0.1:${PORT}/manifest.json"
curl -sf "http://127.0.0.1:${PORT}/manifest.json" >/dev/null && echo "Health check: OK"
