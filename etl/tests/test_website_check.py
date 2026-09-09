import json
from datetime import datetime, timezone

import duckdb
import pytest

from etl import website_check
from etl.config import SCHEMA_PATH


def _make_db(tmp_path, checks):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute(
        "INSERT INTO firms (crd, legal_name, website_url) VALUES "
        "(1, 'HALL CAPITAL', 'https://hallcapital.com/'), "
        "(2, 'VANGUARD', 'https://www.reddit.com/user/VanguardGroup/'), "
        "(3, 'AP WEALTH', 'https://www.yelp.com/biz/ap-wealth-management-augusta')"
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for url, status, http, final, domain in checks:
        con.execute(
            "INSERT INTO website_checks "
            "(url, status, http_status, final_url, final_domain, checked_at) VALUES (?,?,?,?,?,?)",
            [url, status, http, final, domain, now],
        )
    con.close()
    return db


REDIRECT = ("https://hallcapital.com/", "cross_domain_redirect", 200, "https://pathstone.com/", "pathstone.com")


@pytest.fixture
def researched(tmp_path, monkeypatch):
    """Point the module at a throwaway researched list."""
    path = tmp_path / "researched.json"

    def write(firms):
        path.write_text(json.dumps({"firms": firms}))
        monkeypatch.setattr(website_check, "RESEARCHED_PATH", path)

    return write


def test_export_marks_redirects_and_research(tmp_path, researched):
    researched({"2": {"name": "VANGUARD", "url": "https://investor.vanguard.com/"}})
    out = tmp_path / "overrides.json"
    assert website_check.export_overrides(_make_db(tmp_path, [REDIRECT]), out) is True

    firms = json.loads(out.read_text())["firms"]
    assert firms["1"] == {
        "filed": "https://hallcapital.com/",
        "resolved": "https://pathstone.com/",
        "domain": "pathstone.com",
        "via": "redirect",
    }
    assert firms["2"] == {
        "filed": "https://www.reddit.com/user/VanguardGroup/",
        "resolved": "https://investor.vanguard.com/",
        "domain": "investor.vanguard.com",
        "via": "research",
    }


def test_research_beats_a_redirect_for_the_same_firm(tmp_path, researched):
    # AP WEALTH's Yelp page redirects nowhere useful and the domain matching its
    # name belongs to an unrelated Asset Protection Group, so the researched
    # answer has to win outright rather than merge.
    checks = [
        REDIRECT,
        (
            "https://www.yelp.com/biz/ap-wealth-management-augusta",
            "cross_domain_redirect",
            200,
            "https://apwealthmanagement.com/",
            "apwealthmanagement.com",
        ),
    ]
    researched({"3": {"name": "AP WEALTH", "url": "https://apwealth.com/"}})
    out = tmp_path / "overrides.json"
    website_check.export_overrides(_make_db(tmp_path, checks), out)

    entry = json.loads(out.read_text())["firms"]["3"]
    assert entry["resolved"] == "https://apwealth.com/"
    assert entry["via"] == "research"


def test_export_skips_a_firm_that_left_the_data(tmp_path, researched):
    researched({"999": {"name": "GONE", "url": "https://gone.example/"}})
    out = tmp_path / "overrides.json"
    website_check.export_overrides(_make_db(tmp_path, [REDIRECT]), out)
    assert "999" not in json.loads(out.read_text())["firms"]


def test_export_leaves_the_file_alone_when_nothing_was_crawled(tmp_path, researched):
    # A CI run that exports without crawling must not replace hundreds of
    # redirect entries with the researched list alone.
    researched({"2": {"name": "VANGUARD", "url": "https://investor.vanguard.com/"}})
    out = tmp_path / "overrides.json"
    out.write_text('{"firms":{"1":{"kept":true}}}')

    assert website_check.export_overrides(_make_db(tmp_path, []), out) is False
    assert json.loads(out.read_text()) == {"firms": {"1": {"kept": True}}}


def test_shipped_researched_list_is_well_formed():
    doc = json.loads(website_check.RESEARCHED_PATH.read_text())
    assert doc["_note"], "the provenance note is the point of the file"
    for crd, entry in doc["firms"].items():
        assert crd.isdigit(), crd
        assert entry["url"].startswith("https://"), entry
        # A name-guessed domain is how an earlier pass produced a porn site for
        # a $43B adviser; every entry here has to be a real, reachable host.
        assert website_check.norm_domain(entry["url"]), entry
        assert not website_check.NON_FIRM.search(website_check.norm_domain(entry["url"])), entry


@pytest.mark.parametrize(
    "code,start,final,expected",
    [
        (403, "a.com", "a.com", "blocked_by_site"),
        (404, "a.com", "a.com", "not_found"),
        (200, "hallcapital.com", "pathstone.com", "cross_domain_redirect"),
        (200, "a.com", "www2.a.com", "ok"),
    ],
)
def test_classify(code, start, final, expected):
    assert website_check.classify(code, start, final) == expected
