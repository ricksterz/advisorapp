import io
import zipfile

import duckdb
import pandas as pd

from etl.config import SCHEMA_PATH
from etl.form_d import parse_archive, parse_quarter

# Headers verified against the real 2026q2_d.zip (2026-07-28).
SUBMISSION_COLS = [
    "ACCESSIONNUMBER", "FILE_NUM", "FILING_DATE", "SIC_CODE", "SCHEMAVERSION",
    "SUBMISSIONTYPE", "TESTORLIVE", "OVER100PERSONSFLAG", "OVER100ISSUERFLAG",
]
ISSUER_COLS = [
    "ACCESSIONNUMBER", "IS_PRIMARYISSUER_FLAG", "ISSUER_SEQ_KEY", "CIK", "ENTITYNAME",
    "STREET1", "STREET2", "CITY", "STATEORCOUNTRY", "STATEORCOUNTRYDESCRIPTION",
    "ZIPCODE", "ISSUERPHONENUMBER", "JURISDICTIONOFINC", "ENTITYTYPE",
]
OFFERING_COLS = [
    "ACCESSIONNUMBER", "INDUSTRYGROUPTYPE", "INVESTMENTFUNDTYPE",
    "ISPOOLEDINVESTMENTFUNDTYPE", "ISAMENDMENT", "PREVIOUSACCESSIONNUMBER",
    "TOTALOFFERINGAMOUNT", "TOTALAMOUNTSOLD", "MINIMUMINVESTMENTACCEPTED",
    "HASNONACCREDITEDINVESTORS",
]
RECIPIENT_COLS = [
    "ACCESSIONNUMBER", "RECIPIENT_SEQ_KEY", "RECIPIENTNAME", "RECIPIENTCRDNUMBER",
    "ASSOCIATEDBDNAME", "ASSOCIATEDBDCRDNUMBER", "STATEORCOUNTRY",
]


def _tsv(cols, rows):
    return pd.DataFrame(rows, columns=cols).to_csv(sep="\t", index=False)


def _make_zip(path=None, quarter="2026Q2"):
    """One new offering and one amendment, plus issuers and a recipient."""
    submissions = _tsv(SUBMISSION_COLS, [
        ["0001-26-000001", "021-1", "30-JUN-2026", "6770", "X0708", "D", "LIVE", "", ""],
        ["0001-26-000002", "021-2", "15-MAY-2026", "6770", "X0708", "D/A", "LIVE", "", ""],
    ])
    issuers = _tsv(ISSUER_COLS, [
        # Real files spell this flag YES/NO, not true/false.
        ["0001-26-000001", "YES", "1", "111", "ACME FUND I LP", "", "", "NEW YORK", "NY", "NEW YORK", "10001", "", "DE", "Limited Partnership"],
        ["0001-26-000001", "NO", "2", "112", "ACME CO-ISSUER LP", "", "", "BOSTON", "MA", "MASSACHUSETTS", "02110", "", "DE", "Limited Partnership"],
        ["0001-26-000002", "YES", "1", "222", "BETA FUND II LP", "", "", "SAN FRANCISCO", "CA", "CALIFORNIA", "94105", "", "DE", "Limited Partnership"],
    ])
    offerings = _tsv(OFFERING_COLS, [
        ["0001-26-000001", "Pooled Investment Fund", "Venture Capital Fund", "true", "false", "None", "10000000", "4000000", "25000", "false"],
        ["0001-26-000002", "Pooled Investment Fund", "Hedge Fund", "true", "true", "0001-25-000009", "None", "900000000", "100000", "false"],
    ])
    recipients = _tsv(RECIPIENT_COLS, [
        ["0001-26-000001", "101", "Goldman Sachs & Co. LLC", "361", "Goldman Sachs & Co. LLC", "361", "NY"],
    ])

    buf = io.BytesIO() if path is None else None
    target = buf if path is None else path
    with zipfile.ZipFile(target, "w") as zf:
        zf.writestr(f"{quarter}_d/FORMDSUBMISSION.tsv", submissions)
        zf.writestr(f"{quarter}_d/ISSUERS.tsv", issuers)
        zf.writestr(f"{quarter}_d/OFFERING.tsv", offerings)
        zf.writestr(f"{quarter}_d/RECIPIENTS.tsv", recipients)
    if path is None:
        buf.seek(0)
        return zipfile.ZipFile(buf)
    return path


def test_parse_quarter_from_filename():
    assert parse_quarter("2026q2_d.zip") == "2026Q2"
    assert parse_quarter("2025Q4_d.zip") == "2025Q4"
    assert parse_quarter("form-d-latest.zip") is None


def test_parse_archive_flattens_submission_issuer_and_offering():
    offerings, recipients = parse_archive(_make_zip(), "2026Q2")
    assert len(offerings) == 2
    new = offerings[offerings.accession_number == "0001-26-000001"].iloc[0]
    assert new["investment_fund_type"] == "Venture Capital Fund"
    assert bool(new["is_pooled_fund"]) is True
    assert bool(new["is_amendment"]) is False
    assert new["total_amount_sold"] == 4000000
    assert new["min_investment"] == 25000
    assert str(new["filing_date"]) == "2026-06-30"
    assert new["quarter"] == "2026Q2"
    assert len(recipients) == 1
    assert recipients.iloc[0]["recipient_crd"] == 361


def test_parse_archive_takes_only_the_primary_issuer():
    # Regression: IS_PRIMARYISSUER_FLAG is YES/NO in the real files, not the
    # true/false that OFFERING's own booleans use. Matching on "true" silently
    # emptied every issuer field until a real-data check caught it.
    offerings, _ = parse_archive(_make_zip(), "2026Q2")
    row = offerings[offerings.accession_number == "0001-26-000001"].iloc[0]
    assert row["issuer_name"] == "ACME FUND I LP"  # not the NO-flagged co-issuer
    assert row["issuer_state"] == "NY"
    assert offerings.issuer_name.notna().all()


def test_parse_archive_marks_amendments_without_dropping_them():
    # Amendments must survive the load (auditable) but be distinguishable, so
    # aggregation can exclude them — they restate cumulative totals.
    offerings, _ = parse_archive(_make_zip(), "2026Q2")
    amd = offerings[offerings.accession_number == "0001-26-000002"].iloc[0]
    assert bool(amd["is_amendment"]) is True
    assert amd["previous_accession_number"] == "0001-25-000009"
    assert amd["total_amount_sold"] == 900000000
    assert pd.isna(amd["total_offering_amount"])  # "None" -> NaN, an indefinite offering


def test_stage_load_is_idempotent_and_skips_loaded_archives(tmp_path, capsys):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())

    raw_dir = tmp_path / "formd"
    raw_dir.mkdir()
    _make_zip(raw_dir / "2026q2_d.zip")

    from etl import form_d

    original = form_d.FORMD_RAW_DIR
    form_d.FORMD_RAW_DIR = raw_dir
    try:
        form_d.stage_load(con)
        assert con.execute("SELECT count(*) FROM form_d_offerings").fetchone()[0] == 2
        form_d.stage_load(con)  # second run: already loaded, must not duplicate
        assert con.execute("SELECT count(*) FROM form_d_offerings").fetchone()[0] == 2
        assert con.execute("SELECT count(*) FROM form_d_recipients").fetchone()[0] == 1
    finally:
        form_d.FORMD_RAW_DIR = original
        con.close()
