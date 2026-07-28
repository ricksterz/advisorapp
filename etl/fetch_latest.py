"""Locate and download the most recent SEC Form ADV bulk compilation file.

Resolution order:
1. Probe IAPD compilation-report URLs directly (reports.adviserinfo.sec.gov
   serves the SEC-registered-firm feed as IA_FIRM_SEC_Feed_<MM_DD_YYYY>.xml.gz;
   a fresh feed appears at least weekly, so recent dates are probed newest
   first).
2. Scrape the SEC's Form ADV data index pages for bulk file links. (Often
   blocked: www.sec.gov's WAF 403s cloud-hosted clients.)

Used by the Pages deploy workflow when no ADV_COMPILATION_URL repository
variable is set; exits non-zero if nothing could be resolved so the caller
can fall back to the sample fixture.

Usage:
    python -m etl.fetch_latest --dest data/raw/latest_adv_feed.xml.gz
    python -m etl.fetch_latest --dest /tmp/probe --probe-only   # print a content sample
"""

from __future__ import annotations

import argparse
import gzip
import re
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests

from etl.config import HTTP_HEADERS, RAW_DIR

IAPD_FEED_URL = (
    "https://reports.adviserinfo.sec.gov/reports/CompilationReports/"
    "IA_FIRM_SEC_Feed_{d.month:02d}_{d.day:02d}_{d.year}.xml.gz"
)
PROBE_DAYS = 45

INDEX_URLS = [
    "https://www.sec.gov/foia-services/frequently-requested-documents/form-adv-data",
    "https://www.sec.gov/foia/docs/form-adv-data",
]

# Highest-priority pattern first; within a class, page order (newest-first on
# the SEC index pages) is preserved.
NAME_PRIORITY = [
    r"ia[_-]?adv[_-]?base[_-]?a",  # firm-level base file, SEC-registered advisers
    r"adv[_-]?base",
    r"adv",
]


def url_exists(url: str) -> bool:
    try:
        resp = requests.head(url, headers=HTTP_HEADERS, timeout=30, allow_redirects=True)
        if resp.status_code == 405:  # host doesn't support HEAD
            with requests.get(url, headers=HTTP_HEADERS, timeout=30, stream=True) as get_resp:
                return get_resp.ok
        return resp.ok
    except requests.RequestException:
        return False


def probe_iapd_feed() -> str | None:
    today = datetime.now(timezone.utc).date()
    for offset in range(PROBE_DAYS):
        url = IAPD_FEED_URL.format(d=today - timedelta(days=offset))
        if url_exists(url):
            return url
    print(f"note: no IAPD feed found in the last {PROBE_DAYS} days")
    return None


def find_index_links(index_url: str) -> list[str]:
    resp = requests.get(index_url, headers=HTTP_HEADERS, timeout=60)
    resp.raise_for_status()
    hrefs = re.findall(r'href="([^"]+?\.(?:zip|gz|csv))"', resp.text, flags=re.IGNORECASE)
    return [urljoin(index_url, h) for h in hrefs]


def pick_candidate(links: list[str]) -> str | None:
    for pattern in NAME_PRIORITY:
        for link in links:
            if re.search(pattern, link.rsplit("/", 1)[-1], flags=re.IGNORECASE):
                return link
    return None


def scrape_indexes() -> str | None:
    for index_url in INDEX_URLS:
        try:
            links = find_index_links(index_url)
        except requests.RequestException as exc:
            print(f"note: could not read {index_url}: {exc}")
            continue
        candidate = pick_candidate(links)
        if candidate:
            print(f"resolved from {index_url}: {candidate}")
            return candidate
        print(f"note: no ADV links found on {index_url}")
    return None


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, headers=HTTP_HEADERS, timeout=600, stream=True) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as fh:
            fh.writelines(resp.iter_content(chunk_size=1 << 20))
    print(f"downloaded {url} ({dest.stat().st_size / 1e6:.1f} MB) -> {dest}")
    return dest


def print_sample(path: Path, chars: int = 3000) -> None:
    """Diagnostics: show what the downloaded file actually contains."""
    if path.name.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
            print(f"--- gzip content sample ({path.name}) ---")
            print(fh.read(chars))
    elif path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            print(f"--- zip contents: {zf.namelist()} ---")
            with zf.open(zf.namelist()[0]) as fh:
                print(fh.read(chars).decode("utf-8", errors="replace"))
    else:
        print(f"--- raw content sample ({path.name}) ---")
        print(path.read_bytes()[:chars].decode("utf-8", errors="replace"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dest", type=Path, default=RAW_DIR / "latest_adv_feed.xml.gz")
    parser.add_argument("--probe-only", action="store_true", help="print a content sample and exit")
    args = parser.parse_args()

    url = probe_iapd_feed() or scrape_indexes()
    if not url:
        sys.exit("error: could not resolve an ADV compilation file from any source")

    # Keep the resolved file's extension so downstream readers can dispatch on it.
    suffix = re.search(r"\.(?:xml\.gz|zip|csv|gz)$", url.rsplit("/", 1)[-1], flags=re.IGNORECASE)
    dest = args.dest
    if suffix and not dest.name.lower().endswith(suffix.group(0).lower()):
        dest = dest.with_name(dest.name.split(".")[0] + suffix.group(0))
        print(f"note: adjusting destination to {dest} to match source type")

    download(url, dest)
    if args.probe_only:
        print_sample(dest)


if __name__ == "__main__":
    main()
