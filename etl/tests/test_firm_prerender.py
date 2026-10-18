import json

from etl import firm_prerender as fp
from etl.gen_static_pages import ROOT_DIV, render_firm

PATHSTONE = {
    "crd": 151736,
    "business_name": "PATHSTONE",
    "legal_name": "PATHSTONE FAMILY OFFICE, LLC",
    "state": "NJ",
    "country": "United States",
    "aum_mix": [83, 0, 10, 7],
    "aum_total": 110_000_000_000,
    "aum_discretionary": 65_000_000_000,
    "employees_total": 704,
    "employees_advisory": 365,
    "accounts_total": 27165,
    "fee_pct_of_aum": True,
    "fee_performance_based": True,
    "affil_count": 4,
    "disciplinary_flag_count": 1,
}

EXTRAS = {
    "growth": {
        "rank_floor": 1e8,
        "firms": {"151736": {"a10": 55.2, "r10": 100, "a5": 9.8, "r5": 99}},
    },
    "holdings": {
        "filers": {"0001": {"name": "PATHSTONE", "positions": 1200, "value": 9.5e9, "values_reliable": True,
                            "top": [{"issuer": "APPLE INC"}, {"issuer": "MICROSOFT CORP"}]}},
        "firms": {"151736": {"cik": "0001", "own": True}},
    },
    "fund_types": {"firms": {}},
}


def test_description_matches_the_frontend():
    # Same text as frontend/src/firmDescription.test.js.
    assert fp.description(PATHSTONE) == (
        "PATHSTONE (CRD 151736, NJ): wealth manager with $110B in regulatory AUM, 704 employees, "
        "1 disciplinary disclosure. Fees, client mix, staffing and growth from SEC Form ADV filings."
    )


def test_money_and_multiples_match_the_frontend_formatters():
    assert [fp.fmt_usd(v) for v in (2.4e12, 1.5e10, 5.78e8, 4.2e9, 3.1e6, 950)] == [
        "$2.4T", "$15B", "$578M", "$4.2B", "$3.1M", "$950",
    ]
    assert [fp.fmt_multiple(m) for m in (55.2, 2.4, 1.23, 1.0, 0.8)] == ["55×", "2.4×", "+23%", "unchanged", "−20%"]


def test_segment_needs_a_majority():
    assert fp.segment(PATHSTONE)[0] == "wealth"
    assert fp.segment({"aum_mix": [40, 30, 20, 10]})[0] == "mixed"
    assert fp.segment({}) is None


def test_body_summarizes_the_filing():
    out = fp.body(PATHSTONE, EXTRAS)
    assert out.startswith('<div id="prerender">') and out.endswith("</div>")
    assert "<h1>PATHSTONE</h1>" in out
    assert "PATHSTONE FAMILY OFFICE, LLC · CRD 151736 · NJ" in out
    assert "Wealth manager" in out and "$110B" in out and "59% discretionary" in out
    assert "Family-office style" in out  # "family office" in the legal name
    assert "365 advisory · 339 non-advisory" in out
    assert "faster than 99% of wealth managers that started above $100M" in out  # capped at 99
    assert "1,200 positions worth $9.5B. Largest: APPLE INC, MICROSOFT CORP." in out
    assert "adviserinfo.sec.gov/firm/summary/151736" in out


def test_body_escapes_firm_names_and_works_without_extras():
    firm = {"crd": 1, "legal_name": 'A&B <script>"x"</script>', "aum_total": 5e8}
    out = fp.body(firm, {})
    assert "<script>" not in out and "A&amp;B &lt;script&gt;" in out


def test_jsonld_is_valid_and_cannot_close_its_script_tag():
    tag = fp.jsonld({**PATHSTONE, "legal_name": "X </script> Y"}, "https://open-disclosure.com")
    inner = tag.removeprefix('<script type="application/ld+json">').removesuffix("</script>")
    assert "</script>" not in inner
    data = json.loads(inner)
    assert data["identifier"]["value"] == "151736"
    assert data["sameAs"] == ["https://adviserinfo.sec.gov/firm/summary/151736"]
    assert data["address"] == {"@type": "PostalAddress", "addressRegion": "NJ", "addressCountry": "United States"}


def test_render_firm_places_summary_after_the_root_and_jsonld_in_the_head():
    template = f"<html><head><title>T</title></head><body>{ROOT_DIV}</body></html>"
    # render() needs the real head tags; exercise only the two insertions here.
    page = template.replace("</head>", "x</head>")
    from etl import gen_static_pages

    original = gen_static_pages.render
    gen_static_pages.render = lambda t, **_: t
    try:
        out = render_firm(page, PATHSTONE, "https://open-disclosure.com", EXTRAS)
    finally:
        gen_static_pages.render = original
    head, body = out.split("</head>")
    assert 'application/ld+json' in head
    assert body.index(ROOT_DIV) < body.index('id="prerender"')
