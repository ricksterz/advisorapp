"""Generate sitemap.xml and robots.txt for the deployed site.

Firm profiles live at real paths (/firm/{crd}), so the sitemap is what makes
~17K firm pages discoverable by crawlers. Runs in the Pages deploy after the
frontend build, against the same firms.json the site ships.

Usage:
    python -m etl.gen_sitemap --data frontend/public/firms.json \
        --site https://ricksterz.github.io/advisorapp --out frontend/dist
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

SITEMAP_URL_LIMIT = 50_000  # protocol cap per sitemap file


def generate(data_path: Path, site: str, out_dir: Path) -> int:
    payload = json.loads(data_path.read_text())
    site = site.rstrip("/")
    lastmod = (payload.get("generated_at") or datetime.now(timezone.utc).isoformat())[:10]

    static_pages = ["", "pulse", "pulse/advisers", "pulse/assets", "pulse/private-funds"]
    urls = [f"{site}/{p}".rstrip("/") + ("/" if not p else "") for p in static_pages] + [
        f"{site}/firm/{f['crd']}" for f in payload["firms"]
    ]
    if len(urls) > SITEMAP_URL_LIMIT:
        # 50K is the per-file protocol cap; revisit with a sitemap index if the
        # registered-adviser universe ever approaches it (currently ~17K).
        print(f"warning: truncating sitemap to {SITEMAP_URL_LIMIT} of {len(urls)} URLs")
        urls = urls[:SITEMAP_URL_LIMIT]

    entries = "\n".join(
        f"  <url><loc>{u}</loc><lastmod>{lastmod}</lastmod></url>" for u in urls
    )
    sitemap = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{entries}\n"
        "</urlset>\n"
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "sitemap.xml").write_text(sitemap)
    (out_dir / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\n\nSitemap: {site}/sitemap.xml\n"
    )
    print(f"wrote sitemap.xml ({len(urls)} URLs) and robots.txt to {out_dir}")
    return len(urls)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="firms.json path")
    parser.add_argument("--site", required=True, help="canonical site origin (+ base path)")
    parser.add_argument("--out", type=Path, required=True, help="output directory (the built dist)")
    args = parser.parse_args()
    generate(args.data, args.site, args.out)


if __name__ == "__main__":
    main()
