"""Visible firm content and structured data for each pre-rendered firm page.

gen_static_pages used to template only the <head>: a firm URL served the
right title and canonical but an empty body, so everything a reader or a
crawler could learn about the firm arrived only after ~1.5 MB of JavaScript
and data loaded. This renders the facts that identify and summarize a firm
into the HTML itself:

  * a summary block placed beside the React root (#prerender), using the
    site's own classes so it looks like the page it stands in for. The app
    removes it once the full page has rendered (App.jsx), and leaves it in
    place if the data never loads.
  * schema.org JSON-LD (FinancialService) with the CRD as an identifier and
    the SEC's IAPD page as sameAs.
  * a meta description with the firm's actual numbers.

Every figure is computed the way the frontend computes it (business model
from aum_mix, money formatting, non-advisory staff), and the description
mirrors usePageMeta in FirmDetail.jsx, so the served and hydrated pages
agree. Stdlib only: this runs on the Cloudflare build image's stock python3.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

# Order of firms.json's aum_mix, and the labels frontend/src/segments.js shows.
SEGMENTS = [
    ("wealth", "Wealth manager", "wealth managers"),
    ("registered_funds", "Registered fund manager", "registered fund managers"),
    ("private_funds", "Private fund manager", "private fund managers"),
    ("institutional", "Institutional manager", "institutional managers"),
]
MIXED = ("mixed", "Mixed client base", "firms with a mixed client base")

FUND_TYPE_LABELS = {
    "hedge": "Hedge funds",
    "private_equity": "Private equity",
    "venture": "Venture capital",
    "real_estate": "Real estate",
    "securitized": "Securitized credit",
    "liquidity": "Liquidity funds",
    "other": "Other private funds",
    "mixed": "Several fund types",
}

# Mirrors isFamilyOfficeStyle in frontend/src/segments.js and familyOffice.js.
FAMILY_OFFICE_NAME = re.compile(r"\bfamily\s+offices?\b", re.IGNORECASE)
FAMILY_OFFICE_CLIENT_AUM = 25e6

IAPD_URL = "https://adviserinfo.sec.gov/firm/summary/{crd}"
TOP_HOLDINGS = 5


def esc(text) -> str:
    return html.escape(str(text), quote=True)


def fmt_usd(v) -> str:
    """Mirror of fmtCompactUsd in frontend/src/pulse.js."""
    if v is None:
        return "—"
    if v >= 1e12:
        return f"${v / 1e12:.1f}T"
    if v >= 1e9:
        return f"${v / 1e9:.0f}B" if v >= 1e10 else f"${v / 1e9:.1f}B"
    if v >= 1e6:
        return f"${v / 1e6:.0f}M" if v >= 1e7 else f"${v / 1e6:.1f}M"
    return f"${round(v):,}"


def fmt_count(v) -> str:
    return "—" if v is None else f"{round(v):,}"


def fmt_multiple(m: float) -> str:
    """Mirror of fmtMultiple in frontend/src/trajectory.js."""
    if m >= 2:
        return f"{round(m)}×" if m >= 10 else f"{m:.1f}×"
    pct = round((m - 1) * 100)
    if pct == 0:
        return "unchanged"
    return f"+{pct}%" if pct > 0 else f"−{abs(pct)}%"


def segment(firm: dict) -> tuple[str, str, str] | None:
    """Mirror of firmSegment in frontend/src/segments.js."""
    mix = firm.get("aum_mix")
    if not mix:
        return None
    best = max(range(len(SEGMENTS)), key=lambda i: mix[i])
    return SEGMENTS[best] if mix[best] > 50 else MIXED


def non_advisory(firm: dict) -> int | None:
    total, advisory = firm.get("employees_total"), firm.get("employees_advisory")
    if total is None or advisory is None or advisory > total:
        return None
    return round(total - advisory)


def name_of(firm: dict) -> str:
    return firm.get("business_name") or firm.get("legal_name") or f"CRD {firm['crd']}"


def load_extras(directory: Path) -> dict:
    """The committed per-firm files the summary draws on; any may be absent
    (the dev fixture build has none of them)."""

    def read(name: str):
        path = directory / name
        return json.loads(path.read_text()) if path.exists() else None

    return {
        "growth": read("firm_growth.json"),
        "holdings": read("form_13f.json"),
        "fund_types": read("firm_fund_types.json"),
    }


def _growth_sentence(firm: dict, extras: dict) -> str | None:
    growth = extras.get("growth") or {}
    entry = (growth.get("firms") or {}).get(str(firm["crd"]))
    seg = segment(firm)
    if not entry:
        return None
    for period in (10, 5, 3):
        multiple = entry.get(f"a{period}")
        if multiple is None:
            continue
        text = f"Over the last {period} years, regulatory AUM grew {fmt_multiple(multiple)}"
        rank = entry.get(f"r{period}")
        if rank is not None and seg:
            floor = round((growth.get("rank_floor") or 1e8) / 1e6)
            text += f", faster than {max(1, min(99, rank))}% of {seg[2]} that started above ${floor}M"
        return text + "."
    return None


def _holdings(firm: dict, extras: dict) -> tuple[str, list[str]] | None:
    data = extras.get("holdings") or {}
    entry = (data.get("firms") or {}).get(str(firm["crd"]))
    filer = entry and (data.get("filers") or {}).get(entry["cik"])
    if not filer:
        return None
    if not entry.get("own"):
        return (f"Reported within {filer['name']}’s combined 13F filing.", [])
    value = fmt_usd(filer["value"]) if filer.get("values_reliable") else None
    lead = f"{filer['positions']:,} positions" + (f" worth {value}" if value else "")
    return (lead, [h["issuer"] for h in filer.get("top", [])[:TOP_HOLDINGS]])


def description(firm: dict) -> str:
    """Meta description with the firm's own numbers. Mirrors usePageMeta."""
    name = name_of(firm)
    where = f", {firm['state']}" if firm.get("state") else ""
    seg = segment(firm)
    kind = f"{seg[1].lower()} with " if seg else ""
    facts = [f"{kind}{fmt_usd(firm.get('aum_total'))} in regulatory AUM"]
    if firm.get("employees_total") is not None:
        facts.append(f"{fmt_count(firm['employees_total'])} employees")
    disclosures = firm.get("disciplinary_flag_count") or 0
    facts.append(f"{disclosures} disciplinary disclosure{'' if disclosures == 1 else 's'}")
    return (
        f"{name} (CRD {firm['crd']}{where}): {', '.join(facts)}. Fees, client mix, "
        "staffing and growth from SEC Form ADV filings."
    )


