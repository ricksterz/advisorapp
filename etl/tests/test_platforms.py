import pytest

from etl.platforms import host_of, is_platform, registrable


@pytest.mark.parametrize(
    "host",
    [
        "mp.weixin.qq.com",  # BLACKROCK FUND ADVISORS' "website"
        "music.amazon.com",  # ALLSPRING FUNDS MANAGEMENT's
        "blog.naver.com",  # ALLIANCEBERNSTEIN's
        "line.naver.jp",
        "blackstone.podbean.com",
        "podcasts.apple.com",
        "pinterest.ca",  # regional TLD of a listed brand
        "amazon.co.uk",
        "www.linkedin.com",
        "brokercheck.finra.org",
        "linktr.ee",
    ],
)
def test_platforms_are_recognized(host):
    assert is_platform(host)


@pytest.mark.parametrize(
    "host",
    [
        "blackrock.com",
        "blackstone.com",  # shared by many affiliates, but a real firm site
        "focusfinancialpartners.com",
        "appleseedplanner.com",  # contains a brand name, is not that brand
        "googinsadvisors.com",
        "",
    ],
)
def test_firm_sites_are_not_platforms(host):
    assert not is_platform(host)


def test_host_of_strips_trailing_punctuation_and_rejects_junk():
    assert host_of("https://www.thinkpinnacle.com.") == "thinkpinnacle.com"
    assert host_of("HTTPS://MJRETIREMENT.COM,") == "mjretirement.com"
    assert host_of("http://-phelps-investment-management-co./") == ""
    assert host_of("share_url=https%3A%2F%2Fwww.") == ""


def test_registrable_handles_two_part_suffixes():
    assert registrable("hamiltonlane.com.au") == "hamiltonlane.com.au"
    assert registrable("wisdom.edwardjones.com") == "edwardjones.com"
    assert registrable("my.lba.ca") == "lba.ca"
