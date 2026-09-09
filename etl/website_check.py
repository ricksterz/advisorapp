"""Resolve each firm's filed website URL and export the ones that moved.

Firms file a website once (Form ADV Item 1.I) and rarely amend it, so links
rot: the firm rebrands, gets acquired, or lets the domain lapse. A full crawl
of 15,143 distinct filed URLs found 869 that now redirect to a different
domain and 717 that fail outright.

The filed URL is never overwritten. website_url stays exactly as filed, and
this module records where it resolves today; the export carries only the
subset worth acting on, so the site can link somewhere that works while still
showing what the firm actually filed.

Two things this deliberately does NOT act on:

  * Timeouts. A timeout is not evidence a site is dead. Re-checking the
    largest firms with a browser User-Agent and a longer read timeout showed
    goldman's petershillpartners.com and nuveen.com both alive and well --
    they simply refuse datacenter traffic. Broken rows are stored for review,
    never auto-applied.
  * Redirects whose destination is not a firm site. spoti.fi resolves to
    open.spotify.com; following that just swaps one wrong link for another.

Usage:
    python -m etl.website_check crawl  --db data/advisor.duckdb   # slow, network
    python -m etl.website_check import --db data/advisor.duckdb --from results.jsonl
    python -m etl.website_check export --db data/advisor.duckdb \
        --out frontend/public/website_overrides.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import duckdb
import requests
import urllib3

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import HTTP_HEADERS, REPO_ROOT, SCHEMA_PATH

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "website_overrides.json"

TIMEOUT = (6, 10)
MAX_WORKERS = 16

# Platforms that are not a firm's own website. ingest_adv.pick_website already
# screens the obvious social hosts, but the real filings reach further: a real
# pull has Vanguard listing a Reddit user profile, Point72 an Apple podcast,
# Bridgewater a SoundCloud page. Used here to avoid "fixing" a link by
# redirecting it to another non-site.
NON_FIRM = re.compile(
    r"(^|\.)(facebook|linkedin|twitter|instagram|yelp|reddit|medium|soundcloud|"
    r"youtube|youtu|blogspot|wordpress|wixsite|weebly|flickr|tumblr|substack|"
    r"godaddysites|spotify|spoti|apple)\.(com|be|fi)$|"
    r"(^|\.)podcasts\.apple\.com$|(^|\.)(blogspot|wordpress)\."
)

MULTI_PART_TLDS = {"co", "com", "org", "net", "gov", "ac"}


def norm_domain(u: str) -> str:
    try:
        host = urlparse(u if "://" in u else "http://" + u).hostname or ""
    except ValueError:
        return ""
    return host.lower().removeprefix("www.")


def registrable(domain: str) -> str:
    """Crude eTLD+1 — enough to tell one company from another.

    Deliberately simple: a full public-suffix list would be more correct but
    the only decision it feeds is "same company or not", where the common
    two-part suffixes (co.uk and friends) cover the real data.
    """
    parts = domain.split(".")
    if len(parts) < 3:
        return domain
    if parts[-2] in MULTI_PART_TLDS and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def classify(status_code: int, start_domain: str, final_domain: str) -> str:
    if status_code in (401, 403, 429):
        # Bot protection, not a dead site — reporting these as broken would
        # send firms chasing links that work fine in a browser.
        return "blocked_by_site"
    if status_code in (404, 410):
        return "not_found"
    if status_code >= 500:
        return "server_error"
    if status_code >= 400:
        return "http_error"
    if registrable(final_domain) != registrable(start_domain):
        return "cross_domain_redirect"
    return "ok"


def check_url(url: str, session_factory) -> dict:
    raw = url.strip()
    target = raw if "://" in raw else "https://" + raw
    out: dict = {"url": raw, "start_domain": norm_domain(target)}
    if NON_FIRM.search(out["start_domain"]):
        out["status"] = "not_a_firm_site"
        return out

    for method in ("head", "get"):
        try:
            r = session_factory().request(
                method,
                target,
                headers=HTTP_HEADERS,
                timeout=TIMEOUT,
                allow_redirects=True,
                verify=False,  # stale sites routinely have expired certs
                stream=(method == "get"),
            )
            if method == "get":
                r.close()
            if method == "head" and r.status_code in (400, 403, 405, 501):
                continue  # some servers reject HEAD; judge on the GET instead
            out["http"] = r.status_code
            out["final_url"] = str(r.url)
            out["final_domain"] = norm_domain(str(r.url))
            out["status"] = classify(r.status_code, out["start_domain"], out["final_domain"])
            return out
        except requests.exceptions.SSLError:
            out["error"] = "ssl"
        except requests.exceptions.ConnectTimeout:
            out["error"] = "connect_timeout"
        except requests.exceptions.ReadTimeout:
            out["error"] = "read_timeout"
        except requests.exceptions.TooManyRedirects:
            out["error"] = "redirect_loop"
        except requests.exceptions.ConnectionError as e:
            msg = str(e)
            out["error"] = "dns" if ("NameResolution" in msg or "getaddrinfo" in msg) else "conn_refused"
        except requests.exceptions.RequestException as e:
            out["error"] = type(e).__name__
        except Exception as e:  # noqa: BLE001 - one bad URL must not kill the run
            out["error"] = f"other: {type(e).__name__}"
    out["status"] = "unreachable"
    return out


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    return con


def store(con: duckdb.DuckDBPyConnection, rows: list[dict]) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    con.executemany(
        "INSERT OR REPLACE INTO website_checks "
        "(url, status, http_status, final_url, final_domain, error, checked_at) "
        "VALUES (?,?,?,?,?,?,?)",
        [
            (
                r["url"], r.get("status"), r.get("http"), r.get("final_url"),
                r.get("final_domain"), r.get("error"), now,
            )
            for r in rows
        ],
    )


def stage_crawl(con: duckdb.DuckDBPyConnection) -> None:
    urls = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT trim(website_url) FROM firms "
            "WHERE website_url IS NOT NULL AND trim(website_url) <> ''"
        ).fetchall()
    ]
    local = threading.local()

    def session():
        if not hasattr(local, "s"):
            local.s = requests.Session()
        return local.s

    results: list[dict] = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for i, res in enumerate(pool.map(lambda u: check_url(u, session), urls), 1):
            results.append(res)
            if i % 500 == 0:
                print(f"  checked {i}/{len(urls)} ({i/(time.time()-t0):.1f}/s)", flush=True)
    store(con, results)
    print(f"crawled {len(results):,} urls in {(time.time()-t0)/60:.1f}m")


def stage_import(con: duckdb.DuckDBPyConnection, path: Path) -> None:
    """Load a previous crawl's JSONL rather than re-running a 16-minute crawl."""
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    store(con, rows)
    print(f"imported {len(rows):,} check results from {path}")


