import json

import duckdb

from etl import favicons
from etl.config import SCHEMA_PATH

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


def test_placeholders_are_not_real_icons():
    # Both proxies send their "no icon" placeholder as a 404 with a valid PNG;
    # the status is the only thing that tells it apart from a logo.
    assert not favicons.is_real_icon(404, PNG)
    assert favicons.is_real_icon(200, PNG)


def test_truncated_or_non_image_bodies_are_not_real_icons():
    assert not favicons.is_real_icon(200, b"\x89PNG\r\n\x1a")  # franklintempleton.com: 8 bytes
    assert not favicons.is_real_icon(200, b"<html>" + b" " * 200)
    assert favicons.is_real_icon(200, b"\x00\x00\x01\x00" + b"\x00" * 100)  # ICO
    assert favicons.is_real_icon(200, b"<svg xmlns='http://www.w3.org/2000/svg'>" + b" " * 60)


def test_resolved_url_mirrors_the_frontend():
    overrides = {
        "1": {"filed": "https://hallcapital.com/", "resolved": "https://pathstone.com/", "via": "redirect"},
        "2": {"filed": None, "resolved": "https://www.maryandpip.com/", "via": "research"},
    }
    assert favicons.resolved_url(1, "https://hallcapital.com/", overrides) == "https://pathstone.com/"
    # a redirect measured on a URL the firm no longer lists doesn't apply
    assert favicons.resolved_url(1, "https://www.blackrock.com", overrides) == "https://www.blackrock.com"
    # research applies with no filed website at all
    assert favicons.resolved_url(2, None, overrides) == "https://www.maryandpip.com/"
    assert favicons.resolved_url(3, "https://acme.com", overrides) == "https://acme.com"


def test_site_hosts_are_the_hosts_the_page_renders(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute(
        "INSERT INTO firms (crd, legal_name, website_url) VALUES "
        "(1, 'HALL', 'https://hallcapital.com/'), (2, 'MARY & PIP', NULL), "
        "(3, 'BLACKROCK', 'HTTPS://WWW.BLACKROCK.COM'), (4, 'NO SITE', NULL)"
    )
    con.close()
    ov = tmp_path / "overrides.json"
    ov.write_text(json.dumps({"firms": {
        "1": {"filed": "https://hallcapital.com/", "resolved": "https://pathstone.com/", "via": "redirect"},
        "2": {"filed": None, "resolved": "https://www.maryandpip.com/", "via": "research"},
    }}))
    assert favicons.site_hosts(db, ov) == ["blackrock.com", "maryandpip.com", "pathstone.com"]


def test_icon_source_falls_back_to_google_then_none():
    class Resp:
        def __init__(self, status, body):
            self.status_code, self.content = status, body

    class Session:
        def __init__(self, ddg, google):
            self.answers = {"duckduckgo": ddg, "google": google}

        def get(self, url, **kw):
            return self.answers["duckduckgo" if "duckduckgo" in url else "google"]

    assert favicons.icon_source("a.com", Session(Resp(200, PNG), Resp(200, PNG))) == "duckduckgo"
    assert favicons.icon_source("troweprice.com", Session(Resp(404, PNG), Resp(200, PNG))) == "google"
    assert favicons.icon_source("x.com", Session(Resp(404, PNG), Resp(404, PNG))) is None


def test_export_lists_only_the_exceptions(tmp_path):
    out = tmp_path / "favicons.json"
    favicons.export({"blackrock.com": "duckduckgo", "troweprice.com": "google", "gone.com": None}, out)
    doc = json.loads(out.read_text())
    assert doc["google"] == ["troweprice.com"]
    assert doc["none"] == ["gone.com"]
    assert doc["checked"] == 3
