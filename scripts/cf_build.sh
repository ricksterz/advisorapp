#!/usr/bin/env bash
# Cloudflare Workers build entrypoint (wrangler.jsonc's build.command).
#
# Fetches the data snapshot from the GitHub Pages deployment (refreshed by
# .github/workflows/pages.yml on the same push), builds the frontend, and
# pre-renders per-route HTML.
#
# Both this build and pages.yml trigger on the same `main` push, with no
# ordering between the two separate CI systems -- a straight curl can grab
# firms.json from BEFORE this push landed, because Pages' own deploy hasn't
# finished yet. Confirmed live on 2026-09-14: this build's curl won that race
# by roughly 7 seconds, and open-disclosure.com served the PRIOR push's
# snapshot -- missing a field that had just been added -- until an unrelated
# later push happened to redeploy it and pick up the real one.
#
# Fix is a retry against a freshness check, not a blind sleep: keep polling
# until the fetched generated_at is recent, or give up after a bounded number
# of attempts and use whatever was fetched -- still far better than falling
# back to the 3-firm committed sample.
set -euo pipefail
cd "$(dirname "$0")/.."

MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"
SLEEP_SECONDS="${SLEEP_SECONDS:-20}"
OUT=frontend/public/firms.json
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

fresh_enough() {
  python3 - "$1" <<'PY'
import json
import sys
from datetime import datetime, timezone

try:
    with open(sys.argv[1]) as f:
        generated_at = json.load(f)["generated_at"]
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(generated_at)).total_seconds()
except Exception:
    sys.exit(1)
# pages.yml's own deploy (same push) typically finishes within ~2 minutes;
# treat anything within 20 as this push's data, not some prior push's.
sys.exit(0 if age < 1200 else 1)
PY
}

got_data=0
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if curl -fsSL https://ricksterz.github.io/advisorapp/firms.json -o "$TMP"; then
    got_data=1
    if fresh_enough "$TMP"; then
      echo "firms.json is fresh (attempt $attempt/$MAX_ATTEMPTS)"
      break
    fi
    echo "firms.json looks stale (attempt $attempt/$MAX_ATTEMPTS) -- pages.yml's deploy on this push may still be in flight; waiting ${SLEEP_SECONDS}s"
  else
    echo "fetch failed (attempt $attempt/$MAX_ATTEMPTS); waiting ${SLEEP_SECONDS}s"
  fi
  sleep "$SLEEP_SECONDS"
done

if [ "$got_data" = "1" ]; then
  cp "$TMP" "$OUT"
else
  echo "live data unavailable after $MAX_ATTEMPTS attempts, using committed firms.json"
fi

cd frontend && npm ci && npm run build && cd ..

# gen_static_pages writes a real HTML file per route with the correct
# canonical already in the <head>. Without it every route is served the
# homepage's canonical, which Search Console reported as "Alternate page
# with proper canonical tag" against all ~17K firm URLs. It runs on the
# build image's stock python3 (stdlib only -- no pip install needed), and
# fails the build if dist would exceed the Free plan's 20,000-file cap.
python3 -m etl.gen_static_pages --data "$OUT" --site https://open-disclosure.com --out frontend/dist
