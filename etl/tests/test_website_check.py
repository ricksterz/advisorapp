import json
from datetime import datetime, timezone

import duckdb
import pytest
import requests

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


class _FakeResponse:
    def __init__(self, status_code, url):
        self.status_code = status_code
        self.url = url

    def close(self):
        pass


class _FakeSession:
    """Records every (method, verify) pair and fails TLS until asked not to."""

    def __init__(self, ssl_fails=True, status=200, final=None):
        self.calls = []
        self.ssl_fails = ssl_fails
        self.status = status
        self.final = final

    def request(self, method, url, **kw):
        self.calls.append((method, kw["verify"]))
        if kw["verify"] and self.ssl_fails:
            raise requests.exceptions.SSLError("expired")
        return _FakeResponse(self.status, self.final or url)



def test_check_url_verifies_tls_first():
    s = _FakeSession(ssl_fails=False)
    out = website_check.check_url("https://good.example/", lambda: s)
    assert s.calls == [("head", True)]
    assert out["status"] == "ok"
    assert "error" not in out


def test_check_url_retries_unverified_only_after_a_cert_failure():
    # An expired certificate should be reported as an expired certificate, not
    # as a dead host — plenty of stale firm sites still serve fine over it.
    s = _FakeSession(ssl_fails=True)
    out = website_check.check_url("https://expired.example/", lambda: s)
    assert s.calls == [("head", True), ("head", False)]
    assert out["status"] == "ok"
    assert out["error"] == "bad_cert"


def test_check_url_does_not_drop_verification_for_other_failures():
    class Timeouts(_FakeSession):
        def request(self, method, url, **kw):
            self.calls.append((method, kw["verify"]))
            raise requests.exceptions.ConnectTimeout("nope")

    s = Timeouts()
    out = website_check.check_url("https://gone.example/", lambda: s)
    assert s.calls == [("head", True), ("get", True)]
    assert out["status"] == "unreachable"
    assert out["error"] == "connect_timeout"


def test_is_transient_only_flags_a_missing_verdict():
    assert website_check.is_transient({"status": "unreachable", "error": "ssl"})
    assert website_check.is_transient({"status": "server_error", "http": 503})
    # Real answers, however unwelcome, are answers.
    assert not website_check.is_transient({"status": "not_found", "http": 404})
    assert not website_check.is_transient({"status": "blocked_by_site", "http": 403})
    assert not website_check.is_transient({"status": "server_error", "http": 500})
    assert not website_check.is_transient({"status": "ok", "http": 200})


def test_retry_replaces_only_the_rows_that_recover(monkeypatch):
    # nvestfinancial.com is the real case: 'unreachable/ssl' under 16 workers,
    # 200 on every serial attempt right after, which cost it a live override.
    rows = [
        {"url": "https://ok.example/", "status": "ok", "http": 200},
        {"url": "https://flaky.example/", "status": "unreachable", "error": "ssl"},
        {"url": "https://dead.example/", "status": "unreachable", "error": "dns"},
    ]
    seen = []

    def fake_check(url, _session, timeout=None):
        seen.append((url, timeout))
        if url == "https://flaky.example/":
            return {"url": url, "status": "cross_domain_redirect", "http": 200}
        return {"url": url, "status": "unreachable", "error": "dns"}

    monkeypatch.setattr(website_check, "check_url", fake_check)
    out, recovered = website_check.retry_transient(rows, lambda: None)

    assert recovered == 1
    assert [u for u, _ in seen] == ["https://flaky.example/", "https://dead.example/"]
    assert all(t == website_check.RETRY_TIMEOUT for _, t in seen), "retry should be more patient"
    assert out[0] == rows[0], "a healthy row is left untouched"
    assert out[1]["status"] == "cross_domain_redirect"
    assert out[2] == rows[2], "a retry that fails again must not overwrite the original"


def test_retry_is_a_no_op_when_everything_answered(monkeypatch):
    monkeypatch.setattr(
        website_check, "check_url", lambda *a, **k: pytest.fail("must not re-check")
    )
    rows = [{"url": "https://ok.example/", "status": "ok", "http": 200}]
    assert website_check.retry_transient(rows, lambda: None) == (rows, 0)


def test_retry_stage_stores_only_recoveries(tmp_path, monkeypatch):
    db = _make_db(tmp_path, [REDIRECT, ("https://flaky.example/", "unreachable", None, None, None)])
    monkeypatch.setattr(
        website_check,
        "check_url",
        lambda url, *a, **k: {
            "url": url, "status": "ok", "http": 200,
            "final_url": url, "final_domain": "flaky.example",
        },
    )
    con = duckdb.connect(str(db))
    website_check.stage_retry(con)
    got = con.execute(
        "SELECT status, http_status FROM website_checks WHERE url = 'https://flaky.example/'"
    ).fetchone()
    # The redirect row was never transient, so it must be untouched.
    assert con.execute(
        "SELECT status FROM website_checks WHERE url = ?", [REDIRECT[0]]
    ).fetchone()[0] == "cross_domain_redirect"
    con.close()
    assert got == ("ok", 200)
