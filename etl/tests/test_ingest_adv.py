from pathlib import Path

import duckdb
import pandas as pd
import pytest

from etl.ingest_adv import (
    extract_firms,
    load,
    name_match_level,
    pick_website,
    read_firm_feed,
    read_source,
)

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
    assert len(firms) == 3
    assert 900003 not in firms["crd"].values

    crest = firms.set_index("crd").loc[900001]
    assert crest["legal_name"] == "CREST FEED ADVISORS LLC"
    assert crest["state"] == "NY"  # Item 1.F via MainAddr@State
    assert crest["country"] == "United States"  # Item 1.F via MainAddr@Cntry
    # Item 1.I: the firm's own site wins even when socials are listed first
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
    assert pd.isna(plains["country"])
    assert pd.isna(plains["website_url"])  # no Item 1.I websites listed
    assert plains["pct_clients_individuals"] == 100.0
    assert plains["affil_count"] == 0
    assert plains["disciplinary_flag_count"] == 0

    # A non-US firm: the feed sends Cntry but omits State outright (not an
    # empty attribute) — the real shape of a foreign registrant's MainAddr.
    london = firms.set_index("crd").loc[900004]
    assert pd.isna(london["state"])
    assert london["country"] == "United Kingdom"

    db = tmp_path / "feed.duckdb"
    load(firms, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM firms").fetchone()[0] == 3
    assert str(con.execute(
        "SELECT filing_date FROM firms WHERE crd = 900001"
    ).fetchone()[0]) == "2026-03-04"


# --- choosing the firm's website among its filed Item 1.I addresses ---------


def test_pick_website_prefers_the_firms_own_domain_over_a_platform_listed_first():
    # BLACKROCK FUND ADVISORS' real filing, abridged: WeChat came first and was
    # shown as its website, with blackrock.com further down the same list.
    filed = [
        "https://www.youtube.com/channel/UCrIXkHfv2tMzebAI1TcdDhg",
        "https://www.facebook.com/iShares/",
        "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzIzMTc3MTQ2Mw==",
        "https://www.douyin.com/user/MS4wLjABAAAATX0B",
        "https://www.ishares.com",
        "https://www.blackrock.com",
        "https://line.naver.jp/ti/p/@blackrocktw",
    ]
    assert pick_website(filed, names=("BLACKROCK FUND ADVISORS",)) == "https://www.blackrock.com"


def test_pick_website_prefers_the_name_itself_over_a_longer_domain_containing_it():
    filed = [
        "HTTPS://WISDOM.EDWARDJONES.COM/US-EN/EDWOW",
        "HTTPS://WWW.EDWARDJONESCREDITCARD.COM",
        "HTTPS://WWW.EDWARDJONES.COM",
    ]
    assert pick_website(filed, names=("EDWARD JONES",)) == "HTTPS://WWW.EDWARDJONES.COM"


def test_pick_website_business_name_breaks_a_tie_with_the_legal_name():
    filed = [
        "HTTPS://WWW.WELLSFARGOADVISORS.COM/WFA/MOBILE",
        "HTTPS://WWW.WELLSFARGOCLEARINGSERVICESLLC.COM",
    ]
    names = ("WELLS FARGO ADVISORS", "WELLS FARGO CLEARING SERVICES, LLC")
    assert pick_website(filed, names=names).startswith("HTTPS://WWW.WELLSFARGOADVISORS.COM")


def test_pick_website_matches_initials_through_a_dotted_legal_suffix():
    # KKR's real filing, abridged: an affiliate's energy company came first.
    filed = [
        "https://crescentenergyco.com/",
        "https://arctospartners.com/",
        "https://www.kkr.com/wealth",
        "HTTP://WWW.KKR.COM",
    ]
    assert pick_website(filed, names=("KOHLBERG KRAVIS ROBERTS & CO. L.P.",)) == "HTTP://WWW.KKR.COM"


def test_pick_website_prefers_com_over_a_country_mirror_of_the_same_brand():
    filed = ["https://www.twosigma.cn/", "https://www.twosigma.com/"]
    assert pick_website(filed, names=("TWO SIGMA INVESTMENTS, LP",)) == "https://www.twosigma.com/"


def test_pick_website_keeps_filed_order_when_nothing_matches_the_name():
    # No name evidence either way: don't reorder on URL shape alone.
    filed = ["HTTPS://WWW.LYNXHEDGE.SE/EN", "HTTPS://WWW.LYNXDYNAMIC.SE"]
    assert pick_website(filed, names=("ALPHA BETA ADVISORS",)) == "HTTPS://WWW.LYNXHEDGE.SE/EN"


def test_pick_website_is_none_when_every_address_is_a_platform():
    filed = ["https://maryandpip.substack.com/", "https://www.pinterest.ca/fearlessfinance"]
    assert pick_website(filed, names=("MARY & PIP",)) is None


def test_pick_website_does_not_split_urls_on_ampersands():
    # Splitting on "&" used to turn query strings into garbage "websites".
    filed = ["https://www.facebook.com/people/x/1/?mibextid=wwXIfr&rdid=X&share_url=https%3A%2F%2Fwww."]
    assert pick_website(filed, names=("CORRALES & CO.",)) is None


def test_pick_website_drops_trailing_punctuation():
    assert pick_website(["https://www.thinkpinnacle.com."], names=()) == "https://www.thinkpinnacle.com"


@pytest.mark.parametrize(
    "label,name,level",
    [
        ("edwardjones", "EDWARD JONES", 4),
        ("janushenderson", "JANUS HENDERSON INVESTORS", 3),
        ("blackrock", "BLACKROCK FUND ADVISORS", 2),
        ("ifa", "INDEX FUND ADVISORS, INC.", 2),  # initials; INC. is a suffix, not a word
        ("kkr", "KOHLBERG KRAVIS ROBERTS & CO. L.P.", 2),  # "L.P." must not become words "l", "p"
        ("zmlp", "ZEPHYR MANAGEMENT, L.P.", 2),  # initials including the suffix
        ("hwmi", "HERITAGE WEALTH MANAGEMENT, INC.", 2),
        ("edwardjonescreditcard", "EDWARD JONES", 1),
        ("hilltlv", "HILL INVESTMENT GROUP", 0),  # "hill" alone is too short to count
        ("allgoodfin", "GOOD LIFE ADVISORS, LLC", 0),
        ("capital", "CAPITAL RESEARCH AND MANAGEMENT", 1),  # generic first word never reaches 2
    ],
)
def test_name_match_level(label, name, level):
    assert name_match_level(label, name) == level
