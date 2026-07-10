"""Locate and download the most recent SEC Form ADV bulk compilation file.

Scrapes the SEC's Form ADV data index pages for bulk .zip links and downloads
the newest, preferring the IA (SEC-registered adviser) firm-level base file.
Used by the Pages deploy workflow when no ADV_COMPILATION_URL repository
variable is set; exits non-zero if nothing could be resolved so the caller
can fall back to the sample fixture.

Usage:
    python -m etl.fetch_latest --dest data/raw/latest_adv.zip
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

import requests

from etl.config import HTTP_HEADERS, RAW_DIR

INDEX_URLS = [
    "https://www.sec.gov/foia-services/frequently-requested-documents/form-adv-data",
    "https://www.sec.gov/foia/docs/form-adv-data",
    "https://adviserinfo.sec.gov/compilation",
]

# Highest-priority pattern first; within a class, page order (newest-first on
# the SEC index pages) is preserved.
NAME_PRIORITY = [
    r"ia[_-]?adv[_-]?base[_-]?a",  # firm-level base file, SEC-registered advisers
    r"adv[_-]?base",
    r"adv",
]


def find_zip_links(index_url: str) -> list[str]:
    resp = requests.get(index_url, headers=HTTP_HEADERS, timeout=60)
    resp.raise_for_status()
    hrefs = re.findall(r'href="([^"]+?\.zip)"', resp.text, flags=re.IGNORECASE)
    return [urljoin(index_url, h) for h in hrefs]


def pick_candidate(links: list[str]) -> str | None:
    for pattern in NAME_PRIORITY:
        for link in links:
            if re.search(pattern, link.rsplit("/", 1)[-1], flags=re.IGNORECASE):
                return link
    return None


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, headers=HTTP_HEADERS, timeout=600, stream=True) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    print(f"downloaded {url} ({dest.stat().st_size / 1e6:.1f} MB) -> {dest}")
    return dest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dest", type=Path, default=RAW_DIR / "latest_adv.zip")
    args = parser.parse_args()

    for index_url in INDEX_URLS:
        try:
            links = find_zip_links(index_url)
        except requests.RequestException as exc:
            print(f"note: could not read {index_url}: {exc}")
            continue
        candidate = pick_candidate(links)
        if candidate:
            print(f"resolved from {index_url}: {candidate}")
            download(candidate, args.dest)
            return
        print(f"note: no ADV zip links found on {index_url}")

    sys.exit("error: could not resolve an ADV compilation file from any index page")


if __name__ == "__main__":
    main()
