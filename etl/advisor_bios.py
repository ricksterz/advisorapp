"""Form ADV Part 2B "brochure supplement" pipeline: advisor bios.

Populates the advisors table from the Item 2 ("Educational Background and
Business Experience") section of each supervised person's brochure
supplement — the individual-level counterpart to the firm-level
deal-structuring flags in etl/brochures.py. Part 2B is often filed as its own
PDF, but many firms combine Part 2A (the firm brochure) and Part 2B (one
section per person) into a single document, so this scans every cached
brochure text directly rather than filtering by brochure name.

There is no bulk feed for individual advisor data (BrokerCheck/IAPD only
expose per-CRD lookups), so this reads the same per-firm brochure text cache
that etl/brochures.py already built (data/brochures/{version_id}.txt) — no
new crawling. See docs/pdf-pipeline-scope.md for why that corpus only exists
on a workstation.

Extraction approach, in order of how it was built:
1. Sample the corpus broadly and catalog every real heading/name/CRD variant
   found (see etl/tests/test_advisor_bios.py for the literal excerpts this
   was built from).
2. Build patterns from that evidence, the same "explainable heuristics, not a
   model" style as etl/brochures.py — every pattern below is commented with
   the real version_id(s) that motivated it.
3. Prioritize precision over recall: if a person or their bio can't be
   confidently identified, skip them. A wrong/garbled/misattributed bio is a
   worse outcome than a missing one — see the module-level constraints in
   CLAUDE.md.

Usage:
    python -m etl.advisor_bios run --db data/advisor.duckdb --limit 500
    python -m etl.advisor_bios run --rescan   # re-process already-scanned brochures
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.config import REPO_ROOT, SCHEMA_PATH
from etl.config import DB_PATH as DEFAULT_DB

CACHE_DIR = REPO_ROOT / "data" / "brochures"  # same cache etl/brochures.py populates; gitignored via data/

# ---------------------------------------------------------------------------
# Section heading: Item 2, "Educational Background and Business Experience".
#
# Real variants found sampling ~200-1500 cached documents (version_id cited
# per variant):
#   "Item 2 – Educational Background and Business Experience"  (en-dash, 959418-style, the most common form)
#   "Item 2 - Educational Background and Business Experience"  (ascii hyphen, 1012112)
#   "Item 2: Educational Background and Business Experience"
#   "Item 2 Educational Background and Business Experience"    (no punctuation)
#   "Item 2. Educational Background and Business Experience"
#   "Item 2- Business Experience"                               (shortened, drops "Educational Background and" — 892462)
#   "Item 2 – Educational Background & Business Experience"    ("&" instead of "and", also seen bare — 1034531: "Educational & Business Experience")
#   bare "Educational Background and Business Experience", no Item number at all (1020455, 1026243)
#
# Two structurally different alternatives, matched separately on purpose:
#   - An "Item 2" numeral prefix is high-confidence on its own, so it's
#     allowed to pair with the shortened "Business Experience"-only form
#     (892462) without also requiring the word "Educational".
#   - Without an Item-2 prefix, "business experience" alone is far too
#     generic (matches ordinary prose — see PROSE_BEFORE/PROSE_AFTER below),
#     so the bare form requires the fuller "educational ... business
#     experience" phrase as its anchor.
HEADING_RE = re.compile(
    r"(item\s*2\s*[.\-–:]?\s*)"
    r"(?:educational\s*(?:background\s*)?(?:and|&)\s*business\s*experience|business\s*experience)"
    r"|(educational\s*(?:background\s*)?(?:and|&)\s*business\s*experience)",
    re.IGNORECASE,
)

# A firm's Part 2A brochure has its own "Item 2" — "Item 2. Material Changes"
# (seen combined with Part 2B content in 1016377, 1043991) — which never
# contains the phrase "business experience", so it never collides with
# HEADING_RE. No special-casing needed there.

# Real false positive (1025324): "...His educational background and business
# experience is as follows..." — ordinary prose that happens to contain the
# bare heading phrase verbatim, mid-sentence. A genuine heading is never
# preceded by a word that continues a sentence into it, and is never followed
# immediately by a verb ("is"/"are"/...). This guard only applies to the bare
# (no "Item 2") alternative — real headings with an Item-2 prefix don't
# appear in running prose.
PROSE_BEFORE = re.compile(r"\b(his|her|your|their|the|and|of|is|was|are|were|its|our|my)\s*$", re.IGNORECASE)
PROSE_AFTER = re.compile(r"^\s*(?:is|are|was|were)\b", re.IGNORECASE)

# Real false positive, same family as etl/brochures.py's TOC guard: a
# multi-person combined document's table of contents repeats each person's
# "Item 2" heading followed by a dot leader and page number
# (1041345, 1032951, 1013193, 1009166, ...). Two extensions found sampling
# this corpus that etl/brochures.py's original pattern doesn't need:
#   - Some PDFs render a dot leader as several short dot-runs separated by
#     single spaces rather than one long unbroken run (1030119: "...Business
#     Experience ................................ ....................... 23"
#     — note the space in the middle) — matched here with a character class
#     covering dots/underscores/spaces together instead of requiring one
#     contiguous run.
#   - Front-matter page numbers are sometimes lowercase roman numerals
#     instead of arabic ("...Business Experience .......... iv", 1027947).
#   - Some TOCs pad with plain whitespace instead of dots at all (995904:
#     "Item 2 - Educational Background and Business Experience        3").
#     Collapsing runs of whitespace to one space (the first step of every
#     extraction in this module) destroys exactly the signal a dot-leader
#     check needs, since a 20-space gap and a 1-space gap look identical
#     afterward — so this case is caught differently: a bare page number
#     sitting immediately after the heading, itself immediately followed by
#     the next "Item N" TOC entry, is a page number followed by digits ONLY
#     ever a few characters after the heading text, never anywhere close to
#     it in the several-hundred-character body of a real Item 2 section.
TOC_LEADER = re.compile(
    r"[._ ]{15,}(?:\d{1,4}|[ivxlcdm]{1,7})\b"
    r"|\A[._ ]{0,20}(?:\d{1,4}|[ivxlcdm]{1,7})\b.{0,50}?item\s*\d",
    re.IGNORECASE,
)

# Section boundary: the bio content runs until the next Item heading begins.
# Real variants: "Item 3 – Disciplinary Information", "Item 3: Disciplinary
# Information", "Item 3 - Disciplinary Information", and — like the bio
# heading itself — sometimes no "Item 3" numeral at all, just bare
# "Disciplinary Information" (1020455, 1026243).
NEXT_SECTION_RE = re.compile(
    r"item\s*3[.\-–:]?\s*disciplinary\s*information|disciplinary\s*information",
    re.IGNORECASE,
)

# A bio section is capped at this many characters after the heading even if
# no boundary is found — real Item 2 sections sampled top out around 2-3k
# characters; anything past this cap almost always means boundary detection
# failed (e.g. a document that never says "Disciplinary Information" at all),
# not a genuinely enormous bio. Better to show a truncated-but-real bio than
# to silently swallow unrelated document content into it.
MAX_BIO_CHARS = 4000
# Below this, there's no real bio content (e.g. two headings landing right
# next to each other because of a boilerplate sentence that lists every Item
# name in a row — "...business experience, disciplinary information, other
# business activities..." — see PROSE_BEFORE/AFTER above for the heading-side
# half of that same false positive).
MIN_BIO_CHARS = 25

# ---------------------------------------------------------------------------
# Name extraction. Tried in priority order — see _find_name — and a section
# is skipped entirely (no record written) when none of these tiers finds a
# name that survives _valid_name's plausibility checks. Real coverage
# numbers from a full-corpus run are in the PR description.
# ---------------------------------------------------------------------------

# 2-5 capitalized words/initials — deliberately permissive on internal
# punctuation ("Wyatt E. Lewis", "Karl Benjamin Ruff", "Robert K Draper",
# "David S. McAlvany"); a trailing digit (street address, phone, CRD number)
# always stops the match since digits aren't in the character class.
#
# Deliberately compiled/used WITHOUT re.IGNORECASE anywhere it appears below.
# A first pass compiled every name-finding pattern case-insensitively (to
# tolerate ALL-CAPS filers like "WYATT EVAN LEWIS" and "ITEM 2 – EDUCATIONAL
# BACKGROUND..."), which quietly broke the "starts with an uppercase letter"
# assumption everywhere: under re.IGNORECASE, `[A-Z]` matches lowercase
# letters too, so NAME_TOKEN happily matched into ordinary lowercase prose
# ("provides information about Ben" — the word "provides" isn't a name).
# The fix is per-pattern below: wrap only the literal marker text in a scoped
# `(?i:...)` group so *that* stays case-insensitive, while NAME_TOKEN itself
# stays genuinely case-sensitive.
# bandit's hardcoded-password heuristic (B105) misfires on this variable name
# + string-literal pairing; it's a name-matching regex fragment, not a secret.
NAME_TOKEN = r"[A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){1,4}"  # nosec B105

# Explicit label, highest confidence when present (487451: "SUPERVISED
# PERSON'S NAME: \n Paul F. Nastasi"; 1022919: a shorter "Supervised Person:
# \n Ryan S. Miyashiro" variant with no "'s Name"). Rare in the wider corpus
# (most filers use a plain cover page instead) but unambiguous when it
# appears. Without this pattern, the bare "Supervised Person:" label text
# itself was getting captured as a "name" by COVER_PAGE_RE (a table-of-
# contents mention of "...Brochure Supplement..." earlier in the same
# document matches that pattern's marker, with nothing but the label itself
# — no real name — immediately following it in the window). The trailing
# colon is deliberately mandatory (unlike COVER_PAGE_RE's optional one):
# some filers use "Supervised Person Information" as a bare section heading
# with no colon and no name right after it (1022438) — requiring the colon
# is what tells the two apart.
SUPERVISED_LABEL_RE = re.compile(r"(?i:supervised person(?:'?s name)?)\s*:\s*(" + NAME_TOKEN + r")")

# The name closest to a "Cover Page" (or the "Advisory Personnel" label some
# filers use instead — 892462) marker, which is where the SEC's own Part 2B
# template puts the supervised person's name — often the fullest/most formal
# form of the name (959418: "Item 1: Cover Page \n\n Karl Benjamin Ruff
# (Ben)"; 1012112: "Item 1 - Cover Page \n\n WYATT EVAN LEWIS"; 1051318:
# "Item 1 - Cover Page \n Nicholas J. Hoffman \n CRD# 1513288" — vs. the
# nickname "Nick" used later in that same document's boilerplate, which is
# why this tier is tried before info_about below). Also matches "Brochure
# Supplement" as a marker (893093), and skips over an intervening "Supervised
# Person's Name:" label if the cover page uses one (487451).
COVER_PAGE_RE = re.compile(
    r"(?i:cover page|advisory personnel|brochure supplement)\s*[:\-]?\s*"
    r"(?:[A-Za-z]+ \d{1,2}, \d{4}\s*)?(?:\d+\s*)?"  # optional date / page number between the marker and the name
    r"(?:(?i:supervised person'?s name:?)\s*)?(" + NAME_TOKEN + r")"
)

# The SEC's standard Part 2B boilerplate: "This brochure supplement provides
# information about {name} that supplements..." (also seen with a filer typo,
# "the supplements" — 1026243) and "Additional information about {name} is
# available on the SEC's website..." (near-universal, appears even when the
# "that supplements" sentence doesn't). Also covers less common phrasings
# like "...contains background information about {name}..." (475618).
# Occasionally the name here is a nickname/first name only (1051318: "about
# Nick is available") rather than the full name given on the cover page,
# which is why COVER_PAGE_RE is tried first.
INFO_ABOUT_RE = re.compile(
    r"(?i:information about) (" + NAME_TOKEN + r")\b[^.]{0,60}?(?i:supplement|available|contains)"
)

# A mini per-person heading used by some multi-person combined documents in
# place of a cover page or "information about" sentence — "{Name}'s
# Biographical Information", directly above the bare "Educational Background
# and Business Experience" heading itself (1046648, "ZIM" — a single document
# with seven people, each introduced this way: "Atanu Ghosh's Biographical
# Information \n Educational Background and Business Experience \n Birth
# date: January 2, 1972..."). As specific and high-confidence as
# COVER_PAGE_RE's markers, so tried alongside it.
BIOGRAPHICAL_INFO_RE = re.compile(r"(" + NAME_TOKEN + r")[’']s\s+(?i:biographical\s+information)")

# A "roster" tier — take the nearest capitalized phrase followed shortly by
# a digit, with no cover-page/label/sentence backing it at all — was tried
# and removed. It correctly handled its one motivating case (Boulay Wealth,
# Emerald Separate Account Mgmt — 989080, 1033571: "{Name} \n {Firm} \n
# {Street Address}" directly before the heading), but validating against a
# broader sample of the corpus surfaced it silently returning wrong-but-
# plausible-looking names on other documents with superficially similar
# layouts: a firm's street address block for a DIFFERENT reason (989080
# itself, on closer look, more often matched the address's city, "Eden
# Prairie", not the person before it — proximity to the heading isn't a
# reliable signal for which capitalized phrase in an address block is the
# name), and a stitched-together fragment from an unrelated roster list and
# the next paragraph (1017537: "Lovitsch Additional"). Every fix attempted
# to make it more precise for one document made it worse on another sampled
# document. Given the hard constraint against misattributing bio text to the
# wrong name, and that this tier's real job (docs with no cover-page marker
# and no "information about" sentence at all) is a small share of the corpus
# next to the risk of a confidently-wrong name, those documents are now
# simply skipped instead — no record is written when info_about, cover_page,
# supervised_label, and bio_lead all come up empty.

# The bio content itself often opens with the person's full name right before
# a birth-info cue: "David M. Jones was born in 1959..." (1025324), "Wyatt
# Evan Lewis \n Year of birth: 1974" (1012112's body), "Jeremy S. Martinson,
# CFP®, born in 1977, is dedicated..." (1043991 — note the optional
# credentials clause between the name and "born"). This tends to give the
# fullest form of the name (vs. e.g. INFO_ABOUT_RE occasionally only getting
# an honorific + last name, "Mr. Martinson" — see 1043991 below), so it's
# tried before INFO_ABOUT_RE despite being positionally the "last resort".
# Gated tightly on the birth-info cue to avoid grabbing an unrelated
# capitalized phrase that happens to open the section. The designation
# clause's leading comma is optional — some filers omit it ("Chelsea B.
# Mieczkowski CFP®, EA®, born in 1990...", 1043991) while others include it
# ("Jeremy S. Martinson, CFP®, born in 1977...", same document).
BIO_LEAD_RE = re.compile(
    r"^\s*(" + NAME_TOKEN + r")"
    r"(?:,?\s*[A-Za-z®.,&\s]{0,40})?"  # optional designations between name and cue, e.g. ", CFP®, "
    r"\s*[•·]?\s*(?i:[\-–(]|was born|is born|born[: ]|year of birth|date of birth)"
)

# Same idea, tried unanchored (see the priority loop in _find_name) when a
# generic policy statement or unfilled SEC template sentence sits between the
# heading and the real name (1049380: "We generally require that employees
# involved in making investment decisions... James E. Gasaway        Born
# 1970..."). Deliberately narrower than BIO_LEAD_RE above — no bare
# "[-–(]" cue — because that alternative is only safe right at the very
# start of the section; searched deeper into the text it matches ordinary
# institution names followed by a parenthetical, not a person (a real
# regression caught by this module's own tests: "Biola University (La
# Mirada, CA)" inside a bio would otherwise be mistaken for a name).
BIO_LEAD_SEARCH_RE = re.compile(
    r"(" + NAME_TOKEN + r")"
    r"(?:,?\s*[A-Za-z®.,&\s]{0,40})?"
    r"\s*[•·]?\s*(?i:was born|is born|born[: ]|year of birth|date of birth)"
)

# Sometimes the bio opens with the person's TITLE first, then a dash, then
# their name (the reverse order of BIO_LEAD_RE above): "Executive Officer –
# Yu-Dong Chen Mr. Yu-Dong Chen was born on June 9, 1978..." (969340),
# "Managing Partner – Michael Silane, CFA • Year of birth: 1969..." (1050203).
# Without this, NAME_TOKEN's own match on the title words themselves
# ("Executive Officer", "Managing Partner") was mistaken for the name.
# Restricted to a small closed set of real ADV job-title words rather than
# "any capitalized phrase before a dash", to keep this from misfiring on
# ordinary bio prose that happens to contain a dash.
_TITLE_WORD = (
    r"(?:executive|managing|chief|senior|vice|president|director|officer|"
    r"manager|partner|principal|chairman|chairwoman|associate|founder|"
    r"ceo|coo|cfo|cco)"
)
TITLE_LEAD_RE = re.compile(
    r"^\s*(?i:" + _TITLE_WORD + r")(?:\s+(?i:" + _TITLE_WORD + r"))*\s*[-–]\s*(" + NAME_TOKEN + r")"
)

# Another bio-opening variant: an explicit "Name:" label, same idea as
# SUPERVISED_LABEL_RE but inside the Item 2 body rather than on the cover
# page (1010905: "Name: Ryan Turbyfill Born: 1978..."; 1011897: "Name: Kyle
# David Appelbaum Born: ..."). Common in documents that split one shared
# "Item 2" section into several people with no other per-person marker at
# all — real multi-person documents where every other tier came up empty
# before this was added, each producing a document-structure fragment
# ("ADV Part") as the name instead of the real one.
NAME_LABEL_LEAD_RE = re.compile(r"(?i:name)\s*:\s*(" + NAME_TOKEN + r")")

# Words that mean a NAME_TOKEN match is actually an organization/section
# fragment, not a person (e.g. a cover-page name running straight into the
# firm's own name with nothing but whitespace between them).
ORG_WORDS = {
    "llc", "inc", "wealth", "capital", "management", "partners", "financial",
    "advisors", "advisers", "group", "company", "associates", "services",
    "trust", "bank", "fund", "holdings", "asset", "assets", "planning",
    "investment", "investments", "securities", "advisory", "wealthcare",
    "item", "cover", "page", "form", "brochure", "supplement", "educational",
    "business", "experience", "background", "table", "contents", "exhibit",
    "supervised", "person", "name",
    # Real false positive (1022364): a per-page footer/watermark
    # ("© 38 Compliance jointly with eAdvisor Compliance, Inc. — Disclosure
    # Brochure Design Layout.") repeated near a "Cover Page" marker on every
    # page of the document, captured as a bogus name ("Design Layout").
    "design", "layout", "disclosure", "compliance",
    # Document-structure fragments, same "digit consumed as a fake page
    # number" family as the street-address bug below, but without a street
    # suffix to catch it: "ADV Part" / "FOR PART" (1034007, 1013676, and
    # others) — a "Form ADV Part 2B" running header sitting where a name was
    # expected, with the "2B" or a page number absorbed elsewhere.
    "adv", "part",
    # Real false positive (1009636, "Compass Financial Advisory Services"):
    # the FIRM's own cover page ("Item 1 – Cover Page  Registered As: Compass
    # Financial Advisory Services, LLC | CRD No. 316843") is repeated as a
    # running header before every person's own Item 2 section in this filer's
    # layout, and "Registered As:" — a label for the firm's registered legal
    # name, not a person — was close enough to each person's own heading to
    # win over their real "Name: {name}" label deeper in the boilerplate
    # (fixed separately by widening the NAME_LABEL_LEAD_RE search window, but
    # kept here too as a backstop against the same words winning elsewhere).
    # "advisor"/"information" cover the same running-header family found in
    # other documents ("ADVISOR INFORMATION", 1041064) and the generic
    # "Required/Additional ... Information" phrases that show up when no
    # per-person marker is nearby (1008354, 1047041, 1007800).
    "registered", "advisor", "information",
}

# Street-address words that, when they're the LAST word of an otherwise
# name-shaped match, mean the whole thing is a street address rather than a
# person's name — checked positionally (see _valid_name) rather than added to
# ORG_WORDS, because several of these are also legitimate LEADING words
# (honorifics: "Dr. Strobeck" is a real, correctly-extracted name in this
# corpus — HONORIFIC_ROSTER_RE relies on "Dr." being accepted). Real false
# positives: "100 Park Avenue, Suite 1600" (1030143) and "7935 Stone Creek
# Dr., Suite 120" (1029359) — both the firm's street address, not a person,
# sitting directly under a cover-page marker with the street NUMBER consumed
# by the optional page-number sub-pattern in COVER_PAGE_RE, leaving the
# street NAME to be captured as if it were a name. Includes both full words
# and the common abbreviated forms (a mechanical sweep of the full table
# after the "Park Avenue" fix found the abbreviated forms had the exact same
# problem: "Kehr Rd", "Congress Ave", "Davenport St").
_TRAILING_ADDRESS_WORDS = {
    "avenue", "ave", "street", "st", "boulevard", "blvd", "drive", "dr",
    "road", "rd", "lane", "ln", "way", "plaza", "plz", "court", "ct",
    "circle", "cir", "suite", "ste", "floor", "fl", "highway", "hwy",
    "parkway", "pkwy", "place", "pl",
    # Office-complex/building-name words, same false-positive family but
    # without a plain street suffix ("El Camino Real, Suite 200..." — 999394;
    # "Bay Colony Corporate Center \n 950 Winter Street North, Suite
    # 4100..." — 1026873, itself another firm-wide "the Firm's employees"
    # generic template with no per-person name nearby at all, same as
    # 1029359 — rejecting the building name here is what lets the extractor
    # fall through to bio_lead, which finds the real name at the very start
    # of each person's own paragraph instead). Deliberately excludes common
    # words that are also plausible surnames ("Park", "Tower") to avoid
    # rejecting a real name that happens to end with one.
    "real", "center", "corporate", "commons", "square", "campus", "building",
    # US state abbreviations. Real false positive (1049380): "Brochure
    # Supplement \n\n Gasaway Investment Advisors, Inc. \n Form ADV Part 2B \n
    # Investment Advisor Brochure Supplement \n\n 7110 Stadium Drive \n
    # Kalamazoo MI 49009..." — captured "Stadium Drive Kalamazoo MI" (the
    # street name has no recognized suffix of its own here; the state code
    # ending the "{City} {ST}" line right before the zip is what's
    # recognizable and shared by every US mailing address). Two-letter,
    # ALL-CAPS-in-source, and never a real trailing name component in this
    # corpus — Roman-numeral name suffixes ("George A. Salter II") are a
    # different, already-supported case and aren't affected: "ii"/"iv" aren't
    # in this set.
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
    "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
    "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
    "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
    "wi", "wy", "dc",
    # Compass-direction suffixes on a street name ("Roselane Street NW",
    # 1049933 — note "Street" itself doesn't catch this one since it isn't
    # the last word). Two-letter only, for the same initial-collision reason
    # state codes are: a single-letter trailing word ("N", "S") is already
    # unconditionally stripped elsewhere as a probable initial, not rejected
    # outright, so it's deliberately left out of this set.
    "nw", "ne", "sw", "se",
}

# ---------------------------------------------------------------------------
# CRD extraction. Present in well under two-thirds of sampled documents —
# design for the rest having none (see the advisors table comment in
# schema.sql). Real label variants: "CRD# 4665596" (1012112), "CRD#: 1022056"
# (892462), "CRD No. 324482" (1016377), "(CRD# 4665596)" (1012112), "CRD #
# 6701855" (1003234).
# ---------------------------------------------------------------------------
CRD_RE = re.compile(r"CRD\s*#?\s*(?:No\.?)?\s*:?\s*\(?\s*(\d{4,8})\)?", re.IGNORECASE)

# Real false positive (1043991): "...searching with the Advisor's firm name
# or CRD# 170093" — the FIRM's CRD, mentioned in the same cover-page block as
# a person's own bio. Reject a CRD match immediately preceded by "firm".
CRD_FIRM_GUARD = re.compile(r"\bfirm\b", re.IGNORECASE)
CRD_GUARD_WINDOW = 40

# How far back from a heading to look for that person's own name/CRD. Real
# multi-person combined documents (1043991, 1013022: five- and two-person
# "Bamboo Wealth"/"RWA" style filings) put each person's own cover-page-style
# intro ("...information about Mr. Martinson is available... CRD# 4587392
# ... Item 2 –") within a few hundred characters of their heading — but the
# SAME documents also mention "Cover Page"/"Brochure Supplement"/a CRD number
# once, much earlier, for a completely different, earlier person (or the
# firm). Searching the unbounded text since the previous person's section
# would find that earlier, wrong match first. Bounding the search to a tail
# window right before the heading, and preferring the LAST (closest) match
# within it rather than the first, fixes both problems at once.
NAME_WINDOW_CHARS = 1500

# ---------------------------------------------------------------------------
# Internal roster split: a handful of filers (9 documents / 58 people found
# across the full corpus — e.g. 1027605, 1031406, "WEAS ADV PART 2A") put
# MULTIPLE people's bios under a SINGLE "Item 2" heading, delimited only by
# repeated "NAME: {name} TITLE: {title}" labels inside the section body:
#   Item 2 – Educational Background and Business Experience
#   NAME: James Cahn TITLE: Chair of the Investment Committee ... YEAR OF BIRTH: 1980
#   ... (his bio) ...
#   NAME: Edward Douglas Huber TITLE: Deputy Chief Investment Officer ...
#   ... (his bio) ...
# Treating the whole span as one bio under one name would misattribute
# everyone else's biography to the first person found — a real integrity
# risk, not just noise. When 1+ of these internal labels are found inside a
# section, they fully replace the normal single-record extraction for that
# heading.
INTERNAL_ROSTER_RE = re.compile(r"(?i:NAME):\s*(" + NAME_TOKEN + r")\s*(?i:TITLE):")

# Second internal-split pattern, same misattribution risk, different label
# style: 53 documents / 206 people found across the full corpus (e.g.
# 1051387, "WULFF CAPITAL MANAGEMENT") introduce everyone by full name once
# ("...Christopher Charles, Mr. Dennis Steinkamp, and Mr. Nicolas Santoyo...")
# and then give each person's own paragraph under a bare honorific + surname:
#   Mr. Charles was born in 1956 and attended the University of Iowa...
#   Mr. Steinkamp was born in 1960, attended Oregon State University...
#   Mr. Santoyo was born in 1984, attended California State University...
# Deliberately narrow — "was/is born in <year>" right after the honorific —
# so it doesn't fire on an incidental "Mr. Smith" mention elsewhere in a
# single-person bio (the earlier BIO_LEAD_SPLIT_RE attempt at this same
# problem used a much looser cue and had to be reverted after it started
# splitting ordinary single-person sections apart — see git history).
HONORIFIC_ROSTER_RE = re.compile(r"((?:Mr|Ms|Mrs|Dr)\.\s+[A-Z][A-Za-z'’\-]+)\s+(?:was|is)\s+born\s+in\s+\d{4}")


# Words that end up as the trailing "word" of a NAME_TOKEN match purely
# because nothing but whitespace separates them from a real name in the
# source layout — a label with no colon left after CRD_RE's punctuation was
# stripped by NAME_TOKEN's character class ("Steven Michael White \n CRD#:
# 1022056" -> captures "...White CRD"), a contact-info label ("David S.
# McAlvany \n Email: ..." -> "...McAlvany Email"), or a firm-name fragment
# directly abutting the cover-page name ("David M. Jones \n D & G Advisory
# Group..." -> "...Jones D", 1025324). None of these are ever a real trailing
# name component, so they're stripped from the end of a cleaned name.
# Also covers professional designation acronyms directly abutting the name
# with no comma before them ("Chelsea B. Mieczkowski CFP®, EA®, born in
# 1990...", 1043991 — the "®" isn't a name character, so NAME_TOKEN's greedy
# multi-word match otherwise swallows "CFP" as if it were a 4th name token).
_TRAILING_JUNK_WORDS = {
    "crd", "email", "phone", "tel", "fax", "website", "address", "date",
    "cfp", "cfa", "cpa", "mba", "cima", "chfc", "clu", "aif", "pfs", "ea",
    "jd", "crpc", "aams", "ricp", "cdfa",
    # Job-title words directly abutting a name with no separator (a leading
    # "For \n {Name} {Title}" cover-page layout — see _LEADING_JUNK_WORDS
    # below for the "For" half of this — 1046362: "For Stephen L. Hyde
    # President"; 1050391: "For Apurva Sahijwani Managing Director", "For
    # Mrinal Malhotra Executive Director"). Stripped one word at a time, so
    # a two-word title ("Managing Director") comes off in two passes.
    "president", "director", "officer", "manager", "partner", "principal",
    "chairman", "chairwoman", "executive", "associate", "chief", "managing",
    "vice", "senior", "founder", "ceo", "coo", "cfo", "cco", "svp", "evp",
    "avp",
    # A "Name: {name}" bio-opening label (NAME_LABEL_LEAD_RE) runs directly
    # into whatever immediately follows in the source with no punctuation
    # NAME_TOKEN would stop at ("Name: Ryan Turbyfill Born: 1978" -> captures
    # "...Turbyfill Born"; "Name: Dagean A. Larsen \n Year of Birth: 1983" ->
    # captures "...Larsen Year").
    "born", "year",
    # "Mr. Jose Luis Turnes \n [address] \n Additional information about
    # Mr. Turnes is available..." (1009503) — nothing but the address block
    # separates the name from the next paragraph's leading "Additional", and
    # NAME_TOKEN's 5-token cap wasn't reached before absorbing it too.
    "additional",
}

# A leading junk word directly abutting a real name with no separator — the
# mirror image of _TRAILING_JUNK_WORDS above. Real examples: "For \n Charles
# Carlson" (1022763), "For \n Brian H. Noyes" (1033452) — a cover-page mailing
# label ("For: {name}") rendered with the label word on its own line, so
# NAME_TOKEN's greedy match swept it in as a first "name" token. Also catches
# "The \n Mill 381 Brinton Lake Road..." (1047499, an office/building name,
# not a person) — stripping "The" leaves the single word "Mill", which then
# fails the two-word-minimum check in _looks_like_name rather than being
# accepted as a real (very short) name. Job-title words catch the mirror
# image of the trailing-title case above — the title sits before the name
# instead of after (1042222: "...Principal Brenton Ernsbarger..." — an org
# chart / roster line listing title then name with nothing between them and
# the next person's own line). "Revised" catches a document-footer
# date stamp that COVER_PAGE_RE's own date-skipping sub-pattern doesn't quite
# reach (1025101: "...Brochure Supplement Revised March 24, 2026 vi Marr
# Leisure" — the sub-pattern expects a bare "Month Day, Year", not "Revised
# Month Day, Year", so it fails to match and falls through to NAME_TOKEN
# capturing "Revised March" instead); stripping it leaves "March" alone,
# which then fails the two-word minimum the same way "Mill" does above.
_LEADING_JUNK_WORDS = {
    "for", "the", "a", "an", "revised",
    "president", "director", "officer", "manager", "partner", "principal",
    "chairman", "chairwoman", "executive", "associate", "chief", "managing",
    "vice", "senior", "founder", "ceo", "coo", "cfo", "cco", "svp", "evp",
    "avp",
}



# Two consecutive bare single-letter initials never occur in a real name
# sampled from this corpus — a person has at most one ("David S. McAlvany",
# "Robert K Draper"). When they do appear back to back, it marks where an
# unrelated capitalized phrase starts immediately after the real name with no
# delimiter — almost always the firm's own name, built from its founder
# (1042476: "Keith Dykes \n J. L. Perkins Wealth Management" -> NAME_TOKEN's
# greedy match otherwise captures "Keith Dykes J. L. Perkins"). Truncating at
# the first such pair keeps the real name and drops the rest.
_DOUBLE_INITIAL_RE = re.compile(r"^[A-Z]\.?$")


def _clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name).strip(" ,.-")
    words = name.split(" ")
    for i in range(len(words) - 1):
        if _DOUBLE_INITIAL_RE.match(words[i]) and _DOUBLE_INITIAL_RE.match(words[i + 1]):
            words = words[:i]
            break
    while len(words) > 1 and (
        words[-1].lower() in _TRAILING_JUNK_WORDS or re.fullmatch(r"[A-Z]", words[-1])
    ):
        words.pop()
    while len(words) > 1 and words[0].lower() in _LEADING_JUNK_WORDS:
        words = words[1:]
    # A bare leading single letter with no period is never a real name's
    # first token in this corpus either — it's the tail end of an adjacent
    # word that NAME_TOKEN could only start matching from partway through
    # (1017537: "Form ADV Part 2B \n TIMOTHY J. OBENDORF" -> the digit in
    # "2B" isn't a name character, so the match starts at the "B" instead of
    # failing outright, capturing "B TIMOTHY J. OBENDORF").
    if len(words) > 1 and re.fullmatch(r"[A-Z]", words[0]):
        words = words[1:]
    # Real documents sometimes repeat the name immediately, once as a
    # section title and once starting the sentence right after it (1020748:
    # "Brochure Supplement \n Ryan Kelly \n Ryan Kelly, Chief Executive
    # Officer..." -> NAME_TOKEN spans both, capturing "Ryan Kelly Ryan
    # Kelly"). An even-length name that's just two copies of the same
    # half back to back collapses to one copy.
    half = len(words) // 2
    if half and words[:half] == words[half:]:
        words = words[:half]
    # Same duplication, but with an honorific interposed instead of the name
    # repeating back to back (969340, TITLE_LEAD_RE case: "Yu-Dong Chen Mr.
    # Yu-Dong Chen was born..." -> captures "Yu-Dong Chen Mr. Yu-Dong Chen",
    # an odd word count so the even-length check above doesn't fire). When an
    # "Mr./Ms./Mrs./Dr." token splits the name into two equal, identical
    # halves, keep the honorific-led half — it reads more naturally and
    # matches how a bare "Mr. X" name is already shown elsewhere.
    for i, w in enumerate(words):
        if re.fullmatch(r"(?:Mr|Ms|Mrs|Dr)\.", w) and words[:i] == words[i + 1 :]:
            words = words[i:]
            break
    # A narrower version of the same duplication, just one word instead of
    # the whole name (1026715: "...Matthew David Kirr Kirr"; 1011596: "Dr.
    # James P. Wells Wells") — a mechanical full-table sweep found these
    # after the whole-name and honorific-split checks above had already
    # covered the more common shapes. Collapses any immediately-repeated word
    # (case-insensitively) to a single copy.
    deduped = []
    for w in words:
        if not deduped or deduped[-1].lower() != w.lower():
            deduped.append(w)
    words = deduped
    return " ".join(words)


def _looks_like_org(name: str) -> bool:
    words = {w.lower().strip(".,") for w in name.split()}
    return bool(words & ORG_WORDS)


def _looks_like_address(name: str) -> bool:
    # Checks every word except the first: a street-suffix word is usually
    # last ("Park Avenue"), but a city name can trail it with nothing but a
    # space between them once NAME_TOKEN has swallowed both ("62 Barry Avenue
    # Ridgefield, CT 06877" -> captures "Barry Avenue Ridgefield", with the
    # recognizable word "Avenue" stuck in the middle — 1010332). The first
    # word is deliberately exempted so a real leading honorific isn't
    # affected ("Dr. Strobeck" must keep working; see HONORIFIC_ROSTER_RE).
    words = name.split()
    return any(w.lower().strip(".,") in _TRAILING_ADDRESS_WORDS for w in words[1:])


# A real person's name in this corpus is built from full words (even when
# the whole name is rendered in caps, e.g. "WYATT EVAN LEWIS" — every word is
# still a real word). A firm's own short-form name or initialism is usually
# built from several bare, period-free abbreviations instead ("KP FA",
# 1042999: "...Additional information about KP FA is also available..." —
# the firm's own short name, matched by INFO_ABOUT_RE because it fits the
# same sentence shape as a real person's; "WGI DM", 1028542, the firm's name
# directly preceding the real person's own name with nothing but whitespace
# between them, same family as the address/building-name bugs above). A
# single such token is allowed (it can be a real initial without a period,
# "Robert K Draper"); two or more marks the whole thing as an abbreviation,
# not a name.
_ABBREVIATION_RE = re.compile(r"^[A-Z]{2,3}$")
_KNOWN_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v", "vi"}


def _looks_like_abbreviation(name: str) -> bool:
    hits = sum(
        1
        for w in name.split()
        if _ABBREVIATION_RE.match(w) and w.lower() not in _KNOWN_SUFFIXES
    )
    return hits >= 2


# Final plausibility gate applied to every accepted name, regardless of which
# tier found it. Real false positives sampled from a full-corpus run:
# single stray capitalized words ("S", "BS", "The", "Our", "Mr." — usually
# from a sentence fragment or a mid-word PDF line break landing right where a
# name was expected) and NAME_TOKEN matching past a real 2-3 word name into
# adjacent job-title or description text ("Kevin W. Arbogast Biographical
# Information", "John Wilbourne Managing Partner Occidental" — a genuine name
# sampled in this same corpus never exceeded ~25 characters). A real person's
# name is always at least two words and comfortably under this length; when
# it isn't, something else got captured, so the whole record is dropped
# rather than shown misattributed or garbled.
MAX_NAME_CHARS = 40


def _looks_like_name(name: str) -> bool:
    return len(name.split()) >= 2 and len(name) <= MAX_NAME_CHARS


def _valid_name(name: str) -> bool:
    return (
        _looks_like_name(name)
        and not _looks_like_org(name)
        and not _looks_like_address(name)
        and not _looks_like_abbreviation(name)
    )


TOC_LOOKAHEAD_CHARS = 180  # a multi-segment dot leader (see TOC_LEADER) can run past 100 chars (1030119)


def _find_heading_matches(flat: str) -> list[re.Match]:
    """Real (non-TOC, non-prose) Item 2 heading occurrences, in document order."""
    matches = []
    for m in HEADING_RE.finditer(flat):
        if TOC_LEADER.search(flat[m.end() : m.end() + TOC_LOOKAHEAD_CHARS]):
            continue
        if not m.group(1):  # bare form (no "Item 2" prefix) — apply the prose guard
            before = flat[max(0, m.start() - 15) : m.start()]
            after = flat[m.end() : m.end() + 15]
            if PROSE_BEFORE.search(before) or PROSE_AFTER.match(after):
                continue
        matches.append(m)
    return matches


def _tier_match(pattern: re.Pattern, tail: str) -> str | None:
    """Cleaned, valid name from the closest-to-the-heading match of
    `pattern` in `tail` that isn't itself a table-of-contents artifact, or
    None.

    Takes the LAST match rather than the first — see _find_name's docstring
    for why — but a single-person document's own table of contents can
    contain a "Cover Page" or "Brochure Supplement" entry with a bare page
    number after it and no dot leader at all (995904: "Item 1 – Cover Page
    1"), which the heading-level TOC guard in _find_heading_matches never
    sees since it isn't the bio heading itself. When the closest match is
    immediately followed by that pattern, it's discarded and the next-
    closest match is tried instead of giving up entirely.
    """
    for m in reversed(list(pattern.finditer(tail))):
        if TOC_LEADER.search(tail[m.end() : m.end() + TOC_LOOKAHEAD_CHARS]):
            continue
        name = _clean_name(m.group(1))
        if _valid_name(name):
            return name
    return None


def _shorter_if_prefix(primary: str, secondary: str | None) -> str:
    """When two independently-found candidate names for the same person
    agree word-for-word (the shorter one appears as a contiguous run inside
    the longer one, at the start, end, or middle), prefer the shorter — the
    extra words on the longer candidate are consistently an adjacent
    address/firm-name fragment, or a stray word like "For" on its own line
    before a mailing label (1033907: "For \n Gerald C. Timmis III" ->
    "For Gerald C. Timmis III"), that NAME_TOKEN swept in because nothing but
    whitespace separated it from the real name — never a genuine extra part
    of the name. Comparison ignores case and a trailing period on each word,
    so "A" and "A." (with/without a middle initial's period) still count as
    agreeing. Falls back to `primary` when there's no second candidate, or
    the two don't share a common run at all.
    """
    if not secondary or primary == secondary:
        return primary

    def norm(name: str) -> list[str]:
        return [w.rstrip(".").lower() for w in name.split()]

    def contains(haystack: list[str], needle: list[str]) -> bool:
        n = len(needle)
        return any(haystack[i : i + n] == needle for i in range(len(haystack) - n + 1))

    p_words, s_words = norm(primary), norm(secondary)
    if len(s_words) < len(p_words) and contains(p_words, s_words):
        return secondary
    if len(p_words) < len(s_words) and contains(s_words, p_words):
        return primary
    return primary


def _find_name(preceding: str, bio_start: str) -> tuple[str, str] | tuple[None, None]:
    """Best-guess (name, source_tier) for the person whose Item 2 heading
    ends where `bio_start` begins. `preceding` is bounded to a window right
    before the heading (see NAME_WINDOW_CHARS) — a multi-person document can
    put an unrelated, much-earlier person's cover page or CRD anywhere since
    the previous heading, and taking the nearest match instead of the first
    one found is what keeps a person's name attached to their own intro.
    """
    tail = preceding[-NAME_WINDOW_CHARS:]

    info_about = _tier_match(INFO_ABOUT_RE, tail)

    supervised = _tier_match(SUPERVISED_LABEL_RE, tail)
    if supervised:
        # Real false positive (1022919): "Supervised Person: Ryan S.
        # Miyashiro \n Kahala Mall Way..." — nothing but whitespace between
        # the name and the office address below it, so NAME_TOKEN's greedy
        # match swept the address in too ("...Miyashiro Kahala Mall"). The
        # independent INFO_ABOUT_RE sentence elsewhere in the document has no
        # address nearby to confuse it, so when it agrees with a prefix of
        # this tier's match, the shorter, address-free one wins.
        return _shorter_if_prefix(supervised, info_about), "supervised_label"

    biographical = _tier_match(BIOGRAPHICAL_INFO_RE, tail)
    if biographical:
        return biographical, "biographical_info"

    cover_page = _tier_match(COVER_PAGE_RE, tail)
    if cover_page:
        # Real false positive (1030959): the cover page sometimes has
        # nothing but whitespace between the person's name and the firm's
        # own name directly below it ("Douglas Norman Mansager \n Lindahl &
        # Mansager, Inc."), and when the firm is named after a person (here,
        # a co-founder), NAME_TOKEN can't tell that apart from a real 4th
        # name token — it captured "Douglas Norman Mansager Lindahl".
        # INFO_ABOUT_RE's independent "...information about Douglas Norman
        # Mansager that supplements..." sentence agrees with the first three
        # words, so the shorter, agreed-upon name wins here too.
        return _shorter_if_prefix(cover_page, info_about), "cover_page"

    for pattern, tier, anchored in (
        (BIO_LEAD_RE, "bio_lead", True),
        # These three all search rather than match at position 0: real
        # documents very often open Item 2 with the SEC's own unfilled
        # instructional boilerplate, or a generic firm policy statement,
        # before the actual name (1009636: "This section of the brochure
        # supplement includes the supervised person's name, age (or year of
        # birth)... Name: Tara A. Sanders Year of Birth: 1971..." — 200+
        # characters of template text before the label; 1049380: "We
        # generally require that employees involved in making investment
        # decisions... James E. Gasaway        Born 1970..." — same shape, no
        # label at all, just the bare name + cue further into the section).
        # Each searches for a specific enough cue that the wider window is
        # safe: BIO_LEAD_SEARCH_RE deliberately drops BIO_LEAD_RE's bare
        # "[-–(]" cue for exactly this reason — unanchored, that alternative
        # matched ordinary institution names ("Biola University (La Mirada,
        # CA)") as if they were a person. TITLE_LEAD_RE stays anchored to
        # position 0 since it's the loosest pattern here (any phrase built
        # from a short closed set of title words), where unanchored search
        # would risk matching an unrelated title-word mention deeper in
        # boilerplate that isn't actually introducing the person's name.
        (BIO_LEAD_SEARCH_RE, "bio_lead", False),
        (NAME_LABEL_LEAD_RE, "bio_lead", False),
        (TITLE_LEAD_RE, "bio_lead", True),
    ):
        m = pattern.match(bio_start) if anchored else pattern.search(bio_start)
        if m:
            name = _clean_name(m.group(1))
            if _valid_name(name):
                return name, tier

    if info_about:
        return info_about, "info_about"

    return None, None


def _find_crd(preceding: str) -> int | None:
    tail = preceding[-NAME_WINDOW_CHARS:]
    matches = []
    for m in CRD_RE.finditer(tail):
        before = tail[max(0, m.start() - CRD_GUARD_WINDOW) : m.start()]
        if CRD_FIRM_GUARD.search(before):
            continue
        matches.append(m)
    return int(matches[-1].group(1)) if matches else None


def _split_internal_roster(section: str) -> list[dict] | None:
    """Split a section that bundles multiple people under NAME:/TITLE:
    labels (see INTERNAL_ROSTER_RE) into one record per person. Returns None
    when the section doesn't use this pattern, so the caller falls back to
    normal single-record extraction.
    """
    labels = list(INTERNAL_ROSTER_RE.finditer(section))
    if not labels:
        return None
    records = []
    for i, m in enumerate(labels):
        name = _clean_name(m.group(1))
        if not _valid_name(name):
            continue
        end = labels[i + 1].start() if i + 1 < len(labels) else len(section)
        bio = section[m.end() : end].strip()
        if len(bio) < MIN_BIO_CHARS:
            continue
        records.append({"name": name, "crd": _find_crd(section[m.start() : end]), "bio": bio[:MAX_BIO_CHARS]})
    return records


def _split_honorific_roster(section: str) -> list[dict] | None:
    """Split a section that bundles multiple people under repeated
    "Mr./Ms./Mrs./Dr. {Surname} was born in {year}" openings and no other
    label at all (see HONORIFIC_ROSTER_RE) into one record per person.
    Returns None when the section doesn't use this pattern.
    """
    labels = list(HONORIFIC_ROSTER_RE.finditer(section))
    if len(labels) < 2:
        return None
    records = []
    for i, m in enumerate(labels):
        name = _clean_name(m.group(1))
        if not _valid_name(name):
            continue
        end = labels[i + 1].start() if i + 1 < len(labels) else len(section)
        bio = section[m.start() : end].strip()
        if len(bio) < MIN_BIO_CHARS:
            continue
        records.append({"name": name, "crd": _find_crd(section[m.start() : end]), "bio": bio[:MAX_BIO_CHARS]})
    return records


def find_bios(text: str) -> list[dict]:
    """Extract every confidently-identified advisor bio from one brochure's
    text. Returns a list of {"name", "crd", "bio"} dicts — [] when nothing in
    the document could be confidently attributed to a real person. Mirrors
    etl/brochures.py's find_flags: keep scanning with finditer rather than
    stopping at the first hit, since a single document can (and often does)
    cover multiple supervised persons.
    """
    flat = re.sub(r"\s+", " ", text)
    headings = _find_heading_matches(flat)
    if not headings:
        return []

    records: list[dict] = []
    prev_end = 0
    for i, m in enumerate(headings):
        next_start = headings[i + 1].start() if i + 1 < len(headings) else len(flat)
        cap = min(next_start, m.end() + MAX_BIO_CHARS)
        section = flat[m.end() : cap]

        roster = _split_internal_roster(section)
        if roster is None:
            roster = _split_honorific_roster(section)
        if roster is not None:
            records.extend(roster)
            prev_end = m.end()
            continue

        preceding = flat[prev_end : m.start()]
        bio_start = flat[m.end() : m.end() + 400]
        name, _tier = _find_name(preceding, bio_start)
        prev_end = m.end()
        if not name:
            continue

        boundary = NEXT_SECTION_RE.search(section)
        bio = (section[: boundary.start()] if boundary else section).strip()
        if len(bio) < MIN_BIO_CHARS:
            continue

        records.append({"name": name, "crd": _find_crd(preceding), "bio": bio})

    return _drop_duplicate_bios(records)


def _drop_duplicate_bios(records: list[dict]) -> list[dict]:
    """Final backstop: drop every record whose bio text is byte-identical to
    another record's in the same document.

    Real false positive (1029359, "Vestment Financial LLC"): six genuinely
    separate Item 2 headings, one per real supervised person, but the filer
    put the exact same boilerplate policy statement ("We require that
    employees that provide investment advice have a bachelor's degree...")
    under every single one instead of writing individual bios — combined
    with no name tier finding a real name for any of them (falling through
    to an address fragment before the address guards above existed), this
    produced six identical, non-distinguishing fake records. Even with the
    name bugs fixed, duplicate bio text within one document is never a real,
    individually-attributable biography — it's boilerplate, a template that
    wasn't filled in, or an extraction/splitting bug — so none of the copies
    are shown rather than guessing which (if any) name goes with real content.
    """
    bio_counts: dict[str, int] = {}
    for r in records:
        bio_counts[r["bio"]] = bio_counts.get(r["bio"], 0) + 1
    records = [r for r in records if bio_counts[r["bio"]] == 1]

    # Second half of the same backstop, the mirror-image failure: the SAME
    # name attached to several DIFFERENT bios in one document. Real example
    # (1035157, "Buckhead Capital Management"): the filer's own "This
    # Brochure Supplement provides information about {name} that
    # supplements..." sentence says "Walter DuPre" ahead of all eleven
    # supervised persons' sections, not just his own — a genuine error in the
    # source filing itself, not a bug in this extractor, but the visible
    # symptom is identical either way: one name suddenly "has" eleven
    # unrelated biographies. A real person is only listed once per document,
    # so 2+ distinct bios sharing one name is exactly as strong a signal as
    # 2+ copies of one bio sharing different names above, and gets the same
    # treatment — drop every copy rather than guess which, if any, is right.
    name_counts: dict[str, int] = {}
    for r in records:
        name_counts[r["name"]] = name_counts.get(r["name"], 0) + 1
    return [r for r in records if name_counts[r["name"]] == 1]


# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    # The pre-existing `advisors` table (crd-only primary key, no bio
    # columns — see schema.sql's comment on the redesign) predates this
    # module and was never populated by anything (nothing in this repo reads
    # or writes it before etl/advisor_bios.py). CREATE TABLE IF NOT EXISTS
    # won't reshape a table that already exists, so a database created before
    # this change needs the old empty shell dropped before the new schema can
    # apply. Safe unconditionally: any real advisor data was always written
    # by this module's own delete-then-insert-per-brochure stage, which is
    # naturally idempotent on rerun.
    has_new_shape = con.execute(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'advisors' AND column_name = 'id'"
    ).fetchone()[0]
    if not has_new_shape:
        con.execute("DROP TABLE IF EXISTS advisors")
    con.execute(SCHEMA_PATH.read_text())
    # CREATE TABLE IF NOT EXISTS doesn't alter tables that predate a schema
    # change; bring older databases up to date (same pattern as
    # etl/brochures.py's connect() for deal_structuring.evidence).
    con.execute("ALTER TABLE brochures ADD COLUMN IF NOT EXISTS bios_extracted_at TIMESTAMP")
    return con


def stage_bios(con: duckdb.DuckDBPyConnection, limit: int | None, rescan: bool = False) -> None:
    """Scan cached brochure text for Part 2B bios and load the advisors table.

    Incremental by default: only brochures never scanned for bios
    (bios_extracted_at IS NULL) are processed, so a future run after a fresh
    brochure crawl only touches newly-cached documents. Pass rescan=True to
    reprocess everything (e.g. after an extractor change) — safe to re-run
    any time since each brochure's advisor rows are deleted and reinserted
    together.
    """
    query = "SELECT version_id, firm_crd, name FROM brochures WHERE text_chars IS NOT NULL"
    if not rescan:
        query += " AND bios_extracted_at IS NULL"
    query += " ORDER BY firm_crd"
    rows = con.execute(query).fetchall()
    if limit:
        rows = rows[:limit]

    docs_processed = docs_with_people = people_found = people_with_crd = 0
    for version_id, firm_crd, name in rows:
        txt_path = CACHE_DIR / f"{version_id}.txt"
        if not txt_path.exists():
            # Cached text is missing (e.g. corpus not fully synced to this
            # machine yet) — leave bios_extracted_at unset so a future run
            # retries once the file appears, instead of treating it as
            # permanently bio-free.
            continue
        text = txt_path.read_text(encoding="utf-8", errors="replace")
        bios = find_bios(text)

        con.execute("DELETE FROM advisors WHERE source_version_id = ?", [version_id])
        now = datetime.now(timezone.utc)
        for b in bios:
            con.execute(
                """
                INSERT INTO advisors
                    (crd, full_name, current_firm_crd, bio_text, source_version_id, source_name, extracted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [b["crd"], b["name"], firm_crd, b["bio"], version_id, name, now],
            )
        con.execute("UPDATE brochures SET bios_extracted_at = ? WHERE version_id = ?", [now, version_id])

        docs_processed += 1
        docs_with_people += bool(bios)
        people_found += len(bios)
        people_with_crd += sum(1 for b in bios if b["crd"] is not None)
        if docs_processed % 500 == 0:
            print(f"scanned {docs_processed}/{len(rows)} brochures ({people_found} advisors found)")

    if people_found:
        print(
            f"bios done: {docs_processed} brochures scanned, {docs_with_people} had >=1 advisor, "
            f"{people_found} advisors extracted, {people_with_crd} with a CRD "
            f"({people_with_crd / people_found:.0%})"
        )
    else:
        print(f"bios done: {docs_processed} brochures scanned, 0 advisors extracted")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["run"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--limit", type=int, default=None, help="max brochures to process")
    parser.add_argument(
        "--rescan",
        action="store_true",
        help="reprocess every cached brochure, not just unscanned ones (use after an extractor change)",
    )
    args = parser.parse_args()

    if not args.db.exists():
        sys.exit(f"error: {args.db} not found — run `python -m etl.ingest_adv` first")
    con = connect(args.db)
    try:
        stage_bios(con, args.limit, rescan=args.rescan)
    finally:
        con.close()


if __name__ == "__main__":
    main()
