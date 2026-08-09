"""Pre-render per-route <head> metadata for the SPA's real URLs.

The app is a single-page app: every route is served the same index.html, whose
canonical URL is the homepage. FirmDetail.jsx patches the canonical, title and
description after React mounts, on the assumption that crawlers render JS.
Google does render JS, but it evaluated the canonical it was *served* and took
it at face value -- so all ~17K firm URLs reported as "Alternate page with
proper canonical tag" in Search Console, meaning every one of them was
consolidated into the homepage and dropped from the index.

This writes a real HTML file per route with the correct <head> already in it:
dist/firm/{crd}.html, dist/pulse.html, dist/pulse/{section}.html. Cloudflare's
static-asset host serves /firm/105958 from firm/105958.html automatically, and
an unknown CRD still falls through to the SPA shell via not_found_handling.

Only the <head> is templated -- the body stays the empty shell React hydrates.
That is enough to fix canonicalization and give each URL a distinct title and
description; it does not attempt to pre-render visible firm content.

The metadata strings here intentionally mirror the ones FirmDetail.jsx and
App.jsx set at runtime, so the pre-rendered and hydrated states agree.

Usage:
    python -m etl.gen_static_pages --data frontend/public/firms.json \
        --site https://open-disclosure.com --out frontend/dist
"""

from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

# Workers Static Assets caps a version at 20,000 files on the Free plan
# (100,000 on Paid). One file per firm puts the site within a few thousand of
# that ceiling, so the build fails loudly here rather than at deploy time,
# where the error surfaces as an opaque upload rejection.
DEFAULT_MAX_FILES = 19_000

DEFAULT_TITLE = "Open Disclosure — SEC Form ADV adviser benchmarking"

# Mirrors PULSE_TITLES in App.jsx.
PULSE_TITLES = {
    "": "Industry Pulse",
    "advisers": "Adviser counts & growth — Industry Pulse",
    "assets": "Assets & AUM bands — Industry Pulse",
    "private-funds": "Private funds — Industry Pulse",
    "disclosures": "Disclosures — Industry Pulse",
    "capital-formation": "Capital formation — Industry Pulse",
}

# Each pattern must match exactly once in the template. A silently-unmatched
# substitution would emit thousands of pages that still carry the homepage
# canonical -- worse than doing nothing, because the deploy would look fixed
# while Search Console kept dropping the pages. Vite preserves the source's
# multi-line meta tags, hence the \s+ between attributes.
_SUBSTITUTIONS = {
    "title": re.compile(r"<title>.*?</title>", re.S),
    "description": re.compile(r'<meta\s+name="description"\s+content="[^"]*"\s*/>', re.S),
    "canonical": re.compile(r'<link rel="canonical" href="[^"]*"\s*/>'),
    "og:title": re.compile(r'<meta property="og:title" content="[^"]*"\s*/>'),
    "og:description": re.compile(
        r'<meta\s+property="og:description"\s+content="[^"]*"\s*/>', re.S
    ),
    "og:url": re.compile(r'<meta property="og:url" content="[^"]*"\s*/>'),
    "twitter:title": re.compile(r'<meta name="twitter:title" content="[^"]*"\s*/>'),
    "twitter:description": re.compile(
        r'<meta\s+name="twitter:description"\s+content="[^"]*"\s*/>', re.S
    ),
}


def verify_template(template: str) -> None:
    """Fail before writing anything if the built HTML no longer matches."""
    for name, pattern in _SUBSTITUTIONS.items():
        found = len(pattern.findall(template))
        if found != 1:
            raise SystemExit(
                f"error: expected exactly 1 '{name}' tag in the template, found {found}. "
                "frontend/index.html changed shape — update _SUBSTITUTIONS in "
                "etl/gen_static_pages.py to match."
            )


def render(template: str, *, title: str, description: str, canonical: str) -> str:
    t, d, c = (html.escape(x, quote=True) for x in (title, description, canonical))
    replacements = {
        "title": f"<title>{t}</title>",
        "description": f'<meta name="description" content="{d}" />',
        "canonical": f'<link rel="canonical" href="{c}" />',
        "og:title": f'<meta property="og:title" content="{t}" />',
        "og:description": f'<meta property="og:description" content="{d}" />',
        "og:url": f'<meta property="og:url" content="{c}" />',
        "twitter:title": f'<meta name="twitter:title" content="{t}" />',
        "twitter:description": f'<meta name="twitter:description" content="{d}" />',
    }
    out = template
    for name, pattern in _SUBSTITUTIONS.items():
        # count=1 with an already-verified single match; escape the replacement
        # so a firm name containing a backslash or \g can't corrupt the output.
        out = pattern.sub(replacements[name].replace("\\", r"\\"), out, count=1)
    return out


def firm_meta(firm: dict, site: str) -> tuple[str, str, str]:
    """Title, description and canonical for one firm — mirrors FirmDetail.jsx."""
    name = firm.get("business_name") or firm.get("legal_name") or f"CRD {firm['crd']}"
    crd = firm["crd"]
    state = f", {firm['state']}" if firm.get("state") else ""
    return (
        f"{name} — Form ADV profile · Open Disclosure",
        f"{name} (CRD {crd}{state}): regulatory AUM, client mix, fee structure, "
        "and disciplinary history from SEC Form ADV filings.",
        f"{site}/firm/{crd}",
    )


def generate(data_path: Path, site: str, out_dir: Path, max_files: int) -> int:
    site = site.rstrip("/")
    template_path = out_dir / "index.html"
    if not template_path.exists():
        raise SystemExit(
            f"error: {template_path} not found — run the frontend build before this step."
        )
    template = template_path.read_text()
    verify_template(template)

    payload = json.loads(data_path.read_text())
    firms = payload["firms"]
    written = 0

    firm_dir = out_dir / "firm"
    firm_dir.mkdir(parents=True, exist_ok=True)
    for firm in firms:
        title, description, canonical = firm_meta(firm, site)
        page = render(template, title=title, description=description, canonical=canonical)
        (firm_dir / f"{firm['crd']}.html").write_text(page)
        written += 1

    # Pulse sections are a handful of URLs but hit the same homepage-canonical
    # problem, and they are in the sitemap too.
    for section, label in PULSE_TITLES.items():
        path = "pulse" if not section else f"pulse/{section}"
        page = render(
            template,
            title=f"{label} · Open Disclosure",
            description=(
                f"{label}: industry-wide statistics for SEC-registered investment "
                "advisers, reconstructed from public Form ADV filings."
            ),
            canonical=f"{site}/{path}",
        )
        dest = out_dir / f"{path}.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(page)
        written += 1

    total = sum(1 for p in out_dir.rglob("*") if p.is_file())
    if total > max_files:
        raise SystemExit(
            f"error: {total} files in {out_dir} exceeds the {max_files} guard "
            "(Workers Static Assets allows 20,000 per version on the Free plan). "
            "Upgrade the plan or stop pre-rendering the long tail of firms."
        )

    print(f"wrote {written} pre-rendered pages to {out_dir} ({total} files total)")
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="firms.json path")
    parser.add_argument("--site", required=True, help="canonical site origin")
    parser.add_argument("--out", type=Path, required=True, help="the built dist directory")
    parser.add_argument(
        "--max-files",
        type=int,
        default=DEFAULT_MAX_FILES,
        help=f"fail if dist ends up with more files than this (default {DEFAULT_MAX_FILES})",
    )
    args = parser.parse_args()
    generate(args.data, args.site, args.out, args.max_files)


if __name__ == "__main__":
    main()