def jsonld(firm: dict, site: str) -> str:
    data = {
        "@context": "https://schema.org",
        "@type": "FinancialService",
        "name": name_of(firm),
        "legalName": firm.get("legal_name"),
        "url": f"{site}/firm/{firm['crd']}",
        "identifier": {"@type": "PropertyValue", "propertyID": "CRD", "value": str(firm["crd"])},
        "sameAs": [IAPD_URL.format(crd=firm["crd"])],
    }
    if firm.get("state") or firm.get("country"):
        address = {"@type": "PostalAddress"}
        if firm.get("state"):
            address["addressRegion"] = firm["state"]
        if firm.get("country"):
            address["addressCountry"] = firm["country"]
        data["address"] = address
    if firm.get("employees_total") is not None:
        data["numberOfEmployees"] = {"@type": "QuantitativeValue", "value": firm["employees_total"]}
    # "</" can't appear inside a <script> block, whatever a firm is called.
    body = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json">{body}</script>'


def _tile(label: str, value: str, sub: str | None = None) -> str:
    sub_html = f'<div class="sub">{esc(sub)}</div>' if sub else ""
    return f'<div class="tile"><div class="label">{esc(label)}</div><div class="value">{esc(value)}</div>{sub_html}</div>'


def body(firm: dict, extras: dict) -> str:
    """The summary block shown until the app renders the full page."""
    crd = firm["crd"]
    name = name_of(firm)
    sub = []
    if firm.get("business_name") and firm.get("legal_name") and firm["business_name"] != firm["legal_name"]:
        sub.append(firm["legal_name"])
    sub.append(f"CRD {crd}")
    if firm.get("state"):
        sub.append(firm["state"])
    elif firm.get("country"):
        sub.append(firm["country"])

    seg = segment(firm)
    tags = []
    fund_type = ((extras.get("fund_types") or {}).get("firms") or {}).get(str(crd))
    if seg and seg[0] == "private_funds" and fund_type in FUND_TYPE_LABELS:
        tags.append(FUND_TYPE_LABELS[fund_type])
    named = any(FAMILY_OFFICE_NAME.search(firm.get(k) or "") for k in ("legal_name", "business_name"))
    big_clients = seg and seg[0] == "wealth" and (firm.get("aum_per_hnw_client") or 0) >= FAMILY_OFFICE_CLIENT_AUM
    if named or big_clients:
        tags.append("Family-office style")
    if firm.get("broker_dealer"):
        tags.append("Broker-dealer ties")
    chips = ""
    if seg:
        chips = '<div class="segment-row">' + f'<span class="segment-chip">{esc(seg[1])}</span>'
        chips += "".join(f'<span class="segment-tag">{esc(t)}</span>' for t in tags) + "</div>"

    aum = firm.get("aum_total")
    disc = firm.get("aum_discretionary")
    disc_share = f"{round(disc / aum * 100)}% discretionary" if aum and disc is not None else None
    support = non_advisory(firm)
    fees = [
        label
        for key, label in (
            ("fee_pct_of_aum", "% of AUM"),
            ("fee_performance_based", "performance-based"),
            ("fee_commissions", "commissions"),
        )
        if firm.get(key)
    ]
    tiles = "".join(
        [
            _tile("Regulatory AUM", fmt_usd(aum), disc_share),
            _tile(
                "Employees",
                fmt_count(firm.get("employees_total")),
                f"{fmt_count(firm.get('employees_advisory'))} advisory · {fmt_count(support)} non-advisory"
                if support is not None
                else None,
            ),
            _tile("Accounts", fmt_count(firm.get("accounts_total"))),
            _tile("Disciplinary disclosures", fmt_count(firm.get("disciplinary_flag_count") or 0)),
        ]
    )

    facts = []
    if fees:
        facts.append(f"<li>Compensation: {esc(', '.join(fees))}.</li>")
    affils = firm.get("affil_count") or 0
    facts.append(f"<li>{affils} financial-industry affiliation{'' if affils == 1 else 's'} reported.</li>")
    growth = _growth_sentence(firm, extras)
    if growth:
        facts.append(f"<li>{esc(growth)}</li>")
    holdings = _holdings(firm, extras)
    if holdings:
        lead, top = holdings
        line = f"Form 13F: {lead}"
        if top:
            line += f". Largest: {', '.join(top)}"
        facts.append(f"<li>{esc(line.rstrip('.'))}.</li>")

    return (
        '<div id="prerender"><main class="shell"><section class="firm-detail">'
        f'<div class="detail-head"><h1>{esc(name)}</h1>'
        f'<p class="detail-sub">{esc(" · ".join(sub))}</p>{chips}</div>'
        f'<div class="tiles">{tiles}</div>'
        f'<div class="detail-card"><h2>At a glance</h2><ul class="prerender-facts">{"".join(facts)}</ul>'
        f'<p class="detail-note">From the firm’s Form ADV filing. '
        f'<a href="{esc(IAPD_URL.format(crd=crd))}">Official record on adviserinfo.sec.gov</a>.</p></div>'
        "</section></main></div>"
    )
