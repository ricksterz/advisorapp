"""Long-run adviser history: SEC's monthly registered-adviser reports -> firm_trajectory.json.

Source: "Information About Registered Investment Advisers and Exempt Reporting
Advisers" on sec.gov, a monthly snapshot of every SEC-registered adviser's
current Form ADV Part 1A answers, published since 2006:

    https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers

Unlike the monthly filing archives Pulse uses (etl/pulse_history.py), each of
these files is the whole registered universe at a point in time, so no
reconstruction is needed, and they reach back years rather than to 2025. The
site uses one per year: the first report published each January.

What the real files taught, all checked rather than assumed:

  * The format changes: zipped CSV for most years, a zipped spreadsheet for
    some (2012-2018), and a bare .xlsx from mid-2023 to 2025. Column labels
    have stayed the same ("Organization CRD#", "5A", "5B(1)", "5F(2)(c)",
    "5F(2)(f)") across every vintage read.
  * Early reports (2012) carry no Item 5.A/5.B headcount at all, so history
    starts at the first January report that does (see FIRST_YEAR).
  * Each report shows a firm's latest filing, and annual amendments are due
    within 90 days of fiscal year end, so a January report mostly reflects
    the prior spring's numbers. Consecutive years are therefore roughly a
    year apart, not exactly, and a firm that didn't amend repeats its figure.

www.sec.gov rejects automated clients that don't declare a contact, so fetch
needs SEC_CONTACT_EMAIL set (see etl/config.sec_www_headers).

Usage:
    SEC_CONTACT_EMAIL=you@example.com python -m etl.adviser_history fetch
    python -m etl.adviser_history load --db data/advisor.duckdb
    python -m etl.adviser_history export --db data/advisor.duckdb
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import time
import zipfile
from datetime import UTC, date, datetime
from pathlib import Path

import duckdb
import pandas as pd
import requests

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import RAW_DIR, REPO_ROOT, SCHEMA_PATH, sec_www_headers
from etl.ingest_adv import to_number

SOURCE_PAGE = (
    "https://www.sec.gov/data-research/sec-markets-data/"
    "information-about-registered-investment-advisers-exempt-reporting-advisers"
)
HISTORY_RAW_DIR = RAW_DIR / "ia_history"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "firm_trajectory.json"
FIRST_YEAR = 2013
THROTTLE_SECONDS = 1.0

COLUMNS: dict[str, list[str]] = {
    "crd": ["ORGANIZATION CRD#", "ORGANIZATION CRD"],
    "aum_total": ["5F(2)(C)", "5F2C"],
    "accounts_total": ["5F(2)(F)", "5F2F"],
    "employees_total": ["5A"],
    "employees_advisory": ["5B(1)", "5B1"],
}


# --------------------------------------------------------------------------- fetch


def report_links(page_html: str) -> dict[date, str]:
    """Registered-adviser report URLs by report date. Exempt-reporting-adviser
    files, which sit beside them on the page, are skipped."""
    out: dict[date, str] = {}
    for href in re.findall(r'href="([^"]+\.(?:zip|xlsx))"', page_html):
        name = href.rsplit("/", 1)[-1]
        if "exempt" in name.lower():
            continue
        m = re.match(r"ia(\d{2})(\d{2})(\d{4}|\d{2})", name)
        if not m:
            continue
        month, day, year = (int(x) for x in m.groups())
        if year < 100:
            year += 2000
        try:
            when = date(year, month, day)
        except ValueError:
            continue
        url = href if href.startswith("http") else "https://www.sec.gov" + href
        out.setdefault(when, url)
    return out


def reports_by_year(links: dict[date, str], first_year: int = FIRST_YEAR) -> dict[int, list[str]]:
    """Each year's reports, earliest first. The first is the site's annual
    snapshot; the rest are fallbacks for when it is unusable."""
    by_year: dict[int, list[tuple[date, str]]] = {}
    for when, url in links.items():
        if when.year >= first_year:
            by_year.setdefault(when.year, []).append((when, url))
    return {year: [url for _, url in sorted(v)] for year, v in sorted(by_year.items())}


# A real report is megabytes. SEC's link for January 2019 serves a 247-byte
# zip holding a stub text file, so anything this small is treated as missing.
MIN_REPORT_BYTES = 1_000_000


def stage_fetch() -> None:
    headers = sec_www_headers()
    page = requests.get(SOURCE_PAGE, headers=headers, timeout=60)
    page.raise_for_status()
    wanted = reports_by_year(report_links(page.text))
    if not wanted:
        raise SystemExit("error: no registered-adviser reports found on the SEC page")
    HISTORY_RAW_DIR.mkdir(parents=True, exist_ok=True)
    have = []
    for year, urls in wanted.items():
        for url in urls:
            dest = HISTORY_RAW_DIR / url.rsplit("/", 1)[-1]
            if not dest.exists():
                r = requests.get(url, headers=headers, timeout=300)
                r.raise_for_status()
                dest.write_bytes(r.content)
                time.sleep(THROTTLE_SECONDS)
            if dest.stat().st_size >= MIN_REPORT_BYTES:
                have.append(year)
                print(f"{year}: {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
                break
            print(f"{year}: {dest.name} is a stub ({dest.stat().st_size} bytes); trying the next report")
            dest.unlink()
    print(f"have {len(have)} annual reports ({min(have)}-{max(have)})")


# --------------------------------------------------------------------------- load


def report_date(name: str) -> date | None:
    m = re.match(r"ia(\d{2})(\d{2})(\d{4}|\d{2})", name)
    if not m:
        return None
    month, day, year = (int(x) for x in m.groups())
    return date(year + 2000 if year < 100 else year, month, day)


def read_report(path: Path) -> pd.DataFrame:
    """A report as strings, whatever the year's format."""
    if path.suffix.lower() == ".xlsx":
        return pd.read_excel(path, dtype=str)
    with zipfile.ZipFile(path) as zf:
        member = next(
            n for n in zf.namelist() if n.lower().endswith((".csv", ".txt", ".xlsx", ".xls"))
        )
        data = zf.read(member)
    if member.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(io.BytesIO(data), dtype=str)
    return pd.read_csv(io.BytesIO(data), encoding="latin-1", dtype=str, low_memory=False)


