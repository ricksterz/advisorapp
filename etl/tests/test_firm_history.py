"""Tests for the per-firm trajectory export."""

from __future__ import annotations

import json

import duckdb

from etl.firm_history import build_history, export_firm_history


def _db(tmp_path, snapshot_rows):
    path = tmp_path / "t.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        "CREATE TABLE firm_snapshots (snapshot_quarter DATE, crd BIGINT, "
        "aum_total DOUBLE, aum_discretionary DOUBLE, employees_advisory BIGINT, "
        "state VARCHAR, fee_pct_of_aum BOOLEAN, fee_performance_based BOOLEAN, "
        "fee_commissions BOOLEAN, disciplinary_flag_count INTEGER)"
    )
    if snapshot_rows:
        con.executemany(
            "INSERT INTO firm_snapshots "
            "(snapshot_quarter, crd, aum_total, aum_discretionary, "
            " employees_advisory, disciplinary_flag_count) VALUES (?,?,?,?,?,?)",
            snapshot_rows,
        )
    con.close()
    return path


# Enough firms present in both quarters clears published_quarters' 93%
# completeness gate; a lone early quarter below that must not appear.
FULL = [(i, "2025-06-30") for i in range(1000, 1100)] + [
    (i, "2025-09-30") for i in range(1000, 1100)
]


def test_build_history_aligns_values_to_the_quarters_array(tmp_path):
    rows = [
        ("2025-06-30", 1, 1_000.0, 900.0, 10, 0),
        ("2025-09-30", 1, 1_100.0, 950.0, 11, 1),
    ] + [(q, crd, 1.0, 1.0, 1, 0) for crd, q in FULL if crd != 1]
    db = _db(tmp_path, rows)
    con = duckdb.connect(str(db), read_only=True)
    payload = build_history(con)
    con.close()

    assert payload["quarters"] == ["2025-06-30", "2025-09-30"]
    entry = payload["firms"]["1"]
    assert entry["aum_total"] == [1_000.0, 1_100.0]
    assert entry["employees_advisory"] == [10, 11]
    assert entry["disciplinary_flag_count"] == [0, 1]


def test_a_firm_missing_from_one_quarter_gets_a_null_not_a_shift(tmp_path):
    # Firm 2 has no row in the first quarter — the value at that index must be
    # None, not silently dropped (which would misalign it against the other
    # firms' series when a chart zips values to quarters positionally).
    rows = [("2025-09-30", 2, 500.0, 400.0, 5, 0)] + [
        (q, crd, 1.0, 1.0, 1, 0) for crd, q in FULL
    ]
    db = _db(tmp_path, rows)
    con = duckdb.connect(str(db), read_only=True)
    payload = build_history(con)
    con.close()

    entry = payload["firms"]["2"]
    assert entry["aum_total"] == [None, 500.0]


def test_build_history_returns_none_when_snapshots_table_is_empty(tmp_path):
    db = _db(tmp_path, [])
    con = duckdb.connect(str(db), read_only=True)
    assert build_history(con) is None
    con.close()


def test_export_skips_and_preserves_the_committed_file_when_empty(tmp_path):
    db = _db(tmp_path, [])
    out = tmp_path / "firm_history.json"
    out.write_text('{"sentinel": true}')
    assert export_firm_history(db, out) is False
    assert json.loads(out.read_text()) == {"sentinel": True}


def test_export_writes_generated_at_and_real_payload(tmp_path):
    rows = [(q, crd, 1.0, 1.0, 1, 0) for crd, q in FULL]
    db = _db(tmp_path, rows)
    out = tmp_path / "firm_history.json"
    assert export_firm_history(db, out) is True
    payload = json.loads(out.read_text())
    assert "generated_at" in payload
    assert payload["quarters"] == ["2025-06-30", "2025-09-30"]
    assert len(payload["firms"]) == 100
