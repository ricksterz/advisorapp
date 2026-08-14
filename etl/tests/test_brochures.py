import json
from unittest.mock import patch

import duckdb
import pytest
import requests

from etl.brochures import find_flags, parse_brochure_response, stage_enumerate
from etl.config import SCHEMA_PATH


@pytest.fixture(autouse=True)
def _fast_crawl(monkeypatch):
    """Decouple the suite from the production politeness rate.

    REQUESTS_PER_SECOND is deliberately conservative against the SEC's
    published ceiling; leaving it in force made these tests sleep for seconds
    to prove logic that has nothing to do with pacing. The rate limiter's own
    test builds its own RateLimiter, so it is unaffected by this.
    """
    monkeypatch.setattr("etl.brochures.REQUESTS_PER_SECOND", 1000.0)


def test_parse_brochure_response():
    payload = {
        "hits": {
            "hits": [
                {
                    "_source": {
                        "iacontent": (
                            '{"brochures": {"brochuredetails": ['
                            '{"brochureVersionID": 111, "brochureName": "ADV 2A", "dateSubmitted": "3/31/2026"},'
                            '{"brochureVersionID": 222, "brochureName": "WRAP", "dateSubmitted": "1/2/2026"}]}}'
                        )
                    }
                }
            ]
        }
    }
    parsed = parse_brochure_response(payload)
    assert [b["version_id"] for b in parsed] == [111, 222]
    assert parsed[0]["date_submitted"] == "3/31/2026"

    # firms without brochures, and malformed payloads, yield []
    assert parse_brochure_response({"hits": {"hits": []}}) == []
    assert parse_brochure_response({"hits": {"hits": [{"_source": {"iacontent": "{}"}}]}}) == []
    assert parse_brochure_response({}) == []


def test_find_flags_matches_each_category_with_snippets():
    text = """
    Item 10: Other Financial Industry Activities. An affiliate of the Adviser
    serves as the general partner of certain private funds.

    Item 11: Code of Ethics. The Firm may invest client assets in funds managed
    by the Firm or its affiliates, which creates a conflict of interest.

    Item 14: Client Referrals. The Adviser pays referral fees to third-party
    solicitors for introducing new clients.
    """
    flags = find_flags(text)
    assert set(flags) == {"proprietary_funds", "revenue_sharing", "affiliated_gp_lp"}
    # each flag carries an auditable snippet around the match
    assert "general partner" in flags["affiliated_gp_lp"]
    assert "referral fee" in flags["revenue_sharing"]
    assert "client assets in funds managed" in flags["proprietary_funds"]


def test_find_flags_ignores_negated_disclaimers():
    # Real false positives from the first full-universe run: disclaimers and
    # Item 14 headings followed by a negation must not flag.
    text = """
    The Adviser does not act as principal in any transactions. In addition,
    the Adviser does not act as the general partner of a fund, or advise an
    investment company.

    Compensation for Client Referrals: The Advisor does not compensate,
    either directly or indirectly, any person for client referrals.
    """
    assert find_flags(text) == {}


def test_find_flags_ignores_contraction_negation():
    # A later full-universe sampling pass found this real false positive:
    # "don't" (and doesn't/won't/etc.) isn't "not", so it needs its own check.
    text = "We don't take commission, referral fees, or other remuneration from our partners."
    assert find_flags(text) == {}


def test_find_flags_affirmative_match_after_a_disclaimer_still_counts():
    text = """
    The Adviser does not receive commissions. However, an affiliate of the
    Adviser serves as the general partner of several private funds organized
    as limited partnerships.
    """
    assert set(find_flags(text)) == {"affiliated_gp_lp"}


def test_find_flags_ignores_toc_entries():
    # Real false positives sampled from the full-universe corpus: a brochure's
    # table of contents repeats section headings as trigger phrases, followed
    # by a dot leader and page number — pypdf extracts this inline with body
    # text, so it reads like a real disclosure unless filtered.
    text = """
    Table of Contents
    Item 10 Other Financial Industry Activities and Affiliations..............8
    12B-1 Fees and Sales Commissions....................................10
    Compensation for Client Referrals ...............................................24
    The Firm provides investment management services to individual clients.
    """
    assert find_flags(text) == {}


