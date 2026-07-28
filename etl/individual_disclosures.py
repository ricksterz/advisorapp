"""Individual-level disclosure flags from the SEC's bulk IA_INDVL_Feed.

Source (verified 2026-07-21 via a feasibility spike — see
docs/industry-pulse-plan.md Phase 3): reports.adviserinfo.sec.gov publishes a
daily-refreshed bulk feed of every IAPD individual (~436K people) as a zip of
~20 large XML files, found in the compilation manifest:
    reports.adviserinfo.sec.gov/reports/CompilationReports/CompilationReports.manifest.json
This project had previously (wrongly) concluded no bulk individual feed
exists — that conclusion was based on the separate FOIA archive index, which
doesn't carry it.

Each <Indvl> element optionally carries a <DRPs> block with at most one
<DRP> child — nine Y/N attributes, one per disclosure category (customer
complaint, regulatory action, criminal, bankruptcy, civil judicial, bond,
judgment, investigation, termination). Verified against >20K non-empty
blocks in the real feed: none had more than one <DRP> child. There is no
narrative, date, or dollar detail in the bulk feed itself — every record
carries a `link` to the individual's full IAPD summary page for that.

Usage:
    python -m etl.individual_disclosures fetch   # download the current feed
    python -m etl.individual_disclosures load    # feed -> individual_disclosures
    python -m etl.individual_disclosures run     # both
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd
import requests

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import HTTP_HEADERS, RAW_DIR, SCHEMA_PATH
from etl.ingest_adv import to_bool, to_number

INDVL_RAW_DIR = RAW_DIR / "individual_disclosures"
COMPILATION_BASE = "https://reports.adviserinfo.sec.gov/reports/CompilationReports"
MANIFEST_URL = f"{COMPILATION_BASE}/CompilationReports.manifest.json"

# DRP element attribute -> individual_disclosures column.
DRP_ATTRS = {
    "has_reg_action": "hasRegAction",
    "has_criminal": "hasCriminal",
    "has_bankruptcy": "hasBankrupt",
    "has_civil_judicial": "hasCivilJudc",
    "has_bond": "hasBond",
    "has_judgment": "hasJudgment",
    "has_investigation": "hasInvstgn",
    "has_customer_complaint": "hasCustComp",
    "has_termination": "hasTermination",
}


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    return con


def stage_fetch() -> Path | None:
    """Download the current IA_INDVL_Feed zip, if not already on disk.

    The feed is refreshed daily under a fixed filename pattern (date-stamped,
    not versioned), so unlike pulse_history's monthly archives there's
    nothing to accumulate — just fetch today's copy if we don't have it.
    """
    INDVL_RAW_DIR.mkdir(parents=True, exist_ok=True)
    resp = requests.get(MANIFEST_URL, headers=HTTP_HEADERS, timeout=60)
    resp.raise_for_status()
    files = resp.json().get("files", [])
    name = next((f["name"] for f in files if f["name"].startswith("IA_INDVL_Feed_")), None)
    if name is None:
        print("note: no IA_INDVL_Feed_* entry in the compilation manifest")
        return None
    dest = INDVL_RAW_DIR / name
    if dest.exists():
        print(f"already have {dest.name}")
        return dest
    r = requests.get(f"{COMPILATION_BASE}/{name}", headers=HTTP_HEADERS, timeout=600)
    r.raise_for_status()
    dest.write_bytes(r.content)
    print(f"fetched {dest.name} ({len(r.content) / 1e6:.0f} MB)")
    return dest


def _latest_archive() -> Path | None:
    archives = sorted(INDVL_RAW_DIR.glob("IA_INDVL_Feed_*.xml.zip"))
    return archives[-1] if archives else None


def parse_feed(zf: zipfile.ZipFile) -> tuple[pd.DataFrame, int]:
    """Stream every <Indvl> across every member of the feed zip, keeping
    only individuals with at least one flagged DRP category. Returns
    (flagged, total_scanned) — the total is needed to compute an honest
    industry-wide flagged rate without re-parsing the feed later.

    Streams via lxml.etree.iterparse (clearing each element after use)
    rather than loading whole files, since each member is ~50-60MB — the
    same pattern etl/ingest_adv.py uses for the bulk firm feed.
    """
    from lxml import etree

    rows: list[dict] = []
    total = 0
    for member in zf.namelist():
        if not member.endswith(".xml"):
            continue
        with zf.open(member) as fh:
            for _, indvl in etree.iterparse(fh, events=("end",), tag="Indvl", recover=True):
                total += 1
                drp = indvl.find("DRPs/DRP")
                if drp is None:
                    indvl.clear()
                    continue
                flags = {field: bool(to_bool(drp.get(attr))) for field, attr in DRP_ATTRS.items()}
                flag_count = sum(flags.values())
                if not flag_count:
                    indvl.clear()
                    continue
                info = indvl.find("Info")
                crd = to_number(info.get("indvlPK")) if info is not None else None
                if crd is None:
                    indvl.clear()
                    continue
                last = (info.get("lastNm") or "").strip()
                first = (info.get("firstNm") or "").strip()
                rows.append(
                    {
                        "crd": int(crd),
                        "full_name": f"{first} {last}".strip(),
                        **flags,
                        "flag_count": flag_count,
                        "iapd_link": info.get("link"),
                    }
                )
                indvl.clear()
    flagged = pd.DataFrame(rows, columns=["crd", "full_name", *DRP_ATTRS.keys(), "flag_count", "iapd_link"])
    return flagged, total


def stage_load(con: duckdb.DuckDBPyConnection, archive: Path) -> int:
    """Parse `archive` and wholesale-replace individual_disclosures.

    A single daily file supersedes the last one entirely (no incremental
    merge like pulse_history's per-month archives), so this is a full
    delete-then-bulk-insert rather than an upsert.
    """
    with zipfile.ZipFile(archive) as zf:
        flagged, total = parse_feed(zf)
    # DuckDB's plain TIMESTAMP column silently reinterprets a tz-aware
    # datetime as the SYSTEM's local wall-clock time on insert (verified:
    # inserting 2026-07-28 00:00 UTC on a UTC-5 machine reads back as
    # 2026-07-27 19:00) — stripping tzinfo here, after computing the correct
    # UTC instant, avoids that silent shift so individual_disclosures_stats.py
    # can safely take .date() on the stored value for "as of".
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    flagged["source_archive"] = archive.name
    flagged["fetched_at"] = now

    con.execute("DELETE FROM individual_disclosures")
    con.register("staging_indvl", flagged)
    cols = ", ".join(flagged.columns)
    con.execute(f"INSERT INTO individual_disclosures ({cols}) SELECT {cols} FROM staging_indvl")  # nosec B608
    con.unregister("staging_indvl")

    con.execute("DELETE FROM individual_disclosures_meta")
    con.execute(
        """
        INSERT INTO individual_disclosures_meta (source_archive, total_individuals, flagged_individuals, fetched_at)
        VALUES (?, ?, ?, ?)
        """,
        [archive.name, total, len(flagged), now],
    )
    print(f"loaded {len(flagged)} flagged individuals (of {total} total scanned) from {archive.name}")
    return len(flagged)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["fetch", "load", "run"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    if args.stage in ("fetch", "run"):
        stage_fetch()
    if args.stage in ("load", "run"):
        archive = _latest_archive()
        if archive is None:
            sys.exit("error: no IA_INDVL_Feed archive on disk — run `fetch` first")
        con = connect(args.db)
        try:
            stage_load(con, archive)
        finally:
            con.close()


if __name__ == "__main__":
    main()
