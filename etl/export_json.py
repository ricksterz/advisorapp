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

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "firms.json"

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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    export(args.db, args.out)


if __name__ == "__main__":
    main()
