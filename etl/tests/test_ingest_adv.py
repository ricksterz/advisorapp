from pathlib import Path

import duckdb
import pandas as pd

from etl.ingest_adv import extract_firms, load, read_firm_feed, read_source

FIXTURE = Path(__file__).parent / "fixtures" / "sample_adv_base.csv"
FEED_FIXTURE = Path(__file__).parent / "fixtures" / "sample_feed.xml"


def test_extract_and_load(tmp_path):
    firms = extract_firms(read_source(FIXTURE))
    assert len(firms) == 3

    acme = firms.set_index("crd").loc[100001]
    assert acme["legal_name"] == "ACME WEALTH ADVISORS LLC"
    assert acme["state"] == "NY"
    assert acme["website_url"] == "http://WWW.ACMEWEALTH.COM"  # scheme added

    # a social-only WebAddr cell nulls out rather than exporting a profile link
    blue_site = firms.set_index("crd").loc[100002, "website_url"]
    assert blue_site is None or pd.isna(blue_site)
    assert acme["aum_discretionary"] == 1_500_000_000
    assert acme["aum_total"] == 1_750_000_000
    assert acme["pct_clients_individuals"] == 38.0  # midpoint of 26-50%
    assert acme["fee_pct_of_aum"] and not acme["fee_hourly"]
    assert acme["affil_count"] == 2  # broker-dealer + pooled-vehicle sponsor
    assert acme["disciplinary_flag_count"] == 0

    blue = firms.set_index("crd").loc[100002]
    assert blue["fee_performance_based"]
    assert blue["disciplinary_flag_count"] == 1

    db = tmp_path / "test.duckdb"
    load(firms, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM firms").fetchone()[0] == 3
    # Re-loading is a full refresh, not an append.
    load(firms, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM firms").fetchone()[0] == 3


def test_read_firm_feed(tmp_path):
    firms = read_firm_feed(FEED_FIXTURE)
    # the firm without a CRD and the exempt reporting adviser are skipped
    assert len(firms) == 2
    assert 900003 not in firms["crd"].values

    crest = firms.set_index("crd").loc[900001]
    assert crest["legal_name"] == "CREST FEED ADVISORS LLC"
    assert crest["state"] == "NY"  # Item 1.F via MainAddr@State
    # Item 1.I: first non-social address wins even when socials are listed first
    assert crest["website_url"] == "HTTP://WWW.CRESTFEED.COM"
    assert crest["business_name"] == "CREST FEED ADVISORS"
    assert crest["sec_number"] == "801-99991"
    assert crest["aum_discretionary"] == 1_800_000_000
    assert crest["aum_total"] == 2_000_000_000
    assert crest["accounts_total"] == 1000
    assert crest["employees_total"] == 40
    assert crest["employees_advisory"] == 25
    # 60 individuals / 100 clients, 30 HNW, 10 pension plans
    assert crest["pct_clients_individuals"] == 60.0
    assert crest["pct_clients_hnw_individuals"] == 30.0
    assert crest["pct_clients_pension_plans"] == 10.0
    assert crest["fee_pct_of_aum"] and crest["fee_fixed"] and crest["fee_performance_based"]
    assert not crest["fee_hourly"]
    assert crest["affil_broker_dealer"] and crest["affil_pooled_vehicle_sponsor"]
    assert crest["affil_count"] == 3  # Q7A1, Q7A10, Q7A16
    assert crest["disciplinary_flag_count"] == 2  # Q11A1 + Q11C2 (summary Q11 excluded)

    plains = firms.set_index("crd").loc[900002]
    assert pd.isna(plains["state"])  # no MainAddr in the feed for this firm
    assert pd.isna(plains["website_url"])  # no Item 1.I websites listed
    assert plains["pct_clients_individuals"] == 100.0
    assert plains["affil_count"] == 0
    assert plains["disciplinary_flag_count"] == 0

    db = tmp_path / "feed.duckdb"
    load(firms, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM firms").fetchone()[0] == 2
    assert str(con.execute(
        "SELECT filing_date FROM firms WHERE crd = 900001"
    ).fetchone()[0]) == "2026-03-04"
