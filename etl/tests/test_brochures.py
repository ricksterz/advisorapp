from etl.brochures import find_flags, parse_brochure_response


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


def test_find_flags_affirmative_match_after_a_disclaimer_still_counts():
    text = """
    The Adviser does not receive commissions. However, an affiliate of the
    Adviser serves as the general partner of several private funds organized
    as limited partnerships.
    """
    assert set(find_flags(text)) == {"affiliated_gp_lp"}


def test_find_flags_clean_brochure_stays_clean():
    text = """
    The Firm provides discretionary investment management to individuals and
    charges an annual fee based on assets under management. The Firm does not
    sell securities, receives no commissions, and has no other industry
    affiliations. Brokerage is directed to an unaffiliated custodian.
    """
    assert find_flags(text) == {}
