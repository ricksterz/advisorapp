"""Form D aggregation: form_d_offerings -> frontend/public/form_d.json.

EVERY aggregate here counts NEW offerings only (is_amendment = false). A D/A
amendment restates the cumulative amount sold for an ongoing offering rather
than reporting new capital, so including amendments counts the same dollars
once per amendment: $2.97T vs $186B for 2026Q2, a 16x inflation. This is the
same family of trap as aggregate RAUM (PR #19) and master/feeder fund GAV
(PR #49), and it's handled the same way — exclude the double-count at the
source and say so in the methodology copy rather than publishing a big
number with a footnote.

Reported amounts are also self-reported and lumpy: the largest single 2026Q2
offering was ~$31B and the top 10 were ~8% of the quarter's total, so counts
and medians carry more signal than the sum. The frontend leads with the
offering COUNT and shows median alongside any total.

Usage:
    python -m etl.form_d_stats --db data/advisor.duckdb \
        --out frontend/public/form_d.json
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
from etl.private_fund_stats import _normalize_provider
from etl.pulse_stats import _delta

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "form_d.json"

TOP_N_INDUSTRIES = 10
TOP_N_STATES = 10
TOP_N_AGENTS = 10

# Every aggregate in this module filters on this. Kept as one constant so the
# choice can't drift between queries.
NEW_ONLY = "is_amendment IS NOT TRUE"

# ~28% of new offerings report $0 sold: a fund routinely files Form D when the
# offering opens, before anything is raised. Including those zeros drags a
# "median raised" to $0 for whole categories (57% of 2026Q2 private-equity
# offerings had raised nothing yet), which reads as broken rather than
# informative — so medians are taken over offerings that have actually raised
# something, and the not-yet-raised count is reported alongside instead of
# being silently folded in.
RAISED_ONLY = "total_amount_sold > 0"


def quarter_series(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT quarter, count(*), sum(total_amount_sold),
               median(total_amount_sold) FILTER ({RAISED_ONLY}),
               count(*) FILTER (is_pooled_fund),
               count(*) FILTER (total_amount_sold = 0)
        FROM form_d_offerings WHERE {NEW_ONLY}
        GROUP BY 1 ORDER BY 1
        """  # nosec B608 - NEW_ONLY is a module constant
    ).fetchall()
    return [
        {
            "quarter": q,
            "offerings": n,
            "raised": raised,
            "median_raised": med,
            "pooled_fund_offerings": pooled,
            "not_yet_raised": not_raised,
        }
        for q, n, raised, med, pooled, not_raised in rows
    ]


def fund_type_breakdown(con: duckdb.DuckDBPyConnection, quarter: str) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT investment_fund_type, count(*), sum(total_amount_sold),
               median(total_amount_sold) FILTER ({RAISED_ONLY})
        FROM form_d_offerings
        WHERE {NEW_ONLY} AND quarter = ? AND is_pooled_fund AND investment_fund_type IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC
        """,  # nosec B608 - NEW_ONLY is a module constant
        [quarter],
    ).fetchall()
    return [{"type": t, "offerings": n, "raised": raised, "median_raised": med} for t, n, raised, med in rows]


def industry_breakdown(con: duckdb.DuckDBPyConnection, quarter: str, top_n: int = TOP_N_INDUSTRIES) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT industry_group, count(*), sum(total_amount_sold)
        FROM form_d_offerings
        WHERE {NEW_ONLY} AND quarter = ? AND industry_group IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT ?
        """,  # nosec B608 - NEW_ONLY is a module constant
        [quarter, top_n],
    ).fetchall()
    return [{"industry": i, "offerings": n, "raised": raised} for i, n, raised in rows]


def state_breakdown(con: duckdb.DuckDBPyConnection, quarter: str, top_n: int = TOP_N_STATES) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT issuer_state, count(*)
        FROM form_d_offerings
        WHERE {NEW_ONLY} AND quarter = ? AND issuer_state IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT ?
        """,  # nosec B608 - NEW_ONLY is a module constant
        [quarter, top_n],
    ).fetchall()
    return [{"state": s, "offerings": n} for s, n in rows]


def placement_agents(con: duckdb.DuckDBPyConnection, quarter: str, top_n: int = TOP_N_AGENTS) -> list[dict]:
    """Brokers most often named as offering recipients. Aggregate only — a
    2026Q2 check matched just 137 of ~17K tracked advisers, since recipients
    are overwhelmingly broker-dealers rather than the RIAs this site covers.
    """
    rows = con.execute(
        f"""
        SELECT r.recipient_name, r.recipient_crd, count(DISTINCT r.accession_number)
        FROM form_d_recipients r
        JOIN form_d_offerings o ON o.accession_number = r.accession_number
        WHERE {NEW_ONLY} AND o.quarter = ? AND r.recipient_name IS NOT NULL
        GROUP BY 1, 2
        """,  # nosec B608 - NEW_ONLY is a module constant
        [quarter],
    ).fetchall()

    # The same broker is spelled inconsistently across filings ("AQR
    # INVESTMENTS, LLC" vs "AQR Investments, LLC" split one firm across two
    # entries in a real 2026Q2 run), so group on the normalized name — the
    # same suffix/case folding the private-fund provider league tables use.
    # Display keeps the most common raw spelling rather than the normalized
    # upper-case form, which reads better and stays faithful to a real filing.
    grouped: dict[str, dict] = {}
    for name, crd, count in rows:
        key = _normalize_provider(name)
        entry = grouped.setdefault(key, {"offerings": 0, "crd": None, "spellings": {}})
        entry["offerings"] += count
        entry["spellings"][name] = entry["spellings"].get(name, 0) + count
        if entry["crd"] is None and crd is not None:
            entry["crd"] = crd

    ranked = sorted(grouped.values(), key=lambda e: e["offerings"], reverse=True)[:top_n]
    return [
        {
            "name": max(e["spellings"].items(), key=lambda kv: kv[1])[0],
            "crd": e["crd"],
            "offerings": e["offerings"],
        }
        for e in ranked
    ]


def _kpi(series: list[dict], key: str) -> dict:
    curr = series[-1][key] if series else None
    prev_q = series[-2][key] if len(series) >= 2 else None
    prev_y = series[-5][key] if len(series) >= 5 else None
    return {"value": curr, "qoq": _delta(curr, prev_q), "yoy": _delta(curr, prev_y)}


def export_form_d_stats(db_path: Path, out_path: Path) -> int:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            series = quarter_series(con)
        except duckdb.CatalogException:
            series = []
        if not series:
            print("no Form D data in this database — form D stats export skipped")
            return 0

        latest = series[-1]["quarter"]
        n_amendments = con.execute(
            "SELECT count(*) FROM form_d_offerings WHERE quarter = ? AND is_amendment", [latest]
        ).fetchone()[0]

        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "as_of": latest,
            "quarters": [s["quarter"] for s in series],
            "series": series,
            "offerings_kpi": _kpi(series, "offerings"),
            "raised_kpi": _kpi(series, "raised"),
            "amendments_excluded": n_amendments,
            "fund_types": fund_type_breakdown(con, latest),
            "industries": industry_breakdown(con, latest),
            "states": state_breakdown(con, latest),
            "placement_agents": placement_agents(con, latest),
        }
    finally:
        con.close()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported Form D stats for {len(series)} quarter(s), latest {latest}, to {out_path}")
    return len(series)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if not args.db.exists():
        sys.exit(f"error: {args.db} not found")
    export_form_d_stats(args.db, args.out)


if __name__ == "__main__":
    main()
