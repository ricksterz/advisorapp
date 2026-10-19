"""Individual advisers: SEC's IA_INDVL feed -> a name search index and per-firm rosters.

Source: the same daily bulk feed etl/individual_disclosures.py downloads,
reports.adviserinfo.sec.gov's IA_INDVL_Feed zip (~436K people, ~1.1 GB of XML
across 20 files). Each <Indvl> carries the person's name and CRD
(indvlPK), their current employers (<CrntEmp orgPK orgNm city state>),
designations (CFP, CFA, ChFC, PFS, CIC -- the only five in the feed),
past registrations with start dates, and an optional <DRP> block of nine
Y/N disclosure categories.

Kept: people with at least one current employer that is an SEC-registered
firm in the firms table -- this is a site about registered advisers, and
the feed also covers people at state-registered firms. Their employers
outside that set are dropped from the record.

Writes one committed file, advisors.json: each kept person once, as
[crd, name, [firm CRDs], city, state, designations, has_disclosure,
first_year]. The build (frontend/scripts/shard-data.mjs) turns it into the
name-search buckets and the per-firm rosters the site loads, so the
generated files never enter git.

There are deliberately no per-person pages: full career history lives on
the SEC's own IAPD page, which each result links to.

Usage:
    python -m etl.advisor_index --db data/advisor.duckdb
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import RAW_DIR, REPO_ROOT

FEED_DIR = RAW_DIR / "individual_disclosures"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public"

DESIGNATIONS = {
    "Certified Financial Planner": "CFP",
    "Chartered Financial Analyst": "CFA",
    "Chartered Financial Consultant": "ChFC",
    "Personal Financial Specialist": "PFS",
    "Chartered Investment Counselor": "CIC",
}
DRP_ATTRS = (
    "hasRegAction", "hasCriminal", "hasBankrupt", "hasCivilJudc", "hasBond",
    "hasJudgment", "hasInvstgn", "hasCustComp", "hasTermination",
)


def latest_feed(directory: Path = FEED_DIR) -> Path | None:
    def stamp(p: Path):
        m = re.search(r"(\d{2})_(\d{2})_(\d{4})", p.name)
        return (int(m[3]), int(m[1]), int(m[2])) if m else (0, 0, 0)

    feeds = sorted(directory.glob("IA_INDVL_Feed_*.zip"), key=stamp)
    return feeds[-1] if feeds else None


def title_case(name: str) -> str:
    """'O'BRIEN-SMITH' -> "O'Brien-Smith"; leaves already mixed case alone."""
    if not name or name != name.upper():
        return name or ""
    return re.sub(r"[A-Za-z]+", lambda m: m.group(0).capitalize(), name.lower())


def display_name(first: str, middle: str, last: str) -> str:
    parts = [title_case(first), (middle[:1] + ".") if middle else "", title_case(last)]
    return " ".join(p for p in parts if p)


def parse_person(el, firm_crds: set[int]) -> dict | None:
    """One <Indvl> element -> record, or None if no current registered employer."""
    info = el.find("Info")
    if info is None or not info.get("indvlPK"):
        return None
    employers = []
    city = state = None
    for emp in el.iterfind("CrntEmps/CrntEmp"):
        try:
            org = int(emp.get("orgPK") or 0)
        except ValueError:
            continue
        if org in firm_crds and org not in employers:
            employers.append(org)
            if city is None:
                # Where the person works: their branch office, not the firm's
                # head office (every Edward Jones advisor would be "St. Louis").
                branch = emp.find("BrnchOfLocs/BrnchOfLoc")
                place = branch if branch is not None and branch.get("city") else emp
                city, state = place.get("city"), place.get("state")
    if not employers:
        return None
    designations = sorted(
        {DESIGNATIONS[d.get("dsgntnNm")] for d in el.iterfind("Dsgntns/Dsgntn") if d.get("dsgntnNm") in DESIGNATIONS}
    )
    drp = el.find("DRPs/DRP")
    disclosure = drp is not None and any(drp.get(a) == "Y" for a in DRP_ATTRS)
    starts = [
        r.get("regBeginDt") for r in el.iterfind("PrevRgstns/PrevRgstn") if r.get("regBeginDt")
    ] + [r.get("stDt") for r in el.iterfind("CrntEmps/CrntEmp/CrntRgstns/CrntRgstn") if r.get("stDt")]
    first_year = min((int(s[:4]) for s in starts if s[:4].isdigit()), default=None)
    first, middle, last = info.get("firstNm") or "", info.get("midNm") or "", info.get("lastNm") or ""
    return {
        "crd": int(info.get("indvlPK")),
        "name": display_name(first, middle, last),
        "first": first,
        "last": last,
        "employers": employers,
        "city": title_case(city or "") or None,
        "state": state or None,
        "designations": " ".join(designations),
        "disclosure": disclosure,
        "first_year": first_year,
    }


def read_feed(path: Path, firm_crds: set[int]):
    from lxml import etree

    with zipfile.ZipFile(path) as zf:
        for member in sorted(n for n in zf.namelist() if n.lower().endswith(".xml")):
            with zf.open(member) as fh:
                for _, el in etree.iterparse(fh, events=("end",), tag="Indvl", recover=True):
                    person = parse_person(el, firm_crds)
                    el.clear()
                    while el.getprevious() is not None:
                        del el.getparent()[0]
                    if person:
                        yield person


def record(p: dict) -> list:
    return [
        p["crd"], p["name"], p["employers"], p["city"], p["state"],
        p["designations"], int(p["disclosure"]), p["first_year"],
    ]


def export(db_path: Path, out_dir: Path, feed: Path | None = None) -> int:
    feed = feed or latest_feed()
    if feed is None:
        print(f"no IA_INDVL feed in {FEED_DIR}; run `python -m etl.individual_disclosures fetch` first")
        return 0
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        firm_crds = {r[0] for r in con.execute("SELECT crd FROM firms").fetchall()}
    finally:
        con.close()

    people = sorted((record(p) for p in read_feed(feed, firm_crds)), key=lambda r: r[0])
    payload = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "source": feed.name,
        "people": people,
    }
    (out_dir / "advisors.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    firms = len({f for r in people for f in r[2]})
    print(f"indexed {len(people):,} advisers at {firms:,} firms from {feed.name}")
    return len(people)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--feed", type=Path, default=None, help="IA_INDVL feed zip (default: newest cached)")
    args = parser.parse_args()
    export(args.db, args.out, args.feed)


if __name__ == "__main__":
    main()
