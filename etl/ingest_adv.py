"""Ingest SEC Form ADV bulk compilation data into the firms table.

This is build-order step 1: everything downstream (benchmarking, UI, the
deal-structuring layer) keys off the firm schema produced here.

Input is a monthly IA_ADV_Base compilation file from IAPD
(https://adviserinfo.sec.gov/compilation) — either a CSV or the zip it ships
in. Column headers in these files are the raw Form ADV item numbers
("1E1", "5F(2)(a)", ...) and drift slightly between vintages, so every schema
field maps to a list of candidate headers; the first one present wins and
misses are reported rather than fatal.

Usage:
    python -m etl.ingest_adv --input data/raw/IA_ADV_Base_A_20260601_20260630.zip
    python -m etl.ingest_adv --url https://adviserinfo.sec.gov/.../IA_ADV_Base_A_....zip
    python -m etl.ingest_adv --input file.csv --db data/advisor.duckdb
"""

from __future__ import annotations

import argparse
import io
import re
import sys
import zipfile
from pathlib import Path

import duckdb
import pandas as pd
import requests

from etl.config import DB_PATH, HTTP_HEADERS, RAW_DIR, SCHEMA_PATH

# ---------------------------------------------------------------------------
# Column mapping: schema field -> candidate ADV item headers, most recent
# vintage first. Headers are matched after normalization (uppercased,
# whitespace stripped). Validate against the ADV data dictionary that ships
# alongside each compilation zip when bumping to a new vintage.
# ---------------------------------------------------------------------------
FIRM_COLUMNS: dict[str, list[str]] = {
    "crd": ["1E1", "FIRMCRDNB", "CRDNUMBER"],
    "sec_number": ["1D", "SECNB"],
    "legal_name": ["1A", "FIRMLEGALNAME", "LEGALNAME"],
    "business_name": ["1B1", "1B", "BUSINESSNAME"],
    # Item 5.F(2): regulatory AUM and account counts
    "aum_discretionary": ["5F(2)(A)", "5F2A"],
    "aum_non_discretionary": ["5F(2)(B)", "5F2B"],
    "aum_total": ["5F(2)(C)", "5F2C"],
    "accounts_discretionary": ["5F(2)(D)", "5F2D"],
    "accounts_non_discretionary": ["5F(2)(E)", "5F2E"],
    "accounts_total": ["5F(2)(F)", "5F2F"],
    # Item 5.A/5.B: headcount
    "employees_total": ["5A", "TTLEMPLOYEES"],
    "employees_advisory": ["5B(1)", "5B1"],
    # Item 5.D: client type mix (percentage-range columns)
    "pct_clients_individuals": ["5D(A)(1)", "5D1A"],
    "pct_clients_hnw_individuals": ["5D(A)(2)", "5D1B"],
    "pct_clients_pension_plans": ["5D(A)(6)", "5D1E"],
    "pct_clients_pooled_vehicles": ["5D(A)(7)", "5D1F"],
    "pct_clients_corporations": ["5D(A)(12)", "5D1J"],
    "pct_clients_other": ["5D(A)(14)", "5D1M"],
    # Item 5.E: fee / compensation structure checkboxes
    "fee_pct_of_aum": ["5E(1)", "5E1"],
    "fee_hourly": ["5E(2)", "5E2"],
    "fee_subscription": ["5E(3)", "5E3"],
    "fee_fixed": ["5E(4)", "5E4"],
    "fee_commissions": ["5E(5)", "5E5"],
    "fee_performance_based": ["5E(6)", "5E6"],
    "fee_other": ["5E(7)", "5E7"],
    # Item 7.A: financial-industry affiliations
    "affil_broker_dealer": ["7A(1)", "7A1"],
    "affil_investment_company": ["7A(4)", "7A4"],
    "affil_other_adviser": ["7A(2)", "7A2"],
    "affil_pooled_vehicle_sponsor": ["7A(9)", "7A9"],
}

NUMERIC_FIELDS = {
    "crd",
    "aum_discretionary",
    "aum_non_discretionary",
    "aum_total",
    "accounts_discretionary",
    "accounts_non_discretionary",
    "accounts_total",
    "employees_total",
    "employees_advisory",
}

BOOLEAN_FIELDS = {f for f in FIRM_COLUMNS if f.startswith(("fee_", "affil_"))}

PCT_FIELDS = {f for f in FIRM_COLUMNS if f.startswith("pct_")}

# Item 5.D answers are ranges, not numbers; store the midpoint so the field
# is comparable across firms.
PCT_RANGE_MIDPOINTS = {
    "0": 0.0,
    "NONE": 0.0,
    "1-10%": 5.5,
    "UPTO10%": 5.0,
    "11-25%": 18.0,
    "UPTO25%": 12.5,
    "26-50%": 38.0,
    "UPTO50%": 25.0,
    "51-75%": 63.0,
    "UPTO75%": 37.5,
    "76-99%": 87.5,
    "MORETHAN75%": 87.5,
    "100%": 100.0,
}


