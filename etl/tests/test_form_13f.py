import json
import zipfile

import duckdb
import pandas as pd
import pytest

from etl.config import SCHEMA_PATH
from etl.form_13f import (
    effective_filings,
    export,
    latest_data_set_url,
    load_archive,
    name_state_index,
    normalized_name,
    summarize_filer,
    value_scale,
)


def test_latest_data_set_url_takes_the_first_zip_and_makes_it_absolute():
    page = (
        '<a href="/files/structureddata/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip">new</a>'
        '<a href="/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip">old</a>'
    )
    assert latest_data_set_url(page) == (
        "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip"
    )
    assert latest_data_set_url("<p>nothing here</p>") is None


def test_effective_filings_restatement_replaces_and_new_holdings_add():
    rows = [
        ("A", "a1", "2026-08-01", "13F-HR", None),
        ("A", "a2", "2026-08-05", "13F-HR/A", "NEW HOLDINGS"),
        ("B", "b1", "2026-08-01", "13F-HR", None),
        ("B", "b2", "2026-08-03", "13F-HR/A", "NEW HOLDINGS"),  # added to b1, then replaced
        ("B", "b3", "2026-08-10", "13F-HR/A", "RESTATEMENT"),
        ("C", "c1", "2026-08-01", "13F-NT", None),  # a notice: no holdings
        ("D", "d1", "2026-08-01", "13F-HR/A", "NEW HOLDINGS"),  # nothing to add to
    ]
    assert effective_filings(rows) == {
        "A": {"base": "a1", "additions": ["a2"]},
        "B": {"base": "b3", "additions": []},
    }


@pytest.mark.parametrize(
    ("ratios", "expected"),
    [
        ([1.0, 1.1, 0.9], 1.0),
        ([0.001, 0.0011, 0.0009, 0.001], 1000.0),  # filed in thousands
        ([1000, 1100, 950], 0.001),  # filed in tenths of a cent, or similar
        ([40, 45, 50], None),  # fits no plausible unit
        ([500, 500], 1.0),  # too few priced positions to judge
    ],
)
def test_value_scale(ratios, expected):
    assert value_scale(ratios) == expected


def test_normalized_name_ignores_case_punctuation_and_legal_suffixes():
    assert normalized_name("Tortuga Wealth Management, Inc") == normalized_name("TORTUGA WEALTH MANAGEMENT INC")
    assert normalized_name("Acme Capital, L.L.C.") == "acme capital"
    assert normalized_name(None) == ""


def test_name_state_index_skips_names_too_short_to_identify_anyone():
    index = name_state_index([
        (1, "Acme Capital LLC", "ACME CAPITAL", "NY"),
        (2, "25 LLC", None, "NY"),
        (3, "Acme Capital Inc", None, "NY"),  # same name, same state: ambiguous
        (4, "Zeta Partners", None, None),  # no state to pair with
    ])
    assert index == {("acme capital", "NY"): {1, 3}}


def test_summarize_filer_keeps_options_out_of_the_total():
    holdings = [
        ("111", "APPLE INC", "COM", None, 600.0),
        ("111", "APPLE INC", "COM", None, 200.0),  # second lot, same security
        ("222", "NVIDIA CORP", "COM", None, 200.0),
        ("222", "NVIDIA CORP", "COM", "Call", 5000.0),
    ]
    s = summarize_filer(holdings, 1.0)
    assert s["value"] == 1000
    assert s["options_value"] == 5000
    assert s["positions"] == 2
    assert s["top"][0] == {"issuer": "APPLE INC", "cusip": "111", "value": 800, "pct": 0.8}
    assert s["values_reliable"] is True


def test_summarize_filer_publishes_no_dollars_when_the_scale_is_unknown():
    s = summarize_filer([("111", "APPLE INC", "COM", None, 600.0)], None)
    assert s["value"] is None and s["options_value"] is None
    assert s["top"] == [{"issuer": "APPLE INC", "cusip": "111", "value": None, "pct": None}]
    assert s["positions"] == 1
    assert s["values_reliable"] is False


# ------------------------------------------------------------------ load + export


def _tsv(rows, cols):
    return pd.DataFrame(rows, columns=cols).to_csv(sep="\t", index=False)