def test_find_flags_ignores_underscore_leader_toc_entries():
    # A second full-universe sampling pass found this: some PDFs render a
    # table-of-contents dot leader as underscores instead of periods.
    text = """
    CLIENT REFERRALS AND OTHER COMPENSATION _______________________________ 70
    A. Compensation for Client Referrals ________________________________ 70
    The Firm provides investment management services to individual clients.
    """
    assert find_flags(text) == {}


def test_find_flags_weak_12b1_trigger_requires_attribution():
    # Sampled from the corpus: "12b-1 fee" alone matches generic mutual-fund
    # cost boilerplate that never says the adviser (or a related person)
    # actually receives anything.
    boilerplate = """
    Your mutual fund investments may be subject to early redemption fees,
    12b-1 fees and mutual fund management fees as well as other mutual fund
    expenses. These fees, called 12b-1 fees, pay for marketing and
    distribution expenses, such as brokers' commissions.
    """
    assert find_flags(boilerplate) == {}

    genuine = """
    Associated persons of the Firm can receive revenue sharing or 12b-1
    distribution fees from the investment companies chosen by the plan
    sponsor.
    """
    assert set(find_flags(genuine)) == {"revenue_sharing"}


def test_find_flags_strong_revenue_sharing_triggers_stay_ungated():
    # The stronger revenue_sharing triggers (referral fee, revenue-shar*,
    # compensation-for-referrals, solicitation arrangements) don't require
    # the attribution check — only the weak bare "12b-1 fee" trigger does.
    text = "Our firm receives referral fees from unaffiliated third-party managers."
    assert set(find_flags(text)) == {"revenue_sharing"}


def test_find_flags_clean_brochure_stays_clean():
    text = """
    The Firm provides discretionary investment management to individuals and
    charges an annual fee based on assets under management. The Firm does not
    sell securities, receives no commissions, and has no other industry
    affiliations. Brokerage is directed to an unaffiliated custodian.
    """
    assert find_flags(text) == {}


def _db_with_firms(tmp_path, crds):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    for crd in crds:
        con.execute("INSERT INTO firms (crd, legal_name) VALUES (?, ?)", [crd, f"FIRM {crd}"])
    return con


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _payload_with_brochure(version_id):
    return {
        "hits": {
            "hits": [
                {
                    "_source": {
                        "iacontent": json.dumps(
                            {
                                "brochures": {
                                    "brochuredetails": [
                                        {
                                            "brochureVersionID": version_id,
                                            "brochureName": "ADV 2A",
                                            "dateSubmitted": "1/1/2026",
                                        }
                                    ]
                                }
                            }
                        )
                    }
                }
            ]
        }
    }


def test_stage_enumerate_default_skips_already_known_firms(tmp_path):
    con = _db_with_firms(tmp_path, [1, 2])
    con.execute("INSERT INTO brochures (version_id, firm_crd) VALUES (100, 1)")  # firm 1 already seen
    calls = []

    def fake_get(self, url, headers=None, timeout=None):
        calls.append(url)
        return _FakeResponse(_payload_with_brochure(999))

    with patch("etl.brochures.requests.Session.get", fake_get):
        stage_enumerate(con, limit=None)

    assert len(calls) == 1  # only the unenumerated firm (2) was queried
    assert calls[0].endswith("/2")


def test_stage_enumerate_rescan_rechecks_every_firm(tmp_path):
    # A firm's brochure inventory changes over time (amendments, new filings);
    # the default incremental behavior would never notice, since it only
    # queries firms with zero rows in `brochures`. --rescan exists to fix
    # exactly this staleness on a periodic data refresh.
    con = _db_with_firms(tmp_path, [1, 2])
    con.execute("INSERT INTO brochures (version_id, firm_crd) VALUES (100, 1)")
    calls = []

    def fake_get(self, url, headers=None, timeout=None):
        calls.append(url)
        return _FakeResponse(_payload_with_brochure(999))

    with patch("etl.brochures.requests.Session.get", fake_get):
        stage_enumerate(con, limit=None, rescan=True)

    assert len(calls) == 2  # both firms re-checked, including the known one


