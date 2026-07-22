"""Export the firms table to a static JSON file for the GitHub Pages build.

The published site has no backend: the frontend loads this file and filters
client-side. Regulatory data only changes monthly, so a static snapshot is
enough until the FastAPI backend is deployed somewhere.

Usage:
    python -m etl.export_json                       # data/advisor.duckdb -> frontend/public/firms.json
    python -m etl.export_json --db x.duckdb --out firms.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.config import DB_PATH, REPO_ROOT
from etl.individual_disclosures import DRP_ATTRS

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "firms.json"
DEFAULT_FLAGS_OUT = REPO_ROOT / "frontend" / "public" / "deal_flags.json"
DEFAULT_BIOS_OUT = REPO_ROOT / "frontend" / "public" / "advisor_bios.json"

# Keep the payload lean: only the columns the UI actually renders/filters on.
EXPORT_COLUMNS = [
    "crd",
    "legal_name",
    "business_name",
    "state",
    "website_url",
    "aum_total",
    "aum_discretionary",
    "aum_non_discretionary",
    "employees_total",
    "employees_advisory",
    "accounts_total",
    "pct_clients_individuals",
    "pct_clients_hnw_individuals",
    "pct_clients_pension_plans",
    "pct_clients_pooled_vehicles",
    "pct_clients_corporations",
    "pct_clients_other",
    "fee_pct_of_aum",
    "fee_performance_based",
    "fee_commissions",
    "affil_count",
    "disciplinary_flag_count",
]


def export(db_path: Path, out_path: Path) -> int:
    if not db_path.exists():
        sys.exit(f"error: {db_path} not found — run `python -m etl.ingest_adv` first")
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        # column names come from the EXPORT_COLUMNS constant, not external input
        result = con.execute(
            f"SELECT {', '.join(EXPORT_COLUMNS)} FROM firms ORDER BY aum_total DESC NULLS LAST"  # nosec B608
        )
        firms = [dict(zip(EXPORT_COLUMNS, row)) for row in result.fetchall()]
    finally:
        con.close()

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(firms),
        "firms": firms,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported {len(firms)} firms to {out_path}")
    return len(firms)


def export_deal_flags(db_path: Path, out_path: Path) -> int:
    """Per-firm deal-structuring flags + evidence snippets, lazy-loaded by the
    firm detail view.

    The brochure corpus is produced by etl/brochures.py on a workstation (the
    CI deploy has no brochure data), so this file is committed and only
    rewritten when the local database actually has flags — an empty table
    (e.g. the CI ingest) leaves the committed file untouched.
    """
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            rows = con.execute(
                """
                SELECT firm_crd, bool_or(proprietary_funds), bool_or(revenue_sharing),
                       bool_or(affiliated_gp_lp), max(evidence) FILTER (evidence IS NOT NULL)
                FROM deal_structuring GROUP BY firm_crd
                """
            ).fetchall()
        except duckdb.CatalogException:
            rows = []
    finally:
        con.close()
    if not rows:
        print("no deal_structuring data in this database — deal flags export skipped")
        return 0

    flags: dict[str, dict] = {}
    for crd, pf, rs, gp, evidence in rows:
        entry: dict = {"pf": bool(pf), "rs": bool(rs), "gp": bool(gp)}
        if evidence:
            entry["evidence"] = json.loads(evidence)
        flags[str(crd)] = entry
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "firms": flags,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported deal flags for {len(flags)} firms to {out_path}")
    return len(flags)


def export_advisor_bios(db_path: Path, out_path: Path) -> int:
    """Per-firm advisor bios extracted from Form ADV Part 2B brochure
    supplements (etl/advisor_bios.py), lazy-loaded by the firm detail view.

    Same CI-safety pattern as export_deal_flags: the advisors table is only
    ever populated by a workstation run of etl/advisor_bios.py against the
    local brochure text cache (never in CI, which has no brochure corpus), so
    this file is committed and only rewritten when the local database
    actually has rows — an empty/missing table leaves the committed file
    untouched instead of clobbering it with nothing.

    Individual disclosure flags (etl/individual_disclosures.py) are joined in
    by CRD when present, so the frontend needs no second fetch. That table is
    independent of the brochure corpus (a bulk SEC feed, not PDF-derived) and
    may be empty or missing even when advisors has rows — looked up
    separately so a stale/absent individual_disclosures table never blocks
    the bios export itself.
    """
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            rows = con.execute(
                """
                SELECT current_firm_crd, full_name, crd, bio_text, source_version_id, source_name
                FROM advisors
                WHERE current_firm_crd IS NOT NULL
                ORDER BY current_firm_crd, full_name
                """
            ).fetchall()
        except duckdb.CatalogException:
            rows = []
        try:
            disclosure_rows = con.execute(
                f"""
                SELECT crd, {', '.join(DRP_ATTRS)}, flag_count, iapd_link
                FROM individual_disclosures
                """  # nosec B608 - DRP_ATTRS is a fixed module-level constant, not input
            ).fetchall()
        except duckdb.CatalogException:
            disclosure_rows = []
    finally:
        con.close()
    if not rows:
        print("no advisors data in this database — advisor bios export skipped")
        return 0

    disclosures_by_crd = {
        r[0]: {
            "flags": {attr: bool(v) for attr, v in zip(DRP_ATTRS, r[1:-2])},
            "flag_count": r[-2],
            "iapd_link": r[-1],
        }
        for r in disclosure_rows
    }

    firms: dict[str, list[dict]] = {}
    for firm_crd, full_name, crd, bio_text, source_version_id, source_name in rows:
        entry = {
            "name": full_name,
            "crd": crd,
            "bio": bio_text,
            "source_version_id": source_version_id,
            "source_name": source_name,
        }
        if crd in disclosures_by_crd:
            entry["disclosures"] = disclosures_by_crd[crd]
        firms.setdefault(str(firm_crd), []).append(entry)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "firms": firms,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported {len(rows)} advisor bios for {len(firms)} firms to {out_path}")
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--flags-out", type=Path, default=DEFAULT_FLAGS_OUT)
    parser.add_argument("--bios-out", type=Path, default=DEFAULT_BIOS_OUT)
    args = parser.parse_args()
    export(args.db, args.out)
    export_deal_flags(args.db, args.flags_out)
    export_advisor_bios(args.db, args.bios_out)


if __name__ == "__main__":
    main()
