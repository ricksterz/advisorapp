import json
from datetime import date

import duckdb

from etl.config import SCHEMA_PATH
from etl.form_d_stats import (
    export_form_d_stats,
    fund_type_breakdown,
    placement_agents,
    quarter_series,
)


def _offering(con, acc, quarter, sold, *, amendment=False, fund_type="Venture Capital Fund", state="NY", industry="Pooled Investment Fund"):
    con.execute(
        """
        INSERT INTO form_d_offerings
            (accession_number, filing_date, quarter, submission_type, is_amendment,
             industry_group, investment_fund_type, is_pooled_fund, total_amount_sold,
             issuer_state, source_archive)
        VALUES (?, ?, ?, ?, ?, ?, ?, true, ?, ?, 'a.zip')
        """,
        [acc, date(2026, 6, 30), quarter, "D/A" if amendment else "D", amendment, industry, fund_type, sold, state],
    )


def _make_db(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    _offering(con, "a1", "2026Q1", 1_000_000)
    _offering(con, "a2", "2026Q2", 3_000_000)
    _offering(con, "a3", "2026Q2", 5_000_000, fund_type="Hedge Fund", state="CA")
    # An amendment restating a huge cumulative total — must never be counted.
    _offering(con, "a4", "2026Q2", 900_000_000, amendment=True)
    con.execute(
        """
        INSERT INTO form_d_recipients
            (accession_number, recipient_seq_key, recipient_name, recipient_crd, source_archive)
        VALUES ('a2', '1', 'Goldman Sachs & Co. LLC', 361, 'a.zip'),
               ('a3', '1', 'Goldman Sachs & Co. LLC', 361, 'a.zip'),
               ('a4', '1', 'Should Not Count LLC', 999, 'a.zip')
        """
    )
    con.close()
    return db


def test_quarter_series_excludes_amendments(tmp_path):
    con = duckdb.connect(str(_make_db(tmp_path)), read_only=True)
    series = quarter_series(con)
    con.close()
    assert [s["quarter"] for s in series] == ["2026Q1", "2026Q2"]
    q2 = series[-1]
    # 3M + 5M only; the 900M amendment is excluded entirely.
    assert q2["offerings"] == 2
    assert q2["raised"] == 8_000_000
    assert q2["median_raised"] == 4_000_000


def test_fund_type_breakdown_excludes_amendments(tmp_path):
    con = duckdb.connect(str(_make_db(tmp_path)), read_only=True)
    types = fund_type_breakdown(con, "2026Q2")
    con.close()
    by_name = {t["type"]: t for t in types}
    assert by_name["Venture Capital Fund"]["offerings"] == 1  # the amendment is also VC, not counted
    assert by_name["Hedge Fund"]["raised"] == 5_000_000


def test_placement_agents_ranked_and_exclude_amendment_offerings(tmp_path):
    con = duckdb.connect(str(_make_db(tmp_path)), read_only=True)
    agents = placement_agents(con, "2026Q2")
    con.close()
    assert agents[0] == {"name": "Goldman Sachs & Co. LLC", "crd": 361, "offerings": 2}
    assert all(a["name"] != "Should Not Count LLC" for a in agents)


def test_export_writes_payload_with_amendment_count(tmp_path):
    out = tmp_path / "form_d.json"
    n = export_form_d_stats(_make_db(tmp_path), out)
    assert n == 2  # two quarters
    payload = json.loads(out.read_text())
    assert payload["as_of"] == "2026Q2"
    assert payload["amendments_excluded"] == 1
    assert payload["offerings_kpi"]["value"] == 2
    assert payload["offerings_kpi"]["qoq"] == 1.0  # 1 -> 2 offerings
    assert payload["states"][0]["state"] in {"NY", "CA"}


def test_export_skips_when_empty_leaving_committed_file(tmp_path):
    db = tmp_path / "empty.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.close()
    out = tmp_path / "form_d.json"
    out.write_text('{"committed": true}')
    assert export_form_d_stats(db, out) == 0
    assert json.loads(out.read_text()) == {"committed": True}


def test_medians_exclude_not_yet_raised_offerings(tmp_path):
    # A fund routinely files Form D when the offering opens, before raising
    # anything; ~28% of real new offerings report $0. Folding those zeros into
    # the median dragged whole categories to "$0 median", which reads as a bug.
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    _offering(con, "z1", "2026Q2", 0)
    _offering(con, "z2", "2026Q2", 0)
    _offering(con, "z3", "2026Q2", 4_000_000)
    _offering(con, "z4", "2026Q2", 6_000_000)
    con.close()

    con = duckdb.connect(str(db), read_only=True)
    series = quarter_series(con)
    types = fund_type_breakdown(con, "2026Q2")
    con.close()

    q = series[-1]
    assert q["offerings"] == 4  # zeros still counted as offerings...
    assert q["not_yet_raised"] == 2  # ...and surfaced explicitly
    assert q["median_raised"] == 5_000_000  # ...but excluded from the median
    assert types[0]["median_raised"] == 5_000_000


def test_placement_agents_merge_case_variant_spellings(tmp_path):
    # Real filings spell the same broker inconsistently ("AQR INVESTMENTS, LLC"
    # vs "AQR Investments, LLC"), which split one firm into two league-table
    # rows until the names were normalized for grouping.
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    _offering(con, "m1", "2026Q2", 1_000_000)
    _offering(con, "m2", "2026Q2", 1_000_000)
    _offering(con, "m3", "2026Q2", 1_000_000)
    con.execute(
        """
        INSERT INTO form_d_recipients
            (accession_number, recipient_seq_key, recipient_name, recipient_crd, source_archive)
        VALUES ('m1', '1', 'AQR INVESTMENTS, LLC', 500, 'a.zip'),
               ('m2', '1', 'AQR Investments, LLC', 500, 'a.zip'),
               ('m3', '1', 'AQR Investments LLC',  500, 'a.zip')
        """
    )
    con.close()

    con = duckdb.connect(str(db), read_only=True)
    agents = placement_agents(con, "2026Q2")
    con.close()

    assert len(agents) == 1, "case/suffix variants must collapse to one firm"
    assert agents[0]["offerings"] == 3
    assert agents[0]["crd"] == 500
    # Display keeps a real spelling from the filings, not the normalized form.
    assert agents[0]["name"] in {"AQR INVESTMENTS, LLC", "AQR Investments, LLC", "AQR Investments LLC"}
