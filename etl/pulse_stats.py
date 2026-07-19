"""Industry Pulse aggregation: firm_snapshots + adv_withdrawals ->
frontend/public/pulse_stats.json.

All heavy computation happens here at refresh time (see
docs/industry-pulse-plan.md section 1 — static-first, no client-side
aggregation at scale, no Worker compute). The frontend renders numbers and
deltas as given.

Publishing gate: quarters below COMPLETENESS_THRESHOLD vs. the newest
quarter's firm count are computed but NOT published — early quarters of the
available archive window are structurally under-observed (see
etl/pulse_history.py's module docstring), and a partially-observed universe
presented as a real quarter would fabricate a growth trend that is actually
just archive coverage improving.

Usage:
    python -m etl.pulse_stats --db data/advisor.duckdb \
        --out frontend/public/pulse_stats.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.config import REPO_ROOT
from etl.config import DB_PATH as DEFAULT_DB

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "pulse_stats.json"

# Calibration note: completeness is measured against the LATEST quarter's
# count, but the registrant universe genuinely grows (~1.5-2%/quarter, ~500
# net appearances/quarter measured on real data), so an old quarter reads a
# couple of points "incomplete" purely from real growth. 0.93 admits the
# first quarter after a full annual filing season (2025Q2, measured 94.4% of
# latest) while still excluding genuinely under-observed quarters (2025Q1,
# measured 89% — the archive window only opens Jan 2025, so Q1 misses every
# firm whose annual amendment predates it).
COMPLETENESS_THRESHOLD = 0.93

# Same four bands as the deal-structuring patterns view (frontend
# dealPatterns.js) — cut points $100M / $1B / $10B.
BANDS = [
    ("lt100m", "Under $100M", 0, 1e8),
    ("100m-1b", "$100M–$1B", 1e8, 1e9),
    ("1b-10b", "$1B–$10B", 1e9, 1e10),
    ("10b+", "$10B+", 1e10, float("inf")),
]

BAND_CASE = (
    "CASE WHEN coalesce(aum_total,0) >= 1e10 THEN '10b+' "
    "WHEN coalesce(aum_total,0) >= 1e9 THEN '1b-10b' "
    "WHEN coalesce(aum_total,0) >= 1e8 THEN '100m-1b' ELSE 'lt100m' END"
)


def _delta(curr: float | None, prev: float | None) -> float | None:
    """Fractional change, None when either side is missing/zero."""
    if curr is None or prev in (None, 0):
        return None
    return (curr - prev) / prev


def published_quarters(con: duckdb.DuckDBPyConnection) -> list[str]:
    rows = con.execute(
        "SELECT snapshot_quarter, count(*) FROM firm_snapshots GROUP BY 1 ORDER BY 1"
    ).fetchall()
    if not rows:
        return []
    latest_count = rows[-1][1]
    return [str(q) for q, n in rows if n >= COMPLETENESS_THRESHOLD * latest_count]


def quarter_series(con: duckdb.DuckDBPyConnection, quarters: list[str]) -> list[dict]:
    """Per published quarter: headline aggregates + per-band breakdown."""
    series = []
    for q in quarters:
        head = con.execute(
            """
            SELECT count(*),
                   sum(aum_total),
                   median(aum_total),
                   count(*) FILTER (disciplinary_flag_count > 0)
            FROM firm_snapshots WHERE snapshot_quarter = ?
            """,
            [q],
        ).fetchone()
        bands_rows = con.execute(
            f"SELECT {BAND_CASE} AS band, count(*), sum(aum_total), median(aum_total) "  # nosec B608 — BAND_CASE is a module constant
            "FROM firm_snapshots WHERE snapshot_quarter = ? GROUP BY 1",
            [q],
        ).fetchall()
        by_band = {b: {"firms": n, "raum": s, "median_aum": m} for b, n, s, m in bands_rows}
        withdrawals = con.execute(
            """
            SELECT count(*) FROM adv_withdrawals
            WHERE filing_date <= ?::DATE AND filing_date > ?::DATE - to_months(3)
            """,
            [q, q],
        ).fetchone()[0]
        series.append(
            {
                "quarter": q,
                "firms": head[0],
                "raum": head[1],
                "median_aum": head[2],
                "pct_disclosure": head[3] / head[0] if head[0] else None,
                "withdrawals": withdrawals,
                "bands": [
                    {
                        "id": bid,
                        "label": label,
                        **by_band.get(bid, {"firms": 0, "raum": 0, "median_aum": None}),
                    }
                    for bid, label, _, _ in BANDS
                ],
            }
        )
    return series


def add_appearances(con: duckdb.DuckDBPyConnection, series: list[dict]) -> None:
    """CRDs appearing/disappearing between consecutive PUBLISHED quarters.

    'Appeared' is a new-registrant proxy (first time this CRD clears the
    snapshot for a published quarter); 'disappeared' complements the
    authoritative ADV-W withdrawal count (a firm can go stale without formally
    filing ADV-W in the same quarter). Both are labeled as derived measures in
    the frontend methodology copy, distinct from the ADV-W count.
    """
    for i, cur in enumerate(series):
        if i == 0:
            cur["appeared"] = None
            cur["disappeared"] = None
            continue
        prev_q, cur_q = series[i - 1]["quarter"], cur["quarter"]
        appeared, disappeared = con.execute(
            """
            SELECT
              (SELECT count(*) FROM firm_snapshots c WHERE c.snapshot_quarter = ?::DATE
                 AND NOT EXISTS (SELECT 1 FROM firm_snapshots p
                                 WHERE p.snapshot_quarter = ?::DATE AND p.crd = c.crd)),
              (SELECT count(*) FROM firm_snapshots p WHERE p.snapshot_quarter = ?::DATE
                 AND NOT EXISTS (SELECT 1 FROM firm_snapshots c
                                 WHERE c.snapshot_quarter = ?::DATE AND c.crd = p.crd))
            """,
            [cur_q, prev_q, prev_q, cur_q],
        ).fetchone()
        cur["appeared"] = appeared
        cur["disappeared"] = disappeared


def state_series(con: duckdb.DuckDBPyConnection, quarters: list[str], top_n: int = 12) -> list[dict]:
    latest = quarters[-1]
    top_states = [
        r[0]
        for r in con.execute(
            """
            SELECT state FROM firm_snapshots
            WHERE snapshot_quarter = ? AND state IS NOT NULL AND state != '' AND state != 'None'
            GROUP BY 1 ORDER BY count(*) DESC LIMIT ?
            """,
            [latest, top_n],
        ).fetchall()
    ]
    out = []
    for st in top_states:
        counts = {
            str(q): n
            for q, n in con.execute(
                "SELECT snapshot_quarter, count(*) FROM firm_snapshots WHERE state = ? GROUP BY 1",
                [st],
            ).fetchall()
        }
        qcounts = [counts.get(q) for q in quarters]
        out.append({"state": st, "firms": qcounts[-1], "series": qcounts})
    return out


def band_migration(con: duckdb.DuckDBPyConnection, quarters: list[str]) -> dict | None:
    """YoY AUM-band transition matrix (same CRD, band a year ago vs now)."""
    if len(quarters) < 5:
        pairs = (quarters[0], quarters[-1]) if len(quarters) >= 2 else None
    else:
        pairs = (quarters[-5], quarters[-1])
    if not pairs:
        return None
    frm, to = pairs
    rows = con.execute(
        f"""
        SELECT {BAND_CASE.replace('aum_total', 'p.aum_total')} AS from_band,
               {BAND_CASE.replace('aum_total', 'c.aum_total')} AS to_band,
               count(*)
        FROM firm_snapshots p
        JOIN firm_snapshots c ON c.crd = p.crd AND c.snapshot_quarter = ?::DATE
        WHERE p.snapshot_quarter = ?::DATE
        GROUP BY 1, 2
        """,  # nosec B608 — BAND_CASE is a module constant
        [to, frm],
    ).fetchall()
    matrix: dict[str, dict[str, int]] = {}
    for f, t, n in rows:
        matrix.setdefault(f, {})[t] = n
    return {"from_quarter": frm, "to_quarter": to, "matrix": matrix}


def _kpi(series: list[dict], key: str) -> dict:
    curr = series[-1][key]
    prev_q = series[-2][key] if len(series) >= 2 else None
    prev_y = series[-5][key] if len(series) >= 5 else None
    return {"value": curr, "qoq": _delta(curr, prev_q), "yoy": _delta(curr, prev_y)}


def export_pulse_stats(db_path: Path, out_path: Path) -> int:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            quarters = published_quarters(con)
        except duckdb.CatalogException:
            quarters = []
        if len(quarters) < 2:
            # CI's fresh-ingest database has no snapshot history; leave the
            # committed file untouched (same safety pattern as
            # export_deal_flags / export_advisor_bios).
            print("no publishable snapshot history in this database — pulse stats export skipped")
            return 0

        series = quarter_series(con, quarters)
        add_appearances(con, series)
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "as_of": quarters[-1],
            "quarters": quarters,
            "completeness_threshold": COMPLETENESS_THRESHOLD,
            "kpis": {
                "firms": _kpi(series, "firms"),
                "raum": _kpi(series, "raum"),
                "median_aum": _kpi(series, "median_aum"),
                "pct_disclosure": _kpi(series, "pct_disclosure"),
                "median_aum_by_band": {
                    b["id"]: b["median_aum"] for b in series[-1]["bands"]
                },
            },
            "series": series,
            "states": state_series(con, quarters),
            "band_migration": band_migration(con, quarters),
        }
    finally:
        con.close()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported pulse stats for {len(quarters)} quarters to {out_path}")
    return len(quarters)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if not args.db.exists():
        sys.exit(f"error: {args.db} not found")
    export_pulse_stats(args.db, args.out)


if __name__ == "__main__":
    main()
