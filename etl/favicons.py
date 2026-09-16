"""Which icon source actually has a logo for each firm's website.

The site shows a firm's favicon through a public icon proxy. Both proxies it
can use answer a missing icon with a placeholder -- DuckDuckGo a gray arrow,
Google a gray globe -- and both send that placeholder as an HTTP 404 with a
perfectly valid image body. A browser renders the body anyway, so an
<img onerror> never fires: T. ROWE PRICE and AMERIPRISE were shown with
DuckDuckGo's arrow instead of their logos. The status code is only visible
server-side, so each host is checked once here, at refresh time, the same
static-first way every other aggregate on the site is built.

Neither source covers the other. Checked against the largest firms,
DuckDuckGo has bny.com and tiaa.org where Google only has its globe, and
Google has troweprice.com and am.pictet.com where DuckDuckGo only has its
arrow. So DuckDuckGo is tried first, Google second, and a host with neither
gets no icon rather than a placeholder.

The export lists only the exceptions -- hosts that need Google, and hosts
with no icon anywhere. Any host not listed uses DuckDuckGo. That keeps the
file small, and it means a firm whose website first appears between data
refreshes (firms.json is rebuilt on every deploy, this file only on a
refresh) still gets the default icon rather than none.

Usage:
    python -m etl.favicons --db data/advisor.duckdb \\
        --overrides frontend/public/website_overrides.json \\
        --out frontend/public/favicons.json
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import requests

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import REPO_ROOT
from etl.platforms import host_of

DEFAULT_OVERRIDES = REPO_ROOT / "frontend" / "public" / "website_overrides.json"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "favicons.json"

DUCKDUCKGO = "https://icons.duckduckgo.com/ip3/{host}.ico"
GOOGLE = "https://www.google.com/s2/favicons?domain={host}&sz=64"

TIMEOUT = (5, 12)
MAX_WORKERS = 12

# A real icon is an image. franklintempleton.com comes back from DuckDuckGo as
# an 8-byte 200, which is neither a placeholder nor a logo.
_IMAGE_SIGNATURES = (
    b"\x89PNG",
    b"\x00\x00\x01\x00",  # ICO
    b"GIF8",
    b"\xff\xd8\xff",  # JPEG
    b"RIFF",  # WEBP
    b"<svg",
    b"<?xml",
)

# A browser User-Agent: both proxies serve it the same bytes as a visitor.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
}


def is_real_icon(status: int, body: bytes) -> bool:
    """A usable icon: served with 200 (placeholders come back 404) and
    actually an image of non-trivial size."""
    if status != 200 or len(body) < 64:
        return False
    head = body[:16].lstrip()
    return any(head.startswith(sig) for sig in _IMAGE_SIGNATURES)


def resolved_url(crd, website_url: str | None, overrides: dict) -> str | None:
    """The link the site actually shows -- mirrors resolveWebsite() in
    frontend/src/websiteOverrides.js, so icons are checked for the same host
    the page renders."""
    hit = overrides.get(str(crd))
    if hit and hit.get("resolved"):
        if hit.get("via") == "research":
            return hit["resolved"]
        filed = hit.get("filed")
        if website_url and (not filed or website_url.strip() == filed.strip()):
            return hit["resolved"]
    return website_url


def site_hosts(db_path: Path, overrides_path: Path) -> list[str]:
    overrides = {}
    if overrides_path.exists():
        overrides = json.loads(overrides_path.read_text()).get("firms", {})
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute("SELECT crd, website_url FROM firms").fetchall()
    except duckdb.CatalogException:
        rows = []
    finally:
        con.close()
    hosts = {host_of(resolved_url(crd, url, overrides) or "") for crd, url in rows}
    hosts.discard("")
    return sorted(hosts)


def icon_source(host: str, session) -> str | None:
    """'duckduckgo', 'google', or None when neither has a real icon."""
    for source, template in (("duckduckgo", DUCKDUCKGO), ("google", GOOGLE)):
        try:
            r = session.get(template.format(host=host), headers=_HEADERS, timeout=TIMEOUT)
        except requests.exceptions.RequestException:
            continue
        if is_real_icon(r.status_code, r.content):
            return source
    return None


def check_hosts(hosts: list[str]) -> dict[str, str | None]:
    local = threading.local()

    def session():
        if not hasattr(local, "s"):
            local.s = requests.Session()
        return local.s

    results: dict[str, str | None] = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for i, (host, source) in enumerate(
            zip(hosts, pool.map(lambda h: icon_source(h, session()), hosts)), 1
        ):
            results[host] = source
            if i % 1000 == 0:
                print(f"  checked {i}/{len(hosts)} ({i / (time.time() - t0):.1f}/s)", flush=True)
    return results


def export(results: dict[str, str | None], out_path: Path) -> None:
    google = sorted(h for h, s in results.items() if s == "google")
    none = sorted(h for h, s in results.items() if s is None)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "checked": len(results),
        "google": google,
        "none": none,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(
        f"wrote {out_path}: {len(results):,} hosts checked -- "
        f"{len(results) - len(google) - len(none):,} DuckDuckGo, {len(google):,} Google, "
        f"{len(none):,} no icon"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    hosts = site_hosts(args.db, args.overrides)
    if not hosts:
        # An empty or pre-ingest database; don't replace a real export.
        print(f"no firm websites in this database; leaving {args.out} untouched")
        return 0
    print(f"checking icons for {len(hosts):,} hosts")
    export(check_hosts(hosts), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