def normalize_header(header: str) -> str:
    return re.sub(r"\s+", "", header).upper()


def to_number(value) -> float | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    cleaned = re.sub(r"[$,\s]", "", str(value))
    if cleaned in ("", "-"):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def to_bool(value) -> bool | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip().upper()
    if text in ("Y", "YES", "TRUE", "1"):
        return True
    if text in ("N", "NO", "FALSE", "0", ""):
        return False
    return None


def pct_range_midpoint(value) -> float | None:
    """Map an Item 5.D percentage-range answer to a midpoint, or pass
    through an already-numeric percentage."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    key = re.sub(r"\s+", "", str(value)).upper()
    if key in PCT_RANGE_MIDPOINTS:
        return PCT_RANGE_MIDPOINTS[key]
    return to_number(value)


def read_source(path: Path) -> pd.DataFrame:
    """Read the compilation CSV, transparently unwrapping a zip."""
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not csv_names:
                sys.exit(f"error: no CSV found inside {path}")
            if len(csv_names) > 1:
                print(f"note: multiple CSVs in zip, using {csv_names[0]}")
            with zf.open(csv_names[0]) as fh:
                return pd.read_csv(fh, dtype=str, low_memory=False, encoding_errors="replace")
    return pd.read_csv(path, dtype=str, low_memory=False, encoding_errors="replace")


def download(url: str) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = RAW_DIR / url.rstrip("/").rsplit("/", 1)[-1]
    print(f"downloading {url} -> {dest}")
    resp = requests.get(url, headers=HTTP_HEADERS, timeout=300)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def extract_firms(raw: pd.DataFrame) -> pd.DataFrame:
    """Map raw ADV item columns onto the firms schema."""
    headers = {normalize_header(c): c for c in raw.columns}

    resolved: dict[str, str] = {}
    missing: list[str] = []
    for field, candidates in FIRM_COLUMNS.items():
        for candidate in candidates:
            if candidate in headers:
                resolved[field] = headers[candidate]
                break
        else:
            missing.append(field)

    if "crd" not in resolved or "legal_name" not in resolved:
        sys.exit(
            "error: could not locate firm CRD / legal name columns — "
            f"headers seen: {list(raw.columns)[:20]}..."
        )
    if missing:
        print(f"note: {len(missing)} fields not found in this vintage: {', '.join(missing)}")

    firms = pd.DataFrame()
    for field, source_col in resolved.items():
        col = raw[source_col]
        if field in NUMERIC_FIELDS:
            firms[field] = col.map(to_number)
        elif field in BOOLEAN_FIELDS:
            firms[field] = col.map(to_bool)
        elif field in PCT_FIELDS:
            firms[field] = col.map(pct_range_midpoint)
        else:
            firms[field] = col.str.strip()

    # Item 11: count Y answers across all disciplinary sub-item columns.
    disciplinary_cols = [
        c for norm, c in headers.items() if norm.startswith("11") and norm != "11"
    ]
    if disciplinary_cols:
        firms["disciplinary_flag_count"] = (
            raw[disciplinary_cols]
            .apply(lambda col: col.map(to_bool).fillna(False))
            .sum(axis=1)
            .astype(int)
        )
    else:
        firms["disciplinary_flag_count"] = 0

    affil_fields = [f for f in BOOLEAN_FIELDS if f.startswith("affil_") and f in firms]
    firms["affil_count"] = firms[affil_fields].fillna(False).sum(axis=1).astype(int) if affil_fields else 0

    firms = firms.dropna(subset=["crd", "legal_name"])
    firms["crd"] = firms["crd"].astype("int64")
    # Compilations can contain amended filings; keep the last row per CRD.
    firms = firms.drop_duplicates(subset="crd", keep="last")
    return firms


def load(firms: pd.DataFrame, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    try:
        con.execute(SCHEMA_PATH.read_text())
        con.register("firms_staging", firms)
        # Full refresh: each compilation is a complete snapshot of registered firms.
        con.execute("DELETE FROM firms")
        cols = ", ".join(firms.columns)
        con.execute(f"INSERT INTO firms ({cols}) SELECT {cols} FROM firms_staging")
        count = con.execute("SELECT count(*) FROM firms").fetchone()[0]
        print(f"loaded {count} firms into {db_path}")
    finally:
        con.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="local ADV compilation CSV or zip")
    source.add_argument("--url", help="URL of an ADV compilation zip to download")
    parser.add_argument("--db", type=Path, default=DB_PATH, help=f"DuckDB path (default {DB_PATH})")
    args = parser.parse_args()

    path = args.input if args.input else download(args.url)
    raw = read_source(path)
    print(f"read {len(raw)} rows, {len(raw.columns)} columns from {path.name}")
    firms = extract_firms(raw)
    print(f"normalized {len(firms)} firms")
    load(firms, args.db)


if __name__ == "__main__":
    main()
