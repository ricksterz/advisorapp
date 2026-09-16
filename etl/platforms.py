"""Which web hosts are platforms rather than a firm's own website.

One list, shared by ingest (choosing which filed address is the firm's site)
and the website crawl (refusing to "fix" a link by redirecting it onto
another platform). There used to be two lists, one in each module, and they
drifted: ingest screened linkedin/facebook/youtube but not WeChat, while the
crawl screened Yelp and Medium but not Amazon Music. BLACKROCK FUND ADVISORS
filed fifteen addresses including blackrock.com and was shown as a WeChat
account, because WeChat happened to be listed first and neither list had it.

Built from the filings, not from memory: every registrable domain that
appears in more than a handful of unrelated firms' Item 1.I lists was
reviewed, and the ones that are social networks, podcast hosts, app stores,
review sites, messaging apps, blogs, link-in-bio pages, or adviser
directories are here. Shared parent-company domains (blackstone.com,
morganstanley.com, focusfinancialpartners.com) also recur across firms but
are real firm websites and are deliberately absent.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

# Registrable domains (eTLD+1). A host matches if it IS one of these or is a
# subdomain of one, so blackstone.podbean.com and podcasts.apple.com are both
# caught without listing every subdomain.
PLATFORM_DOMAINS = frozenset(
    {
        # social networks
        "linkedin.com", "facebook.com", "fb.com", "fb.me", "instagram.com",
        "instragram.com",  # misspelling filed by several firms
        "twitter.com", "x.com", "t.co", "threads.net", "threads.com",
        "tiktok.com", "pinterest.com", "bsky.app", "bsky.social", "warpcast.com",
        "nextdoor.com", "alignable.com", "quora.com", "tumblr.com", "flickr.com",
        "stocktwits.com", "angel.co", "wellfound.com", "crunchbase.com",
        "glassdoor.com", "indeed.com",
        # video
        "youtube.com", "youtu.be", "vimeo.com", "wistia.com", "twitch.tv",
        # podcasts and audio
        "apple.com", "apple.co", "spotify.com", "spoti.fi", "soundcloud.com",
        "podbean.com", "libsyn.com", "buzzsprout.com", "anchor.fm", "player.fm",
        "podcastindex.org", "podcastaddict.com", "iheart.com", "pandora.com",
        "blubrry.net", "blubrry.com", "stitcher.com", "castbox.fm", "audible.com",
        "amazon.com",  # music.amazon.com podcast pages
        # blogs, newsletters, site builders' free hosting
        "medium.com", "substack.com", "wordpress.com", "blogspot.com",
        "blogger.com", "wixsite.com", "weebly.com", "godaddysites.com",
        "squarespace.com", "notion.site", "slideshare.net", "seekingalpha.com",
        # messaging and regional social apps
        "qq.com",  # mp.weixin.qq.com WeChat official accounts
        "weixin.qq.com", "weibo.com", "douyin.com", "line.me", "naver.com",
        "naver.jp", "kakao.com", "t.me", "telegram.org", "whatsapp.com",
        "wa.me", "discord.gg", "discord.com",
        # link-in-bio, maps, search
        "linktr.ee", "bio.link", "google.com", "g.page", "goo.gl",
        "yelp.com", "bing.com", "bit.ly",
        # adviser directories and profile listings
        "feeonlynetwork.com", "napfa.org", "wealthtender.com",
        "xyplanningnetwork.com", "smartasset.com", "wiseradvisor.com",
        "brokercheck.finra.org", "finra.org", "sec.gov", "zoominfo.com",
        "bloomberg.com", "calendly.com",
    }
)

# Brands that run regional domains (pinterest.ca, amazon.co.uk, google.com.au,
# yelp.ca). Matched on the registrable label so every country TLD is caught
# without listing each one. Exact label only: appleseedplanner.com's label is
# "appleseedplanner", not "apple".
PLATFORM_LABELS = frozenset(
    {
        "linkedin", "facebook", "instagram", "twitter", "youtube", "tiktok",
        "pinterest", "yelp", "amazon", "google", "apple", "spotify", "medium",
        "reddit", "vimeo", "naver", "glassdoor", "indeed", "bloomberg",
    }
)

MULTI_PART_TLDS = {"co", "com", "org", "net", "gov", "ac", "ne", "or"}

_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")


def host_of(url: str) -> str:
    """Lowercased hostname without www., or "" when there isn't a usable one."""
    # Filers leave sentence punctuation on the end ("thinkpinnacle.com.",
    # "mjretirement.com,"); a trailing dot or comma is never part of a host.
    raw = (url or "").strip().rstrip(".,;:)")
    try:
        host = urlparse(raw if "://" in raw else "http://" + raw).hostname or ""
    except ValueError:
        return ""
    host = host.lower().removeprefix("www.")
    return host if _HOST_RE.match(host) else ""


def registrable(domain: str) -> str:
    """Crude eTLD+1 — enough to tell one company from another.

    Deliberately simple: a full public-suffix list would be more correct but
    the only decisions it feeds are "same company or not" and "is this a
    platform", where the common two-part suffixes (co.uk and friends) cover
    the real data.
    """
    parts = domain.split(".")
    if len(parts) < 3:
        return domain
    if parts[-2] in MULTI_PART_TLDS and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def is_platform(host: str) -> bool:
    host = (host or "").lower().removeprefix("www.")
    if not host:
        return False
    reg = registrable(host)
    if host in PLATFORM_DOMAINS or reg in PLATFORM_DOMAINS:
        return True
    if reg.split(".")[0] in PLATFORM_LABELS:
        return True
    # finra.org / sec.gov style: any listed domain as a suffix
    return any(host.endswith("." + d) for d in PLATFORM_DOMAINS)
