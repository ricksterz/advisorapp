"""Industry Pulse history pipeline: monthly ADV filing archives -> quarterly
point-in-time snapshots.

Sources (verified 2026-07-19 by reading the IAPD SPA bundle and downloading
real archives — see docs/industry-pulse-plan.md section 0b):
- reports.adviserinfo.sec.gov/reports/foia/reports_metadata.json — index of
  everything below (the sec.gov FOIA pages WAF-block non-browser clients;
  this reports host accepts the project UA).
- advFilingData/{year}/ADV_Filing_Data_YYYYMMDD_YYYYMMDD.zip — one month of
  Form ADV filings (~9MB, 101 CSVs; we read IA_ADV_Base_A only for Phase 1).
- advW/{year}/ADVW_YYYYMMDD_YYYYMMDD.zip — one month of Form ADV-W
  (withdrawal) filings.

Structural caveat that shapes everything here: a monthly archive holds only
the advisers who FILED that month, not the whole universe. Advisers must file
an annual amendment (most cluster in Q1), so a point-in-time snapshot for a
quarter-end is reconstructed as "each CRD's latest filing on or before that
date, no older than SNAPSHOT_STALENESS_MONTHS". Quarters early in the
available window are structurally incomplete; etl/pulse_stats.py measures
completeness per quarter and only publishes quarters above its threshold
rather than presenting a partially-observed universe as fact.

Usage:
    python -m etl.pulse_history fetch                  # download missing archives
    python -m etl.pulse_history load                   # archives -> adv_filings/adv_withdrawals
    python -m etl.pulse_history snapshots              # build firm_snapshots per quarter
    python -m etl.pulse_history run                    # all three
"""

from __future__ import annotations

import argparse
import io
import re
import sys
import time
import zipfile
from datetime import date
from pathlib import Path

import duckdb
import pandas as pd
import requests

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import HTTP_HEADERS, RAW_DIR, SCHEMA_PATH
from etl.ingest_adv import normalize_header, to_bool, to_number

PULSE_RAW_DIR = RAW_DIR / "pulse"
REPORTS_BASE = "https://reports.adviserinfo.sec.gov/reports/foia"
METADATA_URL = f"{REPORTS_BASE}/reports_metadata.json"
THROTTLE_SECONDS = 1.0

# How stale a firm's latest filing may be and still count toward a
# quarter-end snapshot. Annual amendments are due ~90 days after fiscal year
# end, so anything older than this window almost always means the adviser has
# effectively left (or the archive window simply doesn't reach back far
# enough yet — same signal for our purposes: don't count them).
SNAPSHOT_STALENESS_MONTHS = 15

# IA_ADV_Base_A columns -> snapshot fields. Headers verified against the real
# 2026-06 archive; matching is candidate-based like ingest_adv.FIRM_COLUMNS
# in case names drift between vintages.
FILING_COLUMNS: dict[str, list[str]] = {
    "crd": ["1E1"],
    "legal_name": ["1A"],
    "date_submitted": ["DATESUBMITTED"],
    "filing_id": ["FILINGID"],
    "state": ["1F1-STATE"],
    "aum_total": ["5F2C", "5F(2)(C)"],
    "aum_discretionary": ["5F2A", "5F(2)(A)"],
    "employees_advisory": ["5B1", "5B(1)"],
    "fee_pct_of_aum": ["5E1", "5E(1)"],
    "fee_performance_based": ["5E6", "5E(6)"],
    "fee_commissions": ["5E5", "5E(5)"],
}
NUMERIC = {"crd", "filing_id", "aum_total", "aum_discretionary", "employees_advisory"}
BOOLEAN = {"fee_pct_of_aum", "fee_performance_based", "fee_commissions"}


