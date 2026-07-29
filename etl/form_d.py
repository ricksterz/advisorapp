"""Form D exempt offerings: SEC quarterly structured data sets -> DuckDB.

Source: SEC's Form D data sets, one zip per quarter containing six TSVs
(FORMDSUBMISSION, OFFERING, ISSUERS, RECIPIENTS, RELATEDPERSONS, SIGNATURES)
plus a self-describing FormD_metadata.json. Schema verified against a real
2026Q2 file on 2026-07-28.

    https://www.sec.gov/data-research/sec-markets-data/form-d-data-sets

Unlike every other source in this project, these zips are downloaded MANUALLY
and dropped in data/raw/formd/: www.sec.gov sits behind an Akamai WAF that
403s automated clients (the reports.adviserinfo.sec.gov host used by the ADV
pipelines does not). There is deliberately no fetch stage here — the loader
reads whatever quarterly zips are already on disk, so adding history is just
a matter of dropping more files in and re-running.

THE AMENDMENT TRAP (verified, not theoretical): a D/A amendment restates the
CUMULATIVE amount sold for an ongoing offering rather than reporting new
capital. 2026Q2 has 6,067 amendments among 16,640 offerings; summing
TOTALAMOUNTSOLD across all rows gives $2.97T for the quarter versus $186B
counting new offerings only — 16x inflation. is_amendment is preserved on
every row so downstream aggregation can (and does, see etl/form_d_stats.py)
count new offerings only, and so that choice is auditable rather than
silently baked into the load.

Usage:
    python -m etl.form_d load    # data/raw/formd/*.zip -> form_d_offerings / form_d_recipients
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

import duckdb
import pandas as pd

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import RAW_DIR, SCHEMA_PATH

FORMD_RAW_DIR = RAW_DIR / "formd"

# TSV column -> our column. Names verified against the real 2026Q2 headers.
OFFERING_COLUMNS = {
    "ACCESSIONNUMBER": "accession_number",
    "INDUSTRYGROUPTYPE": "industry_group",
    "INVESTMENTFUNDTYPE": "investment_fund_type",
    "ISPOOLEDINVESTMENTFUNDTYPE": "is_pooled_fund",
    "ISAMENDMENT": "is_amendment",
    "PREVIOUSACCESSIONNUMBER": "previous_accession_number",
    "TOTALOFFERINGAMOUNT": "total_offering_amount",
    "TOTALAMOUNTSOLD": "total_amount_sold",
    "MINIMUMINVESTMENTACCEPTED": "min_investment",
    "HASNONACCREDITEDINVESTORS": "has_non_accredited",
}
OFFERING_NUMERIC = {"total_offering_amount", "total_amount_sold", "min_investment"}
OFFERING_BOOLEAN = {"is_pooled_fund", "is_amendment", "has_non_accredited"}

RECIPIENT_COLUMNS = {
    "ACCESSIONNUMBER": "accession_number",
    "RECIPIENT_SEQ_KEY": "recipient_seq_key",
    "RECIPIENTNAME": "recipient_name",
    "RECIPIENTCRDNUMBER": "recipient_crd",
    "ASSOCIATEDBDNAME": "associated_bd_name",
    "ASSOCIATEDBDCRDNUMBER": "associated_bd_crd",
    "STATEORCOUNTRY": "state",
}
RECIPIENT_NUMERIC = {"recipient_crd", "associated_bd_crd"}

# The TSVs spell missing values as the literal string "None".
NA_VALUES = ["None", ""]


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    return con


def _read_tsv(zf: zipfile.ZipFile, member: str) -> pd.DataFrame | None:
    if member not in zf.namelist():
        return None
    with zf.open(member) as fh:
        return pd.read_csv(fh, sep="\t", dtype=str, na_values=NA_VALUES, low_memory=False)


def _to_bool(v) -> bool | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return str(v).strip().lower() == "true"


def _rename(raw: pd.DataFrame, mapping: dict[str, str], numeric: set[str], boolean: set[str] | None = None) -> pd.DataFrame:
    out = pd.DataFrame()
    for src, dest in mapping.items():
        col = raw[src] if src in raw.columns else pd.Series([None] * len(raw))
        if dest in numeric:
            out[dest] = pd.to_numeric(col, errors="coerce")
        elif boolean and dest in boolean:
            out[dest] = col.map(_to_bool)
        else:
            out[dest] = col.map(lambda v: v.strip() or None if isinstance(v, str) else v)
    return out


def parse_quarter(archive_name: str) -> str | None:
    """2026q2_d.zip -> '2026Q2'. The quarter is only in the filename."""
    m = re.match(r"(\d{4})q([1-4])", archive_name, re.IGNORECASE)
    return f"{m.group(1)}Q{m.group(2)}" if m else None


def parse_archive(zf: zipfile.ZipFile, quarter: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Flatten one quarterly zip into (offerings, recipients).

    Offerings join submission (filing date, type) and the PRIMARY issuer
    (name/state/entity type) onto each offering row — a filing can list
    several co-issuers, but only the primary one identifies the offering.
    """
    prefix = f"{quarter}_d/"
    sub_raw = _read_tsv(zf, f"{prefix}FORMDSUBMISSION.tsv")
    off_raw = _read_tsv(zf, f"{prefix}OFFERING.tsv")
    iss_raw = _read_tsv(zf, f"{prefix}ISSUERS.tsv")
    if sub_raw is None or off_raw is None:
        return pd.DataFrame(), pd.DataFrame()

    offerings = _rename(off_raw, OFFERING_COLUMNS, OFFERING_NUMERIC, OFFERING_BOOLEAN)

    sub = pd.DataFrame(
        {
            "accession_number": sub_raw["ACCESSIONNUMBER"],
            "filing_date": pd.to_datetime(sub_raw["FILING_DATE"], format="%d-%b-%Y", errors="coerce").dt.date,
            "submission_type": sub_raw["SUBMISSIONTYPE"],
        }
    )
    offerings = offerings.merge(sub, on="accession_number", how="left")

    if iss_raw is not None:
        # IS_PRIMARYISSUER_FLAG is spelled YES/NO here, NOT the true/false the
        # OFFERING table's own boolean columns use — an inconsistency within
        # the same data set that silently emptied every issuer field until it
        # was caught by a real-data check.
        flag = iss_raw["IS_PRIMARYISSUER_FLAG"].astype(str).str.strip().str.upper()
        primary = iss_raw[flag.isin(("YES", "TRUE", "Y"))]
        primary = primary.drop_duplicates(subset=["ACCESSIONNUMBER"], keep="first")
        issuers = pd.DataFrame(
            {
                "accession_number": primary["ACCESSIONNUMBER"],
                "issuer_name": primary["ENTITYNAME"],
                "issuer_state": primary["STATEORCOUNTRY"],
                "entity_type": primary["ENTITYTYPE"],
            }
        )
        offerings = offerings.merge(issuers, on="accession_number", how="left")
    else:
        offerings[["issuer_name", "issuer_state", "entity_type"]] = None

    offerings["quarter"] = quarter
    offerings = offerings.dropna(subset=["accession_number"]).drop_duplicates(subset=["accession_number"])

    rec_raw = _read_tsv(zf, f"{prefix}RECIPIENTS.tsv")
    recipients = (
        _rename(rec_raw, RECIPIENT_COLUMNS, RECIPIENT_NUMERIC)
        if rec_raw is not None
        else pd.DataFrame(columns=list(RECIPIENT_COLUMNS.values()))
    )
    return offerings, recipients