# ---------------------------------------------------------------------------
# Concurrency + rate limiting
# ---------------------------------------------------------------------------


def test_rate_limiter_enforces_the_aggregate_rate_across_threads():
    """The SEC's ceiling is per user, not per connection — a limiter that
    throttled each thread independently would let N workers run at N x the
    intended rate, which is exactly how you get IP-throttled."""
    import threading as _threading
    import time as _time

    from etl.brochures import RateLimiter

    limiter = RateLimiter(per_second=50.0)  # 20ms apart
    stamps = []
    lock = _threading.Lock()

    def worker():
        for _ in range(5):
            limiter.acquire()
            with lock:
                stamps.append(_time.monotonic())

    threads = [_threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(stamps) == 20
    stamps.sort()
    elapsed = stamps[-1] - stamps[0]
    # 20 requests at 50/s must span at least ~19 intervals, regardless of the
    # fact that four threads issued them.
    assert elapsed >= 19 * 0.02 * 0.9, f"aggregate rate exceeded: 20 reqs in {elapsed:.3f}s"


def test_stage_enumerate_writes_every_firms_rows_under_concurrency(tmp_path):
    con = _db_with_firms(tmp_path, list(range(1, 13)))

    def fake_get(self, url, headers=None, timeout=None):
        crd = int(url.rsplit("/", 1)[1])
        return _FakeResponse(_payload_with_brochure(1000 + crd))

    with patch("etl.brochures.requests.Session.get", fake_get):
        stage_enumerate(con, limit=None, rescan=True)

    rows = con.execute("SELECT firm_crd, version_id FROM brochures ORDER BY firm_crd").fetchall()
    # one row per firm, each with its own version_id — no interleaving damage
    assert rows == [(crd, 1000 + crd) for crd in range(1, 13)]


def test_stage_enumerate_leaves_failed_firms_unenumerated(tmp_path):
    """A failure must not write a no-brochure sentinel, or the next run would
    treat a transient error as 'this firm has no brochures'."""
    con = _db_with_firms(tmp_path, [1, 2, 3])

    def fake_get(self, url, headers=None, timeout=None):
        if url.endswith("/2"):
            raise requests.RequestException("boom")
        crd = int(url.rsplit("/", 1)[1])
        return _FakeResponse(_payload_with_brochure(1000 + crd))

    with patch("etl.brochures.requests.Session.get", fake_get):
        stage_enumerate(con, limit=None, rescan=True)

    seen = {r[0] for r in con.execute("SELECT DISTINCT firm_crd FROM brochures").fetchall()}
    assert seen == {1, 3}


def test_stage_enumerate_aborts_when_every_request_fails(tmp_path):
    """Guards against silently wiping a refresh when the API blocks us."""
    con = _db_with_firms(tmp_path, list(range(1, 40)))

    def fake_get(self, url, headers=None, timeout=None):
        raise requests.RequestException("blocked")

    with patch("etl.brochures.requests.Session.get", fake_get), pytest.raises(SystemExit) as exc:
        stage_enumerate(con, limit=None, rescan=True)
    assert "aborting enumerate" in str(exc.value)


def test_stage_enumerate_records_a_sentinel_for_brochure_free_firms(tmp_path):
    con = _db_with_firms(tmp_path, [7])

    def fake_get(self, url, headers=None, timeout=None):
        return _FakeResponse({"hits": {"hits": []}})

    with patch("etl.brochures.requests.Session.get", fake_get):
        stage_enumerate(con, limit=None, rescan=True)

    assert con.execute("SELECT version_id FROM brochures").fetchall() == [(-7,)]
