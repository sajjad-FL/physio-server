#!/usr/bin/env bash
# Print nginx instructions to fix HTTP 413 on physio registration uploads.
# Run on production after pulling the repo: bash scripts/printNginxUploadFix.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/deploy/nginx-api.conf.example"

echo "Physio registration 413 fix — Nginx client_max_body_size"
echo ""
echo "Add this inside your API server {} block (or /api location):"
echo "    client_max_body_size 50m;"
echo ""
echo "Full example config:"
echo "    $EXAMPLE"
echo ""
echo "Then:"
echo "    sudo nginx -t"
echo "    sudo systemctl reload nginx"
echo ""
echo "Verify (should NOT return 413):"
echo "    curl -s -o /dev/null -w '%{http_code}' https://YOUR_API_HOST/api/health"
echo ""
echo "If still failing, check:"
echo "    sudo tail -20 /var/log/nginx/error.log"
echo "    pm2 logs physio-b --lines 30"