def _make_zip(path):
    """Four managers: one filing with its CRD, one matched by name and state,
    a parent naming a subsidiary adviser, and an old late filing."""
    submission = _tsv(
        [
            ["0001-26-1", "30-JUN-2026", "13F-HR", "0000000001", "01-AUG-2026"],
            ["0002-26-1", "30-JUN-2026", "13F-HR", "0000000002", "02-AUG-2026"],
            ["0003-26-1", "30-JUN-2026", "13F-HR", "0000000003", "03-AUG-2026"],
            ["0004-26-1", "31-MAR-2001", "13F-HR", "0000000004", "04-AUG-2026"],
        ],
        ["ACCESSION_NUMBER", "PERIODOFREPORT", "SUBMISSIONTYPE", "CIK", "FILING_DATE"],
    )
    cover = _tsv(
        [
            ["0001-26-1", "", "OWN CRD ADVISORS LLC", "NEW YORK", "NY", "100", "801-1"],
            ["0002-26-1", "", "Name Match Capital, Inc.", "BOSTON", "MA", "", ""],
            ["0003-26-1", "", "BIG PARENT CORP", "NEW YORK", "NY", "", ""],
            ["0004-26-1", "", "LATE FILER", "DALLAS", "TX", "400", ""],
        ],
        [
            "ACCESSION_NUMBER", "AMENDMENTTYPE", "FILINGMANAGER_NAME", "FILINGMANAGER_CITY",
            "FILINGMANAGER_STATEORCOUNTRY", "CRDNUMBER", "SECFILENUMBER",
        ],
    )
    summary = _tsv(
        [["0001-26-1", "1000", "2"], ["0002-26-1", "50", "1"], ["0003-26-1", "9000", "1"]],
        ["ACCESSION_NUMBER", "TABLEVALUETOTAL", "TABLEENTRYTOTAL"],
    )
    others = _tsv(
        [
            ["0003-26-1", "1", "", "300", "801-3", "SUBSIDIARY FUND ADVISORS"],
            ["0003-26-1", "2", "", "100", "801-1", "OWN CRD ADVISORS LLC"],  # files its own too
        ],
        ["ACCESSION_NUMBER", "SEQUENCENUMBER", "CIK", "CRDNUMBER", "SECFILENUMBER", "NAME"],
    )
    info = _tsv(
        [
            ["0001-26-1", "APPLE INC", "COM", "037833100", "700", "7", "SH", ""],
            ["0001-26-1", "NVIDIA CORP", "COM", "67066G104", "300", "3", "SH", ""],
            ["0001-26-1", "NVIDIA CORP", "COM", "67066G104", "900", "9", "SH", "Call"],
            ["0002-26-1", "APPLE INC", "COM", "037833100", "50", "1", "SH", ""],
            ["0003-26-1", "APPLE INC", "COM", "037833100", "9000", "90", "SH", ""],
            ["0004-26-1", "APPLE INC", "COM", "037833100", "1", "1", "SH", ""],
        ],
        [
            "ACCESSION_NUMBER", "NAMEOFISSUER", "TITLEOFCLASS", "CUSIP", "VALUE",
            "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL",
        ],
    )
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("SUBMISSION.tsv", submission)
        zf.writestr("COVERPAGE.tsv", cover)
        zf.writestr("SUMMARYPAGE.tsv", summary)
        zf.writestr("OTHERMANAGER2.tsv", others)
        zf.writestr("INFOTABLE.tsv", info)


def test_load_and_export_match_firms_three_ways(tmp_path):
    db = tmp_path / "t.duckdb"
    zip_path = tmp_path / "01jun2026-31aug2026_form13f.zip"
    _make_zip(zip_path)

    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.executemany(
        "INSERT INTO firms (crd, sec_number, legal_name, business_name, state) VALUES (?, ?, ?, ?, ?)",
        [
            (100, "801-1", "Own CRD Advisors LLC", None, "NY"),
            (200, None, "Name Match Capital Inc", "NAME MATCH CAPITAL", "MA"),
            (300, "801-3", "Subsidiary Fund Advisors", None, "NY"),
            (400, None, "Late Filer", None, "TX"),
            (500, None, "Nobody Files LLC", None, "CA"),
        ],
    )
    load_archive(con, zip_path)
    load_archive(con, zip_path)  # reloading an archive replaces it, never duplicates
    assert con.execute("SELECT count(*) FROM f13_filings").fetchone()[0] == 4
    con.close()

    out = tmp_path / "form_13f.json"
    assert export(db, out)
    data = json.loads(out.read_text())

    assert data["period"] == "2026-06-30"  # the late 2001 filing doesn't pick the quarter
    assert data["firms"] == {
        "100": {"cik": "0000000001", "own": True, "matched": "crd"},
        "200": {"cik": "0000000002", "own": True, "matched": "name_state"},
        "300": {"cik": "0000000003", "own": False, "matched": "included_manager"},
    }
    own = data["filers"]["0000000001"]
    assert own["value"] == 1000 and own["options_value"] == 900 and own["positions"] == 2
    assert own["top"][0]["issuer"] == "APPLE INC"
    assert data["summary"]["firms_own"] == 2 and data["summary"]["firms_included"] == 1


def test_export_leaves_the_file_alone_without_13f_data(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.close()
    out = tmp_path / "form_13f.json"
    assert export(db, out) is False
    assert not out.exists()
