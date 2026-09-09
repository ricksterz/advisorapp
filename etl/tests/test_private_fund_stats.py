import json
from datetime import date

import duckdb

from etl.config import SCHEMA_PATH
from etl.private_fund_stats import (
    _normalize_provider,
    domicile_series,
    export_firm_private_funds,
    export_private_fund_stats,
    fund_count_kpi,
    fund_type_series,
    quarterly_series,
    top_firms,
)


def test_normalize_provider_collapses_legal_suffix_variants():
    assert _normalize_provider("KPMG LLP") == "KPMG"
    assert _normalize_provider("KPMG, LLP") == "KPMG"
    assert _normalize_provider("KPMG") == "KPMG"
    assert _normalize_provider("Ernst & Young LLP") == "ERNST & YOUNG"


def _make_db(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute("INSERT INTO firms (crd, legal_name, business_name) VALUES (1, 'ACME ADVISORS LLC', 'ACME')")
    con.execute(
        """
        INSERT INTO private_funds
            (fund_id, crd, fund_name, fund_type, state, country, exclusion_3c1, exclusion_3c7,
             is_master_fund, is_feeder_fund, gross_asset_value, reference_id, filing_id, date_submitted, source_archive)
        VALUES
            ('805-1', 1, 'ACME MASTER FUND', 'Hedge Fund', 'Delaware', 'United States',
             false, true, true, false, 100000000, 11, 111, ?, 'a.zip'),
            ('805-2', 1, 'ACME FEEDER FUND', 'Hedge Fund', 'Cayman Islands', 'Cayman Islands',
             false, true, false, true, 40000000, 12, 112, ?, 'a.zip')
        """,
        [date(2026, 6, 30), date(2026, 6, 30)],
    )
    con.execute(
        """
        INSERT INTO private_fund_providers (filing_id, reference_id, role, provider_name, city, state, country, source_archive)
        VALUES
            (111, 11, 'auditor', 'KPMG LLP', 'NEW YORK', 'NY', 'United States', 'a.zip'),
            (111, 11, 'custodian', 'STATE STREET', 'BOSTON', 'MA', 'United States', 'a.zip'),
            (112, 12, 'auditor', 'KPMG, LLP', 'NEW YORK', 'NY', 'United States', 'a.zip')
        """
    )
    con.close()
    return db


def test_fund_type_series_excludes_feeder_funds_from_count_and_gav(tmp_path):
    db = _make_db(tmp_path)
    con = duckdb.connect(str(db), read_only=True)
    types = fund_type_series(con)
    con.close()
    assert len(types) == 1
    hedge = types[0]
    assert hedge["type"] == "Hedge Fund"
    # the feeder is the same underlying capital as its master counted a
    # second time, so it is excluded from the fund count too, not only GAV
    assert hedge["count"] == 1
    assert hedge["gav"] == 100000000


def test_domicile_series_excludes_feeder_funds(tmp_path):
    # _make_db's master is domiciled in Delaware, its feeder in Cayman
    # Islands — each state/country must show the master's count only.
    db = _make_db(tmp_path)
    con = duckdb.connect(str(db), read_only=True)
    domicile = {d["domicile"]: d["count"] for d in domicile_series(con)}
    con.close()
    assert domicile.get("Delaware") == 1
    assert "Cayman Islands" not in domicile


def test_top_firms_fund_count_excludes_feeders(tmp_path):
    db = _make_db(tmp_path)
    con = duckdb.connect(str(db), read_only=True)
    firms = top_firms(con)
    con.close()
    assert firms[0]["fund_count"] == 1
    assert firms[0]["gav"] == 100000000


def test_total_firms_is_not_feeder_filtered_even_when_the_whole_book_is_feeders(tmp_path):
    # An adviser whose only private fund is a feeder is still a real
    # private-fund adviser — a real pull has 44 such advisers. Filtering
    # count(DISTINCT crd) the same way as count(*) would silently drop them
    # from total_firms even though they genuinely advise a private fund.
    db = tmp_path / "feeder_only.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute("INSERT INTO firms (crd, legal_name) VALUES (9, 'FEEDER ONLY LLC')")
    con.execute(
        """
        INSERT INTO private_funds
            (fund_id, crd, fund_name, fund_type, is_master_fund, is_feeder_fund,
             gross_asset_value, reference_id, filing_id, date_submitted, source_archive)
        VALUES ('805-9', 9, 'ONLY A FEEDER', 'Hedge Fund', false, true,
                5000000, 91, 991, ?, 'a.zip')
        """,
        [date(2026, 6, 30)],
    )
    con.close()

    out = tmp_path / "private_funds.json"
    export_private_fund_stats(db, out)
    payload = json.loads(out.read_text())
    assert payload["total_firms"] == 1  # the feeder-only adviser is still counted
    assert payload["total_funds"] == 0  # but contributes zero to the fund count



def test_export_private_fund_stats_writes_full_payload(tmp_path):
    db = _make_db(tmp_path)
    out = tmp_path / "private_funds.json"
    n = export_private_fund_stats(db, out)
    assert n == 1  # feeder excluded from the fund count returned too
    payload = json.loads(out.read_text())
    assert payload["as_of"] == "2026-06-30"
    assert payload["total_funds"] == 1
    # total_firms is deliberately NOT feeder-filtered: an adviser whose whole
    # book is a feeder fund is still a real private-fund adviser
    assert payload["total_firms"] == 1
    assert payload["top_firms"][0]["crd"] == 1
    assert payload["top_firms"][0]["name"] == "ACME"
    assert payload["top_firms"][0]["fund_count"] == 1
    assert payload["top_firms"][0]["gav"] == 100000000


def test_export_private_fund_stats_skips_when_empty_leaving_committed_file(tmp_path):
    db = tmp_path / "empty.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.close()
    out = tmp_path / "private_funds.json"
    out.write_text('{"committed": true}')
    n = export_private_fund_stats(db, out)
    assert n == 0
    assert json.loads(out.read_text()) == {"committed": True}


def test_export_firm_private_funds_joins_providers_by_filing(tmp_path):
    db = _make_db(tmp_path)
    out = tmp_path / "firm_private_funds.json"
    n = export_firm_private_funds(db, out)
    assert n == 2
    payload = json.loads(out.read_text())
    funds = payload["firms"]["1"]
    assert len(funds) == 2
    # sorted by GAV desc — master fund (100M) before feeder (40M)
    master = funds[0]
    assert master["name"] == "ACME MASTER FUND"
    assert master["is_master_fund"] is True
    assert {p["role"] for p in master["providers"]} == {"auditor", "custodian"}
    feeder = funds[1]
    assert feeder["is_feeder_fund"] is True
    assert [p["role"] for p in feeder["providers"]] == ["auditor"]


def test_export_firm_private_funds_dedupes_repeated_provider_rows(tmp_path):
    # The 7B1A28 marketer sub-item carries a SubreferenceID per marketing
    # arrangement, so the same (filing_id, reference_id) can legitimately
    # produce >1 raw row naming the same marketer — found via a real-data
    # browser check where this caused a React duplicate-key warning.
    db = _make_db(tmp_path)
    con = duckdb.connect(str(db))
    con.execute(
        "INSERT INTO private_fund_providers VALUES (111, 11, 'marketer', 'DUP MARKETER', 'NY', 'NY', 'US', 'a.zip')"
    )
    con.execute(
        "INSERT INTO private_fund_providers VALUES (111, 11, 'marketer', 'DUP MARKETER', 'NY', 'NY', 'US', 'a.zip')"
    )
    con.close()
    out = tmp_path / "firm_private_funds.json"
    export_firm_private_funds(db, out)
    payload = json.loads(out.read_text())
    master = payload["firms"]["1"][0]
    marketers = [p for p in master["providers"] if p["role"] == "marketer"]
    assert marketers == [{"role": "marketer", "name": "DUP MARKETER"}]


def _make_db_with_quarters(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute(
        """
        INSERT INTO private_fund_snapshots (snapshot_quarter, fund_id, crd, fund_type, gross_asset_value, is_feeder_fund)
        VALUES
            ('2026-03-31', '805-1', 1, 'Hedge Fund', 100000000, false),
            ('2026-03-31', '805-2', 1, 'Hedge Fund', 40000000, true),
            ('2026-06-30', '805-1', 1, 'Hedge Fund', 110000000, false),
            ('2026-06-30', '805-2', 1, 'Hedge Fund', 45000000, true),
            ('2026-06-30', '805-3', 2, 'Private Equity Fund', 5000000, false)
        """
    )
    con.close()
    return db


def test_quarterly_series_excludes_feeder_funds_from_count_and_gav(tmp_path):
    db = _make_db_with_quarters(tmp_path)
    con = duckdb.connect(str(db), read_only=True)
    series = quarterly_series(con, ["2026-03-31", "2026-06-30"])
    con.close()
    # Q1: master 805-1 (100M) + feeder 805-2 (40M) -> 1 real fund, not 2
    assert series[0] == {
        "quarter": "2026-03-31",
        "total_funds": 1,
        "fund_types": [{"type": "Hedge Fund", "count": 1, "gav": 100000000}],
    }
    # Q2: master 805-1 (110M) + feeder 805-2 (45M) + master 805-3 (5M, crd 2)
    # -> 2 real funds, not 3
    assert series[1]["total_funds"] == 2
    types_by_name = {t["type"]: t for t in series[1]["fund_types"]}
    assert types_by_name["Hedge Fund"]["count"] == 1
    assert types_by_name["Hedge Fund"]["gav"] == 110000000


def test_fund_count_kpi_computes_qoq():
    series = [{"total_funds": 2}, {"total_funds": 3}]
    kpi = fund_count_kpi(series)
    assert kpi["value"] == 3
    assert kpi["qoq"] == 0.5
    assert kpi["yoy"] is None  # fewer than 5 quarters


def test_fund_count_kpi_empty_series():
    assert fund_count_kpi([]) == {"value": None, "qoq": None, "yoy": None}
