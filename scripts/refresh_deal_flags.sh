#!/usr/bin/env bash
# Refreshes the brochure-derived data artifacts that live only on this
# workstation: the brochure corpus (data/advisor.duckdb + data/brochures/,
# both gitignored) can't be built in CI — see docs/pdf-pipeline-scope.md —
# so this is an on-demand, manually-triggered script, not a scheduled job.
#
# firms.json itself is NOT regenerated here: the committed copy in
# frontend/public/ is a small sample fixture, and the real one is built
# fresh by the Pages deploy on every push (.github/workflows/pages.yml).
# This script only needs a full firm list to scope the brochure crawl and
# build the two data files that DO get committed:
#   - frontend/public/deal_flags.json  (deal-structuring flags + evidence)
#   - frontend/public/sitemap.xml      (+ robots.txt)
#
# Usage: scripts/refresh_deal_flags.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
SITE="https://open-disclosure.com"
TMP_FIRMS="$(mktemp -t open-disclosure-firms).json"
trap 'rm -f "$TMP_FIRMS"' EXIT

echo "== 1/9 fetching the latest ADV feed =="
$PY -m etl.fetch_latest --dest data/raw/latest_adv.xml.gz
$PY -m etl.ingest_adv --input data/raw/latest_adv.xml.gz --db data/advisor.duckdb

echo "== 2/9 refreshing the brochure corpus (rescans every firm for new/changed brochures) =="
$PY -m etl.brochures run --db data/advisor.duckdb --rescan

echo "== 3/9 extracting advisor bios from newly-cached brochures (Part 2B) =="
$PY -m etl.advisor_bios run --db data/advisor.duckdb

echo "== 4/9 refreshing individual disclosure flags (bulk IA_INDVL_Feed) =="
$PY -m etl.individual_disclosures run --db data/advisor.duckdb
$PY -m etl.individual_disclosures_stats --db data/advisor.duckdb \
    --out frontend/public/individual_disclosures.json

echo "== 5/9 exporting deal_flags.json + advisor_bios.json =="
$PY -m etl.export_json --db data/advisor.duckdb --out "$TMP_FIRMS" \
    --flags-out frontend/public/deal_flags.json --bios-out frontend/public/advisor_bios.json

echo "== 6/9 regenerating sitemap.xml + robots.txt =="
$PY -m etl.gen_sitemap --data "$TMP_FIRMS" --site "$SITE" --out /tmp/sitemap_out
$PY - "$SITE" <<'PYEOF'
import sys
from pathlib import Path

site = sys.argv[1]
src = Path("/tmp/sitemap_out/sitemap.xml").read_text()
decl, rest = src.split("\n", 1)
comment = (
    "<!-- Generated from the live firm dataset (etl/gen_sitemap.py). Served as-is by the\n"
    "     Cloudflare host; the GitHub Pages deploy regenerates it in its build output.\n"
    "     Regenerate alongside deal_flags.json when refreshing data on the workstation. -->\n"
)
Path("frontend/public/sitemap.xml").write_text(decl + "\n" + comment + rest)
Path("frontend/public/robots.txt").write_text(Path("/tmp/sitemap_out/robots.txt").read_text())
PYEOF

echo "== 7/9 refreshing Industry Pulse (monthly archives -> snapshots -> stats) =="
$PY -m etl.pulse_history run --db data/advisor.duckdb
$PY -m etl.pulse_stats --db data/advisor.duckdb --out frontend/public/pulse_stats.json

echo "== 8/9 refreshing private funds (Schedule D 7.B.1, reuses Pulse's cached archives) =="
$PY -m etl.private_funds run --db data/advisor.duckdb
$PY -m etl.private_fund_stats --db data/advisor.duckdb \
    --out frontend/public/private_funds.json --firm-out frontend/public/firm_private_funds.json

echo "== 9/9 refreshing Form D capital formation (manual quarterly zips in data/raw/formd/) =="
$PY -m etl.form_d load --db data/advisor.duckdb
$PY -m etl.form_d_stats --db data/advisor.duckdb --out frontend/public/form_d.json

echo
echo "Done. Review the diff, then:"
echo "  git add frontend/public/deal_flags.json frontend/public/advisor_bios.json \\"
echo "          frontend/public/sitemap.xml frontend/public/robots.txt frontend/public/pulse_stats.json \\"
echo "          frontend/public/private_funds.json frontend/public/firm_private_funds.json \\"
echo "          frontend/public/individual_disclosures.json frontend/public/form_d.json"
echo "  git commit -m 'Refresh brochure corpus, advisor bios, private funds, disclosures, and sitemap'"