def extract(raw: pd.DataFrame) -> pd.DataFrame:
    """The columns the site uses, numeric; firms without a CRD are dropped."""
    headers = {str(c).strip().upper(): c for c in raw.columns}
    out = pd.DataFrame()
    for field, candidates in COLUMNS.items():
        source = next((headers[c] for c in candidates if c in headers), None)
        out[field] = raw[source].map(to_number) if source is not None else None
    out = out.dropna(subset=["crd"])
    out["crd"] = out["crd"].astype("int64")
    return out.drop_duplicates(subset="crd", keep="last")


def stage_load(con: duckdb.DuckDBPyConnection) -> None:
    files = sorted(HISTORY_RAW_DIR.glob("ia*"))
    if not files:
        print(f"no reports in {HISTORY_RAW_DIR}; run the fetch stage first")
        return
    # One report per year: the earliest usable one, as fetch chose.
    by_year: dict[int, tuple[date, Path]] = {}
    for path in files:
        when = report_date(path.name)
        if when is None or path.stat().st_size < MIN_REPORT_BYTES:
            continue
        if when.year not in by_year or when < by_year[when.year][0]:
            by_year[when.year] = (when, path)
    con.execute(
        "DELETE FROM adviser_annual WHERE source_file NOT IN (SELECT unnest(?))",
        [[p.name for _, p in by_year.values()]],
    )
    for when, path in sorted(by_year.values()):
        firms = extract(read_report(path))
        if firms["employees_total"].isna().all():
            print(f"skipping {path.name}: no Item 5.A headcount in this vintage")
            continue
        firms.insert(0, "as_of", when)
        firms["source_file"] = path.name
        con.execute("DELETE FROM adviser_annual WHERE source_file = ?", [path.name])
        con.register("_annual", firms)
        con.execute(
            "INSERT INTO adviser_annual SELECT as_of, crd, aum_total, accounts_total, "
            "employees_total, employees_advisory, source_file FROM _annual"
        )
        con.unregister("_annual")
        print(f"loaded {path.name}: {len(firms):,} advisers as of {when}")


# --------------------------------------------------------------------------- export


def compact_aum(v: float | None) -> float | None:
    """AUM in $M: whole millions from $100M up, one decimal below. Three
    significant figures is more than the filings' own precision supports and
    keeps a file every firm page loads small."""
    if v is None or (isinstance(v, float) and math.isnan(v)) or v < 0:
        return None
    m = v / 1e6
    return round(m) if m >= 100 else round(m, 1)


def _int(v) -> int | None:
    if v is None or (isinstance(v, float) and math.isnan(v)) or v < 0:
        return None
    return round(v)


def non_advisory(total, advisory) -> int | None:
    t, a = _int(total), _int(advisory)
    if t is None or a is None or a > t:
        return None
    return t - a


def segment_of(row: dict) -> str | None:
    """Mirror of frontend/src/segments.js firmSegment."""
    shares = {
        "wealth": row["pct_aum_wealth"],
        "registered_funds": row["pct_aum_registered_funds"],
        "private_funds": row["pct_aum_private_funds"],
        "institutional": row["pct_aum_institutional"],
    }
    if all(v is None for v in shares.values()):
        return None
    best = max((k for k, v in shares.items() if v is not None), key=lambda k: shares[k])
    return best if shares[best] > 50 else "mixed"


