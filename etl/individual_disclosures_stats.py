"""Individual-level disclosure aggregation: individual_disclosures +
individual_disclosures_meta -> frontend/public/individual_disclosures.json.

Same "flag it, link out, don't editorialize" reasoning as everywhere else
disclosure data appears in this project: category counts only, no
narrative/date/dollar detail (the bulk feed doesn't carry any), and every
number here is a share of DISCLOSURE CATEGORIES flagged, not a count of
distinct events or a finding of wrongdoing.

total_individuals/flagged_individuals come from individual_disclosures_meta
(captured by etl/individual_disclosures.py at load time) rather than being
recomputed here — the flagged rate needs the TRUE total across the whole
~436K-person feed, not just the ~60K rows kept in individual_disclosures.

Usage:
    python -m etl.individual_disclosures_stats --db data/advisor.duckdb \
        --out frontend/public/individual_disclosures.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import REPO_ROOT
from etl.individual_disclosures import DRP_ATTRS

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "individual_disclosures.json"

# Same labels as frontend/src/advisorBios.js's DISCLOSURE_FLAG_DEFS — kept as
# a separate registry per this project's convention (each layer's copy lives
# in its own language, e.g. PULSE_META vs pulse_stats.py's methodology text).
CATEGORY_LABELS = {
    "has_customer_complaint": "Customer complaint",
    "has_criminal": "Criminal",
    "has_bankruptcy": "Bankruptcy",
    "has_termination": "Termination",
    "has_reg_action": "Regulatory action",
    "has_judgment": "Judgment",
    "has_civil_judicial": "Civil judicial",
    "has_investigation": "Investigation",
    "has_bond": "Bond",
}


def category_breakdown(con: duckdb.DuckDBPyConnection, total_individuals: int) -> list[dict]:
    rows = []
    for col in DRP_ATTRS:
        n = con.execute(f"SELECT count(*) FROM individual_disclosures WHERE {col}").fetchone()[0]  # nosec B608 - col is a fixed module-level key, not input
        rows.append(
            {
                "key": col,
                "label": CATEGORY_LABELS[col],
                "count": n,
                "pct_of_individuals": n / total_individuals if total_individuals else None,
            }
        )
    rows.sort(key=lambda r: r["count"], reverse=True)
    return rows


def export_individual_disclosure_stats(db_path: Path, out_path: Path) -> int:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            meta = con.execute(
                "SELECT total_individuals, flagged_individuals, fetched_at FROM individual_disclosures_meta"
            ).fetchone()
        except duckdb.CatalogException:
            meta = None
        if meta is None:
            print("no individual_disclosures_meta row in this database — individual disclosure stats export skipped")
            return 0

        total_individuals, flagged_individuals, fetched_at = meta
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "as_of": fetched_at.date().isoformat(),
            "total_individuals": total_individuals,
            "flagged_individuals": flagged_individuals,
            "flagged_rate": flagged_individuals / total_individuals if total_individuals else None,
            "categories": category_breakdown(con, total_individuals),
        }
    finally:
        con.close()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported individual disclosure stats ({flagged_individuals}/{total_individuals} flagged) to {out_path}")
    return flagged_individuals


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if not args.db.exists():
        sys.exit(f"error: {args.db} not found")
    export_individual_disclosure_stats(args.db, args.out)


if __name__ == "__main__":
    main()
