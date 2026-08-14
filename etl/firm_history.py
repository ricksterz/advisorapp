"""Per-firm trajectory across published Pulse quarters.

pulse_stats.py already reconstructs firm_snapshots into quarterly industry
aggregates (median AUM, concentration, etc.) and then discards the per-firm
rows. This exports those same rows, unaggregated, keyed by CRD, so a firm's
own detail page can show its AUM/headcount/disciplinary trend instead of only
a single current-quarter snapshot -- no new data source, no new crawl.

Same published-quarter gate as every other Pulse-derived export
(published_quarters in pulse_stats.py): a quarter only appears once its
reconstructed universe reaches the completeness threshold, so an
early-archive-window artifact can't be read as a real move.

One methodology note worth carrying into any UI built on this: real data
(2026-08-14 pull) shows employees_advisory swinging by more than 80% at
several dozen firms specifically between 2025-12-31 and 2026-03-31, well
above the rate at any other quarter boundary -- consistent with an ADV Item
5.B reporting-basis change that quarter rather than mass layoffs/hiring
across unrelated firms. A UI surfacing this series should say so rather than
label every swing an event.

Usage:
    python -m etl.firm_history --db data/advisor.duckdb \
        --out frontend/public/firm_history.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.pulse_stats import published_quarters

FIELDS = ("aum_total", "aum_discretionary", "employees_advisory", "disciplinary_flag_count")


def build_history(con: duckdb.DuckDBPyConnection) -> dict | None:
    quarters = published_quarters(con)
    if not quarters:
        return None

    # placeholders is a fixed-count run of "?" — no external input reaches the
    # query string; the actual quarter values are bound below as parameters.
    placeholders = ",".join(["?"] * len(quarters))
    rows = con.execute(
        f"""
        SELECT crd, snapshot_quarter, aum_total, aum_discretionary,
               employees_advisory, disciplinary_flag_count
        FROM firm_snapshots
        WHERE snapshot_quarter IN ({placeholders})
        """,  # nosec B608 — placeholders is "?" repeated, not interpolated data
        quarters,
    ).fetchall()
    if not rows:
        return None

    q_index = {q: i for i, q in enumerate(quarters)}
    n = len(quarters)
    by_crd: dict[str, dict[str, list]] = {}
    for crd, q, aum_total, aum_disc, employees, disc_count in rows:
        entry = by_crd.setdefault(
            str(crd), {f: [None] * n for f in FIELDS}
        )
        i = q_index[str(q)]
        entry["aum_total"][i] = aum_total
        entry["aum_discretionary"][i] = aum_disc
        entry["employees_advisory"][i] = employees
        entry["disciplinary_flag_count"][i] = disc_count

    return {"quarters": quarters, "firms": by_crd}


def export_firm_history(db_path: Path, out_path: Path) -> bool:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        payload = build_history(con)
    finally:
        con.close()

    # CI's fresh-ingest DB has no snapshot history — skip rather than
    # overwrite the committed file, same guard every export_* uses.
    if payload is None:
        print(f"no firm-snapshot history in {db_path}; leaving {out_path} untouched")
        return False

    payload["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(
        f"wrote {out_path} ({len(payload['firms']):,} firms across "
        f"{len(payload['quarters'])} quarters)"
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    export_firm_history(args.db, args.out)


if __name__ == "__main__":
    main()