def fit_line(points: list[tuple[float, float]]) -> dict | None:
    """Least squares y = a + b x."""
    n = len(points)
    if n < 30:
        return None
    sx = sum(x for x, _ in points)
    sy = sum(y for _, y in points)
    sxx = sum(x * x for x, _ in points)
    sxy = sum(x * y for x, y in points)
    denom = n * sxx - sx * sx
    if denom == 0:
        return None
    b = (n * sxy - sx * sy) / denom
    return {"n": n, "slope": b, "intercept": (sy - b * sx) / n}


SPAN_YEARS = 5


def growth_fits(series: dict[int, dict], years: list[int], segments: dict[int, str]) -> dict:
    """How firms' own support staff changed as their AUM changed, per segment.

    Pairs every firm's figures SPAN_YEARS apart and fits the change in log
    non-advisory staff on the change in log AUM. Unlike a fit across firms of
    different sizes at one moment, this follows the same firm over time. The
    slope says how staff moved with assets; the intercept, what happened to
    staff over five years at a firm whose AUM stood still.
    """
    by_segment: dict[str, list[tuple[float, float]]] = {}
    for crd, s in series.items():
        seg = segments.get(crd)
        if not seg:
            continue
        for i, y0 in enumerate(years):
            j = i + SPAN_YEARS
            if j >= len(years):
                break
            a0, a1 = s["aum"][i], s["aum"][j]
            n0, n1 = s["support"][i], s["support"][j]
            if not (a0 and a1 and n0 and n1) or min(a0, a1) < 1:  # under $1M is noise
                continue
            by_segment.setdefault(seg, []).append(
                (math.log(a1 / a0), math.log(n1 / n0))
            )
    out = {}
    for seg, pts in by_segment.items():
        fit = fit_line(pts)
        if fit:
            out[seg] = {
                "pairs": fit["n"],
                "slope": round(fit["slope"], 4),
                "intercept": round(fit["intercept"], 4),
            }
    return out


def export(db_path: Path, out_path: Path) -> bool:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            rows = con.execute(
                "SELECT year(as_of), crd, aum_total, accounts_total, employees_total, "
                "employees_advisory FROM adviser_annual ORDER BY as_of"
            ).fetchall()
        except duckdb.CatalogException:
            rows = []
        if not rows:
            print(f"no adviser history in this database; leaving {out_path} untouched")
            return False
        current = {
            r[0]: dict(zip(["pct_aum_wealth", "pct_aum_registered_funds", "pct_aum_private_funds", "pct_aum_institutional"], r[1:]))
            for r in con.execute(
                "SELECT crd, pct_aum_wealth, pct_aum_registered_funds, pct_aum_private_funds, "
                "pct_aum_institutional FROM firms"
            ).fetchall()
        }
    finally:
        con.close()

    years = sorted({r[0] for r in rows})
    index = {y: i for i, y in enumerate(years)}

    def blank() -> list:
        return [None] * len(years)

    series: dict[int, dict] = {}
    for year, crd, aum, accounts, total, advisory in rows:
        s = series.setdefault(
            crd, {"aum": blank(), "accounts": blank(), "employees": blank(), "support": blank()}
        )
        i = index[year]
        s["aum"][i] = compact_aum(aum)
        s["accounts"][i] = _int(accounts)
        s["employees"][i] = _int(total)
        s["support"][i] = non_advisory(total, advisory)

    segments = {crd: segment_of(row) for crd, row in current.items()}
    fits = growth_fits(series, years, segments)

    # Only firms registered today, and only if they appear in at least two
    # years -- a single point is not a trajectory.
    firms = {}
    for crd, s in series.items():
        if crd not in current:
            continue
        if sum(1 for v in s["aum"] if v is not None) < 2:
            continue
        # [aum $M, employees, non-advisory employees, accounts], one value per year.
        firms[str(crd)] = [s["aum"], s["employees"], s["support"], s["accounts"]]

    payload = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "years": years,
        "span_years": SPAN_YEARS,
        "segment_growth": fits,
        "firms": firms,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(
        f"wrote {out_path}: {len(firms):,} firms across {years[0]}-{years[-1]} "
        f"({out_path.stat().st_size / 1e6:.1f} MB)"
    )
    for seg, f in fits.items():
        print(
            f"  {seg}: {f['pairs']:,} five-year pairs, doubling AUM -> "
            f"{(2 ** f['slope'] - 1) * 100:+.0f}% support staff; flat AUM -> "
            f"{(math.exp(f['intercept']) - 1) * 100:+.0f}%"
        )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["fetch", "load", "export"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if args.stage == "fetch":
        stage_fetch()
    elif args.stage == "load":
        con = duckdb.connect(str(args.db))
        try:
            con.execute(SCHEMA_PATH.read_text())
            stage_load(con)
        finally:
            con.close()
    else:
        export(args.db, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
