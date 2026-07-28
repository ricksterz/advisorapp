import json
from datetime import datetime

import duckdb

from etl.config import SCHEMA_PATH
from etl.individual_disclosures_stats import (
    category_breakdown,
    export_individual_disclosure_stats,
)


def _make_db(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    # Naive UTC, matching what stage_load() now stores (see its comment on
    # DuckDB's silent local-timezone reinterpretation of tz-aware datetimes).
    now = datetime(2026, 7, 28)  # noqa: DTZ001 - intentionally naive, mirroring real stored data
    con.execute(
        """
        INSERT INTO individual_disclosures
            (crd, full_name, has_reg_action, has_criminal, has_bankruptcy, has_civil_judicial,
             has_bond, has_judgment, has_investigation, has_customer_complaint, has_termination,
             flag_count, iapd_link, source_archive, fetched_at)
        VALUES
            (1, 'A', false, false, false, false, false, false, false, true, false, 1, 'link1', 'a.zip', ?),
            (2, 'B', false, false, false, false, false, false, false, true, false, 1, 'link2', 'a.zip', ?),
            (3, 'C', true, false, false, false, false, false, false, false, false, 1, 'link3', 'a.zip', ?)
        """,
        [now, now, now],
    )
    con.execute(
        """
        INSERT INTO individual_disclosures_meta (source_archive, total_individuals, flagged_individuals, fetched_at)
        VALUES ('a.zip', 100, 3, ?)
        """,
        [now],
    )
    con.close()
    return db


def test_category_breakdown_ranks_by_count_against_true_total(tmp_path):
    db = _make_db(tmp_path)
    con = duckdb.connect(str(db), read_only=True)
    rows = category_breakdown(con, total_individuals=100)
    con.close()

    top = rows[0]
    assert top == {
        "key": "has_customer_complaint",
        "label": "Customer complaint",
        "count": 2,
        "pct_of_individuals": 0.02,
    }
    reg_action = next(r for r in rows if r["key"] == "has_reg_action")
    assert reg_action["count"] == 1
    zero_rows = [r for r in rows if r["count"] == 0]
    assert len(zero_rows) == 7  # the other 7 categories never appear in this fixture


def test_export_individual_disclosure_stats_writes_full_payload(tmp_path):
    db = _make_db(tmp_path)
    out = tmp_path / "individual_disclosures.json"
    n = export_individual_disclosure_stats(db, out)
    assert n == 3
    payload = json.loads(out.read_text())
    assert payload["total_individuals"] == 100
    assert payload["flagged_individuals"] == 3
    assert payload["flagged_rate"] == 0.03
    assert payload["as_of"] == "2026-07-28"
    assert payload["categories"][0]["key"] == "has_customer_complaint"


def test_export_individual_disclosure_stats_skips_when_no_meta_row(tmp_path):
    db = tmp_path / "empty.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.close()
    out = tmp_path / "individual_disclosures.json"
    out.write_text('{"committed": true}')
    n = export_individual_disclosure_stats(db, out)
    assert n == 0
    assert json.loads(out.read_text()) == {"committed": True}
