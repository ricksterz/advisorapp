"""Private funds + named service providers from Form ADV Schedule D 7.B.1.

Reuses the exact monthly advFilingData archives etl/pulse_history.py already
downloads (PULSE_RAW_DIR) — Schedule D 7.B.1 (one row per private fund a
registered adviser manages) and its named sub-item tables live in the SAME
zip as IA_ADV_Base_A, so there is no new download step. Verified against a
real cached archive (2026-07-27):

    IA_Schedule_D_7B1        — fund name/type/domicile/GAV/exclusion/structure
    IA_Schedule_D_7B1A23     — named auditor per fund
    IA_Schedule_D_7B1A24     — named prime broker per fund
    IA_Schedule_D_7B1A25     — named custodian per fund
    IA_Schedule_D_7B1A26     — named administrator per fund
    IA_Schedule_D_7B1A28     — named marketer per fund

The main 7.B.1 table's own Prime Brokers/Custodians/Administrator columns
are just Y/N flags, not identities — the named sub-item tables are the
actual service-provider data. Sub-items join to 7.B.1 rows via
(filing_id, reference_id) — reference_id is only unique within one filing,
unlike fund_id (a stable SEC-assigned identifier across filings).

v1 scope: latest-known state per fund (by fund_id, within the same
staleness window pulse_history uses for firm_snapshots), not a quarterly
time series — matches this project's "ship the core, iterate after" pattern.

Usage:
    python -m etl.private_funds load       # cached archives -> *_filings tables
    python -m etl.private_funds snapshot   # *_filings -> private_funds / private_fund_providers
    python -m etl.private_funds run        # both
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

import duckdb
import pandas as pd

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import SCHEMA_PATH
from etl.ingest_adv import normalize_header, to_bool, to_number
from etl.pulse_history import PULSE_RAW_DIR, SNAPSHOT_STALENESS_MONTHS, _archive_member, _read_member_csv, parse_base_a

FUND_COLUMNS: dict[str, list[str]] = {
    "filing_id": ["FILINGID"],
    "fund_id": ["FUNDID"],
    "reference_id": ["REFERENCEID"],
    "fund_name": ["FUNDNAME"],
    "fund_type": ["FUNDTYPE"],
    "state": ["STATE"],
    "country": ["COUNTRY"],
    "exclusion_3c1": ["3(C)(1)EXCLUSION"],
    "exclusion_3c7": ["3(C)(7)EXCLUSION"],
    "is_master_fund": ["MASTERFUND"],
    "is_feeder_fund": ["FEEDERFUND"],
    "gross_asset_value": ["GROSSASSETVALUE"],
}
FUND_NUMERIC = {"filing_id", "reference_id", "gross_asset_value"}
FUND_BOOLEAN = {"exclusion_3c1", "exclusion_3c7", "is_master_fund", "is_feeder_fund"}

# role -> (archive member regex, column holding the provider's name)
PROVIDER_TABLES: dict[str, tuple[str, str]] = {
    "auditor": (r"IA_Schedule_D_7B1A23_\d{8}_\d{8}\.csv", "Name of Auditing Firm"),
    "prime_broker": (r"IA_Schedule_D_7B1A24_\d{8}_\d{8}\.csv", "Name of Prime Broker"),
    "custodian": (r"IA_Schedule_D_7B1A25_\d{8}_\d{8}\.csv", "Legal Name of Custodian"),
    "administrator": (r"IA_Schedule_D_7B1A26_\d{8}_\d{8}\.csv", "Name of Administrator"),
    "marketer": (r"IA_Schedule_D_7B1A28_\d{8}_\d{8}\.csv", "Name of Marketer"),
}


def _resolve(headers: dict[str, str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in headers:
            return headers[c]
    return None


def parse_7b1(raw: pd.DataFrame) -> pd.DataFrame:
    """Map a raw IA_Schedule_D_7B1 dataframe onto the private-fund columns."""
    headers = {normalize_header(c): c for c in raw.columns}
    out = pd.DataFrame()
    for field, candidates in FUND_COLUMNS.items():
        src = _resolve(headers, candidates)
        col = raw[src] if src is not None else pd.Series([None] * len(raw))
        if field in FUND_NUMERIC:
            out[field] = col.map(to_number)
        elif field in FUND_BOOLEAN:
            out[field] = col.map(to_bool)
        else:
            out[field] = col.map(lambda v: v.strip() or None if isinstance(v, str) else v)
    out = out.dropna(subset=["filing_id", "fund_id"])
    out["filing_id"] = out["filing_id"].astype("int64")
    out["reference_id"] = out["reference_id"].astype("Int64")
    return out


def parse_provider(raw: pd.DataFrame, role: str, name_col: str) -> pd.DataFrame:
    """Map a raw named-provider sub-item dataframe onto a common shape."""
    headers = {normalize_header(c): c for c in raw.columns}
    filing_src = _resolve(headers, ["FILINGID"])
    ref_src = _resolve(headers, ["REFERENCEID"])
    name_src = _resolve(headers, [normalize_header(name_col)])
    if filing_src is None or ref_src is None or name_src is None:
        return pd.DataFrame(columns=["filing_id", "reference_id", "role", "provider_name", "city", "state", "country"])
    out = pd.DataFrame()
    out["filing_id"] = raw[filing_src].map(to_number)
    out["reference_id"] = raw[ref_src].map(to_number)
    out["provider_name"] = raw[name_src].map(lambda v: v.strip() if isinstance(v, str) else v)
    for field, cand in (("city", "CITY"), ("state", "STATE"), ("country", "COUNTRY")):
        src = _resolve(headers, [cand])
        out[field] = raw[src] if src is not None else None
    out["role"] = role
    out = out.dropna(subset=["filing_id", "reference_id", "provider_name"])
    out["filing_id"] = out["filing_id"].astype("int64")
    out["reference_id"] = out["reference_id"].astype("int64")
    return out


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    return con


def stage_load(con: duckdb.DuckDBPyConnection) -> None:
    """Load every not-yet-loaded ADV_Filing_Data archive's private-fund and
    provider tables. Reuses the same cached archives as pulse_history —
    run `python -m etl.pulse_history fetch` first if none are on disk yet.
    """
    loaded = {
        r[0] for r in con.execute("SELECT DISTINCT source_archive FROM private_fund_filings").fetchall()
    }
    for path in sorted(PULSE_RAW_DIR.glob("ADV_Filing_Data_*.zip")):
        if path.name in loaded:
            continue
        with zipfile.ZipFile(path) as zf:
            base_member = _archive_member(zf, r"IA_ADV_Base_A_\d{8}_\d{8}\.csv")
            fund_member = _archive_member(zf, r"IA_Schedule_D_7B1_\d{8}_\d{8}\.csv")
            if not base_member or not fund_member:
                print(f"note: missing base/fund member in {path.name}, skipping")
                continue

            base = parse_base_a(_read_member_csv(zf, base_member))[["filing_id", "crd", "date_submitted"]]
            funds = parse_7b1(_read_member_csv(zf, fund_member))
            funds = funds.merge(base, on="filing_id", how="inner")
            funds["source_archive"] = path.name
            con.execute("DELETE FROM private_fund_filings WHERE source_archive = ?", [path.name])
            con.register("staging_pf", funds)
            cols = ", ".join(funds.columns)
            con.execute(f"INSERT OR REPLACE INTO private_fund_filings ({cols}) SELECT {cols} FROM staging_pf")  # nosec B608
            con.unregister("staging_pf")

            n_providers = 0
            con.execute("DELETE FROM private_fund_provider_filings WHERE source_archive = ?", [path.name])
            for role, (regex, name_col) in PROVIDER_TABLES.items():
                member = _archive_member(zf, regex)
                if not member:
                    continue
                providers = parse_provider(_read_member_csv(zf, member), role, name_col)
                if providers.empty:
                    continue
                providers["source_archive"] = path.name
                con.register("staging_prov", providers)
                cols = ", ".join(providers.columns)
                con.execute(
                    f"INSERT INTO private_fund_provider_filings ({cols}) SELECT {cols} FROM staging_prov"  # nosec B608
                )
                con.unregister("staging_prov")
                n_providers += len(providers)

            print(f"loaded {path.name}: {len(funds)} funds, {n_providers} provider rows")


def stage_snapshot(con: duckdb.DuckDBPyConnection) -> None:
    """Rebuild private_funds / private_fund_providers: for each fund_id, its
    most recent filing across all cached archives, within the same staleness
    window firm_snapshots uses, excluding firms that have since withdrawn.
    """
    latest = con.execute("SELECT max(date_submitted) FROM private_fund_filings").fetchone()[0]
    if latest is None:
        print("no private-fund filings loaded; nothing to snapshot")
        return

    con.execute("DELETE FROM private_funds")
    con.execute(
        """
        INSERT INTO private_funds
        SELECT fund_id, crd, fund_name, fund_type, state, country,
               exclusion_3c1, exclusion_3c7, is_master_fund, is_feeder_fund,
               gross_asset_value, reference_id, filing_id, date_submitted, source_archive
        FROM (
            SELECT f.*, row_number() OVER (
                PARTITION BY f.fund_id ORDER BY f.date_submitted DESC, f.filing_id DESC
            ) AS rn
            FROM private_fund_filings f
            WHERE f.date_submitted > ?::DATE - to_months(?)
              AND NOT EXISTS (
                  SELECT 1 FROM adv_withdrawals w WHERE w.crd = f.crd AND w.filing_date <= ?::DATE
              )
        ) WHERE rn = 1
        """,
        [latest, SNAPSHOT_STALENESS_MONTHS, latest],
    )
    n_funds = con.execute("SELECT count(*) FROM private_funds").fetchone()[0]

    con.execute("DELETE FROM private_fund_providers")
    con.execute(
        """
        INSERT INTO private_fund_providers
        SELECT p.filing_id, p.reference_id, p.role, p.provider_name, p.city, p.state, p.country, p.source_archive
        FROM private_fund_provider_filings p
        INNER JOIN private_funds pf ON pf.filing_id = p.filing_id AND pf.reference_id = p.reference_id
        """
    )
    n_providers = con.execute("SELECT count(*) FROM private_fund_providers").fetchone()[0]
    print(f"snapshot as of {latest}: {n_funds} funds, {n_providers} provider records")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["load", "snapshot", "run"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    if not args.db.exists():
        sys.exit(f"error: {args.db} not found — run `python -m etl.ingest_adv` first")
    con = connect(args.db)
    try:
        if args.stage in ("load", "run"):
            stage_load(con)
        if args.stage in ("snapshot", "run"):
            stage_snapshot(con)
    finally:
        con.close()


if __name__ == "__main__":
    main()
