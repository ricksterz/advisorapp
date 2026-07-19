from datetime import date

import duckdb
import pandas as pd

from etl.config import SCHEMA_PATH
from etl.pulse_history import parse_advw, parse_base_a, stage_snapshots
from etl.pulse_stats import COMPLETENESS_THRESHOLD, _delta, published_quarters


def _base_a_frame(rows):
    cols = ["FilingID", "DateSubmitted", "1A", "1E1", "1F1-State", "5F2(C)", "5F2C", "5B1", "5E1", "5E5", "5E6", "11A(1)", "11B(1)"]
    return pd.DataFrame(rows, columns=cols).astype(str)


def test_parse_base_a_maps_real_headers():
    raw = _base_a_frame(
        [
            ["101", "01/15/2026", "ACME LLC", "1001", "NY", "", "1500000000", "12", "Y", "N", "Y", "Y", "N"],
            ["102", "02/01/2026", "BETA INC", "1002", "CA", "", "90000000", "3", "Y", "N", "N", "N", "N"],
        ]
    )
    out = parse_base_a(raw)
    assert len(out) == 2
    acme = out[out.crd == 1001].iloc[0]
    assert acme["aum_total"] == 1_500_000_000
    assert acme["state"] == "NY"
    assert bool(acme["fee_pct_of_aum"]) and bool(acme["fee_performance_based"])
    assert acme["disciplinary_flag_count"] == 1  # one Y across the 11* columns
    assert acme["date_submitted"] == date(2026, 1, 15)


def test_parse_base_a_drops_rows_missing_required_fields():
    raw = _base_a_frame(
        [
            ["101", "01/15/2026", "ACME LLC", "1001", "NY", "", "1", "1", "Y", "N", "N", "N", "N"],
            ["", "01/16/2026", "NO FILING ID", "1002", "CA", "", "1", "1", "Y", "N", "N", "N", "N"],
            ["103", "", "NO DATE", "1003", "TX", "", "1", "1", "Y", "N", "N", "N", "N"],
        ]
    )
    out = parse_base_a(raw)
    assert list(out.crd) == [1001]


def test_parse_advw():
    raw = pd.DataFrame(
        [["A", "2001", "ADV-W", "F", "9001", "1.0", "03/02/2026"]],
        columns=["Primary Business Name", "CRD Number", "Form Type", "Filing Type", "Filing ID", "Form Version", "Filing Date"],
    ).astype(str)
    out = parse_advw(raw)
    assert len(out) == 1
    assert out.iloc[0]["crd"] == 2001
    assert out.iloc[0]["filing_date"] == date(2026, 3, 2)


def _db(tmp_path):
    con = duckdb.connect(str(tmp_path / "t.duckdb"))
    con.execute(SCHEMA_PATH.read_text())
    return con


def _filing(con, fid, crd, submitted, aum):
    con.execute(
        "INSERT INTO adv_filings (filing_id, crd, date_submitted, aum_total, source_archive) VALUES (?, ?, ?, ?, 't')",
        [fid, crd, submitted, aum],
    )


def test_snapshots_take_latest_filing_per_crd_and_exclude_withdrawn(tmp_path):
    con = _db(tmp_path)
    _filing(con, 1, 100, date(2026, 1, 10), 1e9)
    _filing(con, 2, 100, date(2026, 3, 31), 2e9)  # later filing wins
    _filing(con, 3, 200, date(2026, 2, 1), 5e8)
    _filing(con, 4, 300, date(2026, 1, 20), 3e8)
    # firm 300 withdraws before quarter end -> excluded from that quarter on
    con.execute(
        "INSERT INTO adv_withdrawals (filing_id, crd, filing_date, source_archive) VALUES (9, 300, ?, 't')",
        [date(2026, 3, 20)],
    )
    stage_snapshots(con)
    rows = con.execute(
        "SELECT crd, aum_total FROM firm_snapshots WHERE snapshot_quarter = DATE '2026-03-31' ORDER BY crd"
    ).fetchall()
    assert rows == [(100, 2e9), (200, 5e8)]


def test_snapshots_staleness_window_ages_firms_out(tmp_path):
    con = _db(tmp_path)
    _filing(con, 1, 100, date(2025, 1, 10), 1e9)  # never files again
    _filing(con, 2, 200, date(2026, 6, 30), 5e8)
    stage_snapshots(con)
    q = con.execute(
        "SELECT list(crd ORDER BY crd) FROM firm_snapshots WHERE snapshot_quarter = DATE '2026-06-30'"
    ).fetchone()[0]
    # firm 100's only filing is >15 months before 2026-06-30 -> aged out
    assert q == [200]
    q1 = con.execute(
        "SELECT list(crd ORDER BY crd) FROM firm_snapshots WHERE snapshot_quarter = DATE '2025-03-31'"
    ).fetchone()[0]
    assert q1 == [100]


def test_published_quarters_gates_incomplete_early_quarters(tmp_path):
    con = _db(tmp_path)
    # latest quarter: 100 firms; early quarter: far fewer -> gated out
    for crd in range(100):
        _filing(con, 1000 + crd, crd, date(2026, 6, 30), 1e8)
    for crd in range(50):
        _filing(con, 2000 + crd, crd, date(2025, 6, 30), 1e8)
    stage_snapshots(con)
    quarters = published_quarters(con)
    assert "2026-06-30" in quarters
    assert "2025-06-30" not in quarters  # 50/100 < threshold
    # sanity on the threshold itself
    assert 0.9 <= COMPLETENESS_THRESHOLD < 1.0


def test_delta():
    assert _delta(110, 100) == 0.10
    assert _delta(None, 100) is None
    assert _delta(100, 0) is None
    assert _delta(100, None) is None