def export_overrides(db_path: Path, out_path: Path) -> bool:
    """Firms whose filed URL now redirects to a working site on another domain.

    Only cross-domain redirects that returned 2xx are exported. Broken links
    are left alone on purpose (see the module docstring on timeouts), and a
    redirect landing on a non-firm platform is skipped rather than followed.
    """
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(
            """
            SELECT f.crd, trim(f.website_url), c.final_url, c.final_domain
            FROM firms f
            JOIN website_checks c ON c.url = trim(f.website_url)
            WHERE c.status = 'cross_domain_redirect'
              AND c.http_status >= 200 AND c.http_status < 300
              AND c.final_url IS NOT NULL
            """
        ).fetchall()
    except duckdb.CatalogException:
        rows = []
    finally:
        con.close()

    firms: dict[str, dict] = {}
    skipped_non_firm = 0
    for crd, filed, final, final_domain in rows:
        if NON_FIRM.search(final_domain or ""):
            skipped_non_firm += 1
            continue
        firms[str(crd)] = {"filed": filed, "resolved": final, "domain": final_domain}

    if not firms:
        print(f"no website overrides to write; leaving {out_path} untouched")
        return False

    out_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "firms": firms,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    )
    print(
        f"wrote {out_path} ({len(firms):,} firms redirected"
        f"{f', {skipped_non_firm} skipped as non-firm destinations' if skipped_non_firm else ''})"
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["crawl", "import", "export"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--from", dest="src", type=Path, help="JSONL for the import stage")
    args = parser.parse_args()

    if args.stage == "export":
        export_overrides(args.db, args.out)
        return 0

    con = connect(args.db)
    try:
        if args.stage == "crawl":
            stage_crawl(con)
        else:
            if not args.src:
                sys.exit("error: import needs --from <results.jsonl>")
            stage_import(con, args.src)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