def stage_load(con: duckdb.DuckDBPyConnection) -> None:
    """Load every quarterly zip in data/raw/formd/ not already loaded."""
    if not FORMD_RAW_DIR.exists():
        print(f"note: {FORMD_RAW_DIR} does not exist — drop quarterly Form D zips there first")
        return
    loaded = {r[0] for r in con.execute("SELECT DISTINCT source_archive FROM form_d_offerings").fetchall()}

    for path in sorted(FORMD_RAW_DIR.glob("*.zip")):
        if path.name in loaded:
            continue
        quarter = parse_quarter(path.name)
        if quarter is None:
            print(f"note: cannot read a quarter from {path.name} (expected e.g. 2026q2_d.zip), skipping")
            continue
        with zipfile.ZipFile(path) as zf:
            offerings, recipients = parse_archive(zf, quarter)
        if offerings.empty:
            print(f"note: no offerings parsed from {path.name}, skipping")
            continue

        offerings["source_archive"] = path.name
        con.execute("DELETE FROM form_d_offerings WHERE source_archive = ?", [path.name])
        con.register("staging_fd", offerings)
        cols = ", ".join(offerings.columns)
        con.execute(f"INSERT OR REPLACE INTO form_d_offerings ({cols}) SELECT {cols} FROM staging_fd")  # nosec B608
        con.unregister("staging_fd")

        con.execute("DELETE FROM form_d_recipients WHERE source_archive = ?", [path.name])
        if not recipients.empty:
            recipients["source_archive"] = path.name
            con.register("staging_fdr", recipients)
            rcols = ", ".join(recipients.columns)
            con.execute(f"INSERT INTO form_d_recipients ({rcols}) SELECT {rcols} FROM staging_fdr")  # nosec B608
            con.unregister("staging_fdr")

        n_new = int((~offerings["is_amendment"].fillna(False)).sum())
        print(f"loaded {path.name} ({quarter}): {len(offerings)} offerings ({n_new} new, {len(offerings) - n_new} amendments), {len(recipients)} recipients")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["load"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    if not args.db.exists():
        sys.exit(f"error: {args.db} not found — run `python -m etl.ingest_adv` first")
    con = connect(args.db)
    try:
        stage_load(con)
    finally:
        con.close()


if __name__ == "__main__":
    main()
