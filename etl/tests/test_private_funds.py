from datetime import date

import duckdb
import pandas as pd

from etl.config import SCHEMA_PATH
from etl.private_funds import parse_7b1, parse_provider, stage_snapshot
from etl.pulse_history import SNAPSHOT_STALENESS_MONTHS

# Headers verified against a real cached ADV_Filing_Data archive (2026-07-27).
FUND_COLS = [
    "FilingID", "Fund Name", "Fund ID", "ReferenceID", "State", "Country",
    "3(c)(1) Exclusion", "3(c)(7) Exclusion", "Master Fund", "Feeder Fund",
    "Master Fund Name", "Master Fund ID", "Fund of Funds",
    "Fund Invested Self or Related", "Fund Invested in Securities", "Fund Type",
    "Fund Type Other", "Gross Asset Value", "Minimum Investment", "Owners",
    "%Owned You or Related", "%Owned Funds", "Sales Limited", "%Owned Non-US",
    "Subadviser", "Other IAs Advise", "Clients Solicited", "Percentage Invested",
    "Exempt from Registration", "Annual Audit", "GAAP", "FS Distributed",
    "Unqualified Opinion", "Prime Brokers", "Custodians", "Administrator",
    "% Assets Valued", "Marketing",
]


def _fund_frame(rows):
    return pd.DataFrame(rows, columns=FUND_COLS).astype(str)


def test_parse_7b1_maps_real_headers():
    raw = _fund_frame(
        [
            [
                "2107670", "PALM PEAK CAPITAL FUND I, L.P.", "805-4964869201", "518607",
                "Delaware", "United States", "N", "Y", "N", "N", "", "", "N", "", "N",
                "Private Equity Fund", "", "321687148", "0", "57", "4", "54", "", "0",
                "N", "N", "N", "0", "Y", "Y", "Y", "Y", "Yes", "N", "Y", "Y", "0", "Y",
            ]
        ]
    )
    out = parse_7b1(raw)
    assert len(out) == 1
    row = out.iloc[0]
    assert row["filing_id"] == 2107670
    assert row["fund_id"] == "805-4964869201"
    assert row["reference_id"] == 518607
    assert row["fund_name"] == "PALM PEAK CAPITAL FUND I, L.P."
    assert row["fund_type"] == "Private Equity Fund"
    assert row["state"] == "Delaware"
    assert bool(row["exclusion_3c7"]) is True
    assert bool(row["exclusion_3c1"]) is False
    assert bool(row["is_master_fund"]) is False
    assert row["gross_asset_value"] == 321687148.0


def test_parse_7b1_drops_rows_missing_required_fields():
    raw = _fund_frame(
        [
            ["2107670", "FUND A", "805-1", "1"] + [""] * 34,
            ["", "FUND B", "805-2", "2"] + [""] * 34,  # no filing ID
            ["2107671", "FUND C", "", "3"] + [""] * 34,  # no fund ID
        ]
    )
    out = parse_7b1(raw)
    assert list(out.fund_id) == ["805-1"]


def test_parse_provider_maps_named_auditor():
    raw = pd.DataFrame(
        [["2107670", "518607", "GRANT THORNTON LLP", "FORT LAUDERDALE", "Florida", "United States", "Y", "Y", "248", "Y"]],
        columns=[
            "FilingID", "ReferenceID", "Name of Auditing Firm", "City", "State",
            "Country", "Independent", "PCAOB Registered", "PCAOB Number", "PCAOB Inspected",
        ],
    ).astype(str)
    out = parse_provider(raw, "auditor", "Name of Auditing Firm")
    assert len(out) == 1
    row = out.iloc[0]
    assert row["filing_id"] == 2107670
    assert row["reference_id"] == 518607
    assert row["provider_name"] == "GRANT THORNTON LLP"
    assert row["city"] == "FORT LAUDERDALE"
    assert row["role"] == "auditor"


def test_parse_provider_missing_columns_returns_empty():
    # A sub-item table missing an expected column (schema drift) should not
    # crash the load — just produce nothing for that role.
    raw = pd.DataFrame([["1", "2", "SOME NAME"]], columns=["FilingID", "ReferenceID", "Unexpected"])
    out = parse_provider(raw, "custodian", "Legal Name of Custodian")
    assert out.empty


def _db(tmp_path):
    con = duckdb.connect(str(tmp_path / "t.duckdb"))
    con.execute(SCHEMA_PATH.read_text())
    return con


def _fund_filing(con, filing_id, fund_id, crd, submitted, gav, source="a.zip"):
    con.execute(
        """
        INSERT INTO private_fund_filings
            (filing_id, fund_id, reference_id, crd, date_submitted, fund_name, fund_type,
             gross_asset_value, exclusion_3c1, exclusion_3c7, is_master_fund, is_feeder_fund, source_archive)
        VALUES (?, ?, ?, ?, ?, 'FUND', 'Hedge Fund', ?, false, true, false, false, ?)
        """,
        [filing_id, fund_id, filing_id, crd, submitted, gav, source],
    )


def test_snapshot_takes_latest_filing_per_fund_and_excludes_withdrawn(tmp_path):
    con = _db(tmp_path)
    _fund_filing(con, 1, "805-1", 100, date(2026, 1, 10), 1e6)
    _fund_filing(con, 2, "805-1", 100, date(2026, 3, 31), 2e6)  # later filing wins
    _fund_filing(con, 3, "805-2", 200, date(2026, 2, 1), 5e5)
    _fund_filing(con, 4, "805-3", 300, date(2026, 3, 20), 3e5)
    # firm 300 withdraws after its filing -> its fund excluded
    con.execute(
        "INSERT INTO adv_withdrawals (filing_id, crd, filing_date, source_archive) VALUES (9, 300, ?, 't')",
        [date(2026, 3, 25)],
    )
    stage_snapshot(con)
    rows = con.execute("SELECT fund_id, gross_asset_value FROM private_funds ORDER BY fund_id").fetchall()
    assert rows == [("805-1", 2e6), ("805-2", 5e5)]


def test_snapshot_joins_providers_by_winning_filing_only(tmp_path):
    con = _db(tmp_path)
    _fund_filing(con, 1, "805-1", 100, date(2026, 1, 10), 1e6)
    _fund_filing(con, 2, "805-1", 100, date(2026, 3, 31), 2e6)
    # provider row from the OLD (losing) filing must not appear
    con.execute(
        "INSERT INTO private_fund_provider_filings VALUES (1, 1, 'auditor', 'OLD AUDITOR', 'NY', 'NY', 'US', 'a.zip')"
    )
    con.execute(
        "INSERT INTO private_fund_provider_filings VALUES (2, 2, 'auditor', 'NEW AUDITOR', 'NY', 'NY', 'US', 'a.zip')"
    )
    stage_snapshot(con)
    rows = con.execute("SELECT provider_name FROM private_fund_providers").fetchall()
    assert rows == [("NEW AUDITOR",)]


def test_snapshot_staleness_window_ages_funds_out(tmp_path):
    con = _db(tmp_path)
    _fund_filing(con, 1, "805-old", 100, date(2025, 1, 10), 1e6)  # never files again
    _fund_filing(con, 2, "805-new", 200, date(2026, 6, 30), 5e5)
    stage_snapshot(con)
    fund_ids = {r[0] for r in con.execute("SELECT fund_id FROM private_funds").fetchall()}
    # 805-old's only filing predates the newest by more than the staleness window
    assert fund_ids == {"805-new"}
    assert (date(2026, 6, 30) - date(2025, 1, 10)).days / 30 > SNAPSHOT_STALENESS_MONTHS