def _resolve(headers: dict[str, str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in headers:
            return headers[c]
    return None


def parse_base_a(raw: pd.DataFrame) -> pd.DataFrame:
    """Map a monthly IA_ADV_Base_A dataframe onto the adv_filings schema."""
    headers = {normalize_header(c): c for c in raw.columns}
    out = pd.DataFrame()
    missing = []
    for field, candidates in FILING_COLUMNS.items():
        src = _resolve(headers, candidates)
        if src is None:
            missing.append(field)
            continue
        col = raw[src]
        if field in NUMERIC:
            out[field] = col.map(to_number)
        elif field in BOOLEAN:
            out[field] = col.map(to_bool)
        else:
            out[field] = col.astype(str).str.strip()
    if {"crd", "filing_id", "date_submitted"} & set(missing):
        sys.exit(f"error: required columns missing from this vintage: {missing}")
    if missing:
        print(f"note: fields not found in this vintage: {', '.join(missing)}")

    # Item 11 disciplinary flags: count Y answers across all 11* columns,
    # same approach as ingest_adv.extract_firms.
    disciplinary_cols = [c for norm, c in headers.items() if norm.startswith("11") and norm != "11"]
    if disciplinary_cols:
        out["disciplinary_flag_count"] = (
            raw[disciplinary_cols].apply(lambda col: col.map(to_bool).fillna(False)).sum(axis=1).astype(int)
        )
    else:
        out["disciplinary_flag_count"] = 0

    out["date_submitted"] = pd.to_datetime(out["date_submitted"], errors="coerce").dt.date
    out = out.dropna(subset=["crd", "filing_id", "date_submitted"])
    out["crd"] = out["crd"].astype("int64")
    out["filing_id"] = out["filing_id"].astype("int64")
    # An adviser can amend more than once in a month; keep every filing —
    # the snapshot stage picks the latest per CRD per quarter.
    return out.drop_duplicates(subset="filing_id", keep="last")


def parse_advw(raw: pd.DataFrame) -> pd.DataFrame:
    headers = {normalize_header(c): c for c in raw.columns}
    crd = _resolve(headers, ["CRDNUMBER"])
    fid = _resolve(headers, ["FILINGID"])
    fdate = _resolve(headers, ["FILINGDATE"])
    if not (crd and fid and fdate):
        sys.exit(f"error: ADVW columns not found; saw {list(raw.columns)[:10]}")
    out = pd.DataFrame(
        {
            "filing_id": raw[fid].map(to_number),
            "crd": raw[crd].map(to_number),
            "filing_date": pd.to_datetime(raw[fdate], errors="coerce").dt.date,
        }
    ).dropna(subset=["filing_id", "crd", "filing_date"])
    out["filing_id"] = out["filing_id"].astype("int64")
    out["crd"] = out["crd"].astype("int64")
    return out.drop_duplicates(subset="filing_id", keep="last")


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    return con


def stage_fetch() -> None:
    """Download any advFilingData/advW archives not already on disk."""
    PULSE_RAW_DIR.mkdir(parents=True, exist_ok=True)
    resp = requests.get(METADATA_URL, headers=HTTP_HEADERS, timeout=60)
    resp.raise_for_status()
    meta = resp.json()
    wanted: list[tuple[str, str]] = []
    for section in ("advFilingData", "advW"):
        for year, content in sorted(meta.get(section, {}).items()):
            if not year.isdigit():
                continue
            for f in content.get("files", []):
                wanted.append((section, f"{year}/{f['fileName']}"))
    got = 0
    for section, rel in wanted:
        dest = PULSE_RAW_DIR / Path(rel).name
        if dest.exists():
            continue
        url = f"{REPORTS_BASE}/{section}/{rel}"
        r = requests.get(url, headers=HTTP_HEADERS, timeout=300)
        if r.ok:
            dest.write_bytes(r.content)
            got += 1
            print(f"fetched {dest.name}")
        else:
            print(f"note: {url} -> {r.status_code}")
        time.sleep(THROTTLE_SECONDS)
    print(f"fetch done: {got} new archives, {len(wanted)} known")


def _archive_member(zf: zipfile.ZipFile, pattern: str) -> str | None:
    rx = re.compile(pattern)
    for name in zf.namelist():
        if rx.fullmatch(name):
            return name
    return None


def _read_member_csv(
    zf: zipfile.ZipFile, member: str, keep_default_na: bool = True
) -> pd.DataFrame:
    """Read a CSV member, tolerating the occasional malformed row these SEC
    dumps contain (unescaped delimiters). Bad rows are skipped and counted —
    a handful of dropped rows in a monthly file is acceptable for aggregate
    statistics; silently mangled ones would not be.

    Pass keep_default_na=False when a column's REAL values collide with
    pandas' default NA strings. Form ADV Schedule A codes "under 5%
    ownership" as the literal string "NA", which pandas otherwise reads as
    missing — silently erasing the single most common ownership band. Default
    stays True so every existing caller behaves exactly as before.
    """
    data = zf.read(member)
    try:
        return pd.read_csv(
            io.BytesIO(data),
            dtype=str,
            low_memory=False,
            encoding_errors="replace",
            keep_default_na=keep_default_na,
        )
    except pd.errors.ParserError:
        bad: list[int] = []

        def _on_bad(row):  # engine='python' callable form: return None to skip
            bad.append(1)

        df = pd.read_csv(
            io.BytesIO(data),
            dtype=str,
            engine="python",
            encoding_errors="replace",
            keep_default_na=keep_default_na,
            on_bad_lines=_on_bad,
        )
        print(f"note: {member}: skipped {len(bad)} malformed row(s)")
        return df


def stage_load(con: duckdb.DuckDBPyConnection) -> None:
    """Load every not-yet-loaded archive into adv_filings / adv_withdrawals."""
    loaded = {
        r[0] for r in con.execute("SELECT DISTINCT source_archive FROM adv_filings").fetchall()
    } | {r[0] for r in con.execute("SELECT DISTINCT source_archive FROM adv_withdrawals").fetchall()}

    for path in sorted(PULSE_RAW_DIR.glob("*.zip")):
        if path.name in loaded:
            continue
        with zipfile.ZipFile(path) as zf:
            if path.name.startswith("ADV_Filing_Data"):
                member = _archive_member(zf, r"IA_ADV_Base_A_\d{8}_\d{8}\.csv")
                if not member:
                    print(f"note: no IA_ADV_Base_A in {path.name}, skipping")
                    continue
                raw = _read_member_csv(zf, member)
                filings = parse_base_a(raw)
                filings["source_archive"] = path.name
                con.execute("DELETE FROM adv_filings WHERE source_archive = ?", [path.name])
                con.register("staging", filings)
                cols = ", ".join(filings.columns)
                con.execute(f"INSERT OR REPLACE INTO adv_filings ({cols}) SELECT {cols} FROM staging")  # nosec B608
                print(f"loaded {path.name}: {len(filings)} filings")
            elif path.name.startswith("ADVW_"):
                member = _archive_member(zf, r"ADVW_\d{8}_\d{8}\.csv")
                if not member:
                    print(f"note: no main ADVW csv in {path.name}, skipping")
                    continue
                raw = _read_member_csv(zf, member)
                w = parse_advw(raw)
                w["source_archive"] = path.name
                con.execute("DELETE FROM adv_withdrawals WHERE source_archive = ?", [path.name])
                con.register("staging_w", w)
                cols = ", ".join(w.columns)
                con.execute(f"INSERT OR REPLACE INTO adv_withdrawals ({cols}) SELECT {cols} FROM staging_w")  # nosec B608
                print(f"loaded {path.name}: {len(w)} withdrawals")


def quarter_ends(con: duckdb.DuckDBPyConnection) -> list[date]:
    lo, hi = con.execute("SELECT min(date_submitted), max(date_submitted) FROM adv_filings").fetchone()
    if lo is None:
        return []
    ends = []
    y, q = lo.year, (lo.month - 1) // 3 + 1
    while True:
        month = q * 3
        end = date(y, month, {3: 31, 6: 30, 9: 30, 12: 31}[month])
        if end > hi:
            break
        ends.append(end)
        q += 1
        if q == 5:
            q, y = 1, y + 1
    return ends


def stage_snapshots(con: duckdb.DuckDBPyConnection) -> None:
    """Rebuild firm_snapshots: per quarter-end, each CRD's latest filing on or
    before that date within the staleness window."""
    ends = quarter_ends(con)
    if not ends:
        print("no filings loaded; nothing to snapshot")
        return
    con.execute("DELETE FROM firm_snapshots")
    for end in ends:
        con.execute(
            """
            INSERT INTO firm_snapshots
            SELECT ?::DATE AS snapshot_quarter, crd, aum_total, aum_discretionary,
                   employees_advisory, state, fee_pct_of_aum, fee_performance_based,
                   fee_commissions, disciplinary_flag_count
            FROM (
                SELECT f.*, row_number() OVER (
                    PARTITION BY f.crd ORDER BY f.date_submitted DESC, f.filing_id DESC
                ) AS rn
                FROM adv_filings f
                WHERE f.date_submitted <= ?::DATE
                  AND f.date_submitted > ?::DATE - to_months(?)
                  -- a firm that filed Form ADV-W on or before the quarter-end
                  -- has withdrawn; its earlier ADV filing no longer represents
                  -- an active registrant (this is what kept snapshot counts
                  -- ~5% above the live compilation universe before the fix)
                  AND NOT EXISTS (
                      SELECT 1 FROM adv_withdrawals w
                      WHERE w.crd = f.crd AND w.filing_date <= ?::DATE
                  )
            ) WHERE rn = 1
            """,
            [end, end, end, SNAPSHOT_STALENESS_MONTHS, end],
        )
        n = con.execute(
            "SELECT count(*) FROM firm_snapshots WHERE snapshot_quarter = ?", [end]
        ).fetchone()[0]
        print(f"snapshot {end}: {n} firms")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["fetch", "load", "snapshots", "run"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    if args.stage in ("fetch", "run"):
        stage_fetch()
    if args.stage in ("load", "snapshots", "run"):
        if not args.db.exists():
            sys.exit(f"error: {args.db} not found — run `python -m etl.ingest_adv` first")
        con = connect(args.db)
        try:
            if args.stage in ("load", "run"):
                stage_load(con)
            if args.stage in ("snapshots", "run"):
                stage_snapshots(con)
        finally:
            con.close()


if __name__ == "__main__":
    main()
