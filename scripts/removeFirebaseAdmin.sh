#!/usr/bin/env bash
# Remove Firebase Admin SDK from the physio-server deployment.
# Run on production: cd /root/app/physio-server && bash scripts/removeFirebaseAdmin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PM2_APP="${PM2_APP:-physio-b}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-5000}/api/health}"

echo "==> [1/5] Scanning for Firebase Admin usage in $ROOT"
grep -RIn "firebaseAdmin\|firebase-admin\|FIREBASE_" --include="*.js" . 2>/dev/null || echo "    (no matches in .js files)"

echo "==> [2/5] Removing firebaseAdmin.js and import lines"
if [ -f utils/firebaseAdmin.js ]; then
  rm -v utils/firebaseAdmin.js
else
  echo "    utils/firebaseAdmin.js not present (already removed)"
fi

while IFS= read -r -d '' file; do
  echo "    patching $file"
  sed -i.bak-firebase '/firebaseAdmin/d; /firebase-admin/d' "$file"
  rm -f "${file}.bak-firebase"
done < <(grep -rl "firebaseAdmin\|firebase-admin" --include="*.js" . 2>/dev/null | tr '\n' '\0' || true)

echo "==> [3/5] Uninstalling firebase-admin npm package"
if npm ls firebase-admin >/dev/null 2>&1; then
  npm uninstall firebase-admin
else
  echo "    firebase-admin not installed"
fi

echo "==> [4/5] Stripping FIREBASE_* from .env (backup created)"
if [ -f .env ]; then
  backup=".env.bak.firebase.$(date +%s)"
  cp .env "$backup"
  echo "    backup: $backup"
  grep -v '^FIREBASE_' .env > .env.tmp || true
  mv .env.tmp .env
  echo "    removed FIREBASE_* keys from .env"
else
  echo "    no .env file in $ROOT"
fi

if ! grep -q '^EXPO_PUSH_ENABLED=' .env 2>/dev/null; then
  echo "EXPO_PUSH_ENABLED=true" >> .env
  echo "    appended EXPO_PUSH_ENABLED=true to .env"
elif grep -q '^EXPO_PUSH_ENABLED=false' .env 2>/dev/null; then
  sed -i.bak-expo 's/^EXPO_PUSH_ENABLED=false/EXPO_PUSH_ENABLED=true/' .env
  rm -f .env.bak-expo
  echo "    set EXPO_PUSH_ENABLED=true in .env"
fi

echo "==> [5/5] Restarting PM2 and checking health"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_APP" || pm2 restart all
  sleep 2
  pm2 logs "$PM2_APP" --lines 30 --nostream || true
else
  echo "    pm2 not found — restart the Node process manually"
fi

if command -v curl >/dev/null 2>&1; then
  echo "    GET $HEALTH_URL"
  curl -sf "$HEALTH_URL" && echo || echo "    health check failed (server may still be starting)"
else
  echo "    curl not found — verify /api/health manually"
fi

echo "Done. Confirm PM2 logs show no FirebaseAppError."
