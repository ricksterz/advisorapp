"""Ownership & control from Form ADV Schedule A/B.

Schedule A lists a firm's direct owners and executive officers; Schedule B
lists its indirect owners (the chain above it). Together they answer "who
actually owns and controls this adviser" — the one thing the site's firm pages
could not show. Both live in the SAME monthly advFilingData archives
etl/pulse_history.py already downloads, so this adds no new data source and no
new crawl.

THE TWO CODE SETS ARE NOT THE SAME. Verified against the SEC/IARD instructions
and a real 2026-06 pull (19,055 rows), which agreed exactly:

    Schedule A   NA <5%   A 5-10%   B 10-25%   C 25-50%   D 50-75%   E 75%+
    Schedule B                      C 25-50%   D 50-75%   E 75%+     F Other

F means "Other (general partner, trustee, or elected manager)" — a
non-percentage category that exists only on Schedule B. In the real pull it
appeared on 1,428 Schedule B rows and zero Schedule A rows, and every sampled
F row carried a TRUSTEE or MEMBER title, matching the instruction text.
Rendering F as a percentage band, or applying Schedule A's NA/A/B to a
Schedule B row, would both misstate the filing — hence OWNERSHIP_LABELS is
keyed by (schedule, code) rather than by code alone.

Same filing-window-not-snapshot problem as the rest of the archive pipeline:
ownership_filings holds every raw row across all cached archives, and
firm_owners is the reconstructed latest-known-state per firm.

Usage:
    python -m etl.ownership run --db data/advisor.duckdb
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import REPO_ROOT, SCHEMA_PATH
from etl.ingest_adv import normalize_header
from etl.pulse_history import (
    PULSE_RAW_DIR,
    _archive_member,
    _read_member_csv,
    parse_base_a,
)

SCHEDULE_AB_RE = r"IA_Schedule_A_B_\d{8}_\d{8}\.csv"

DEFAULT_OWNERS_OUT = REPO_ROOT / "frontend" / "public" / "firm_owners.json"

# (schedule, code) -> human label. Keyed by the pair on purpose: the same
# letter can be absent from one schedule and mean something non-numeric on
# the other.
OWNERSHIP_LABELS = {
    ("A", "NA"): "under 5%",
    ("A", "A"): "5-10%",
    ("A", "B"): "10-25%",
    ("A", "C"): "25-50%",
    ("A", "D"): "50-75%",
    ("A", "E"): "75% or more",
    ("B", "C"): "25-50%",
    ("B", "D"): "50-75%",
    ("B", "E"): "75% or more",
    ("B", "F"): "Other (GP, trustee, or elected manager)",
}

COLUMNS = {
    "filing_id": ["FILINGID"],
    "schedule": ["SCHEDULE"],
    "owner_name": ["FULLLEGALNAME"],
    "owner_id": ["OWNERID"],
    "entity_type": ["DE/FE/I", "DEFEI"],
    "owned_entity": ["ENTITYINWHICH"],
    "title_or_status": ["TITLEORSTATUS"],
    "status_acquired": ["STATUSACQUIRED"],
    "ownership_code": ["OWNERSHIPCODE"],
    "is_control_person": ["CONTROLPERSON"],
    "is_public_reporting": ["PR"],
}


def _resolve(headers: dict[str, str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in headers:
            return headers[c]
    return None


def _yes_no(series: pd.Series) -> pd.Series:
    """Schedule A/B spells its booleans Y/N — unlike the true/false the
    private-fund tables use in the same archive."""
    return series.astype(str).str.strip().str.upper().eq("Y")


def parse_schedule_ab(raw: pd.DataFrame) -> pd.DataFrame:
    headers = {normalize_header(c): c for c in raw.columns}
    missing = [k for k, cands in COLUMNS.items() if _resolve(headers, cands) is None]
    if "filing_id" in missing or "schedule" in missing or "owner_name" in missing:
        raise SystemExit(
            f"error: Schedule A/B is missing required columns {missing}; "
            "the archive layout changed — update COLUMNS in etl/ownership.py."
        )

    out = pd.DataFrame()
    for field, candidates in COLUMNS.items():
        col = _resolve(headers, candidates)
        if col is None:
            out[field] = None
            continue
        if field in ("is_control_person", "is_public_reporting"):
            out[field] = _yes_no(raw[col])
        elif field == "filing_id":
            out[field] = pd.to_numeric(raw[col], errors="coerce")
        else:
            out[field] = raw[col].astype(str).str.strip().replace({"": None, "nan": None})

    out["schedule"] = out["schedule"].str.upper()
    out = out.dropna(subset=["filing_id", "owner_name"])
    out["filing_id"] = out["filing_id"].astype("int64")
    return out[out["schedule"].isin(("A", "B"))]


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    return con


def stage_load(con: duckdb.DuckDBPyConnection) -> None:
    """Load every not-yet-loaded archive's Schedule A/B rows, joined to CRD."""
    loaded = {
        r[0]
        for r in con.execute("SELECT DISTINCT source_archive FROM ownership_filings").fetchall()
    }
    for path in sorted(PULSE_RAW_DIR.glob("ADV_Filing_Data_*.zip")):
        if path.name in loaded:
            continue
        with zipfile.ZipFile(path) as zf:
            base_member = _archive_member(zf, r"IA_ADV_Base_A_\d{8}_\d{8}\.csv")
            ab_member = _archive_member(zf, SCHEDULE_AB_RE)
            if not base_member or not ab_member:
                print(f"note: missing base/Schedule A-B member in {path.name}, skipping")
                continue

            base = parse_base_a(_read_member_csv(zf, base_member))[
                ["filing_id", "crd", "date_submitted"]
            ]
            # keep_default_na=False: Schedule A codes 'under 5%' as the literal
            # string "NA", which pandas' default NA handling would erase.
            rows = parse_schedule_ab(_read_member_csv(zf, ab_member, keep_default_na=False))
            # inner join: a Schedule A/B row whose filing isn't in the base
            # table has no CRD to attach to and would be unusable.
            rows = rows.merge(base, on="filing_id", how="inner")
            rows["source_archive"] = path.name

            con.execute("DELETE FROM ownership_filings WHERE source_archive = ?", [path.name])
            con.register("staging_own", rows)
            cols = ", ".join(rows.columns)
            con.execute(
                f"INSERT INTO ownership_filings ({cols}) SELECT {cols} FROM staging_own"  # nosec B608 — cols is derived from COLUMNS, not input
            )
            con.unregister("staging_own")
            print(f"loaded {path.name}: {len(rows):,} ownership rows")


def stage_snapshot(con: duckdb.DuckDBPyConnection) -> None:
    """Rebuild firm_owners: every owner row from each firm's most recent
    ownership-bearing filing.

    Deliberately keyed on the winning FILING rather than merging owners across
    filings: an owner who disappears from a later filing has left, and carrying
    them forward would show departed officers as current.
    """
    con.execute("DELETE FROM firm_owners")
    con.execute(
        """
        INSERT INTO firm_owners
        SELECT crd, filing_id, schedule, owner_name, owner_id, entity_type,
               owned_entity, title_or_status, status_acquired, ownership_code,
               is_control_person, is_public_reporting
        FROM (
            -- dense_rank, not row_number: every owner row of the winning
            -- filing ties at rank 1, which is exactly the set we want.
            SELECT *, dense_rank() OVER (
                       PARTITION BY crd
                       ORDER BY date_submitted DESC, filing_id DESC
                   ) AS filing_rank
            FROM ownership_filings
        )
        WHERE filing_rank = 1
        """
    )
    n_rows, n_firms = con.execute(
        "SELECT count(*), count(DISTINCT crd) FROM firm_owners"
    ).fetchone()
    print(f"snapshot: {n_rows:,} owner rows across {n_firms:,} firms")


# Biggest stake first. F is "Other (GP/trustee/elected manager)" rather than a
# percentage, so it sorts below every percentage band instead of pretending to
# rank among them.
_CODE_RANK = {"E": 0, "D": 1, "C": 2, "B": 3, "A": 4, "NA": 5, "F": 6}

# 98.8% of firms have 25 or fewer owner rows; the largest has 137. Capping
# keeps the export from being dominated by a handful of huge filers, and the
# card tells the reader how many were withheld.
MAX_OWNERS_PER_FIRM = 25

# Workers Static Assets caps a single file at 25 MiB; leave real headroom.
MAX_EXPORT_MIB = 22.0


def export_firm_owners(db_path: Path, out_path: Path) -> bool:
    """Per-firm owner list for the firm detail view — same lazy-loaded,
    CRD-keyed shape as firm_private_funds.json / advisor_bios.json."""
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(
            """
            SELECT crd, schedule, owner_name, entity_type, owned_entity,
                   title_or_status, status_acquired, ownership_code,
                   is_control_person, is_public_reporting
            FROM firm_owners
            """
        ).fetchall()
    except duckdb.CatalogException:
        rows = []
    finally:
        con.close()

    if not rows:
        print(f"no ownership data in {db_path}; leaving {out_path} untouched")
        return False

    firms: dict[str, list[dict]] = {}
    for (
        crd,
        schedule,
        name,
        entity_type,
        owned_entity,
        title,
        acquired,
        code,
        control,
        public,
    ) in rows:
        # Falsy and null fields are omitted rather than emitted: across 106,857
        # rows most owners have no parent entity, no acquisition date and no
        # public-reporting flag, and writing them out cost 29% of the file for
        # nothing. Consumers must treat a missing key as false/absent.
        owner: dict = {"schedule": schedule, "name": name}
        if title:
            owner["title"] = title
        if acquired:
            owner["since"] = acquired
        if owned_entity:
            owner["owns"] = owned_entity
        # Resolved here rather than in the frontend: the label depends on BOTH
        # schedule and code, and duplicating that pairing in JS is how the two
        # would drift apart. `code` itself is not exported — it only drives the
        # sort below, and shipping both invites them to disagree.
        stake = OWNERSHIP_LABELS.get((schedule, code))
        if stake:
            owner["stake"] = stake
        if entity_type == "I":
            owner["is_individual"] = True
        if entity_type == "FE":
            owner["foreign"] = True
        if control:
            owner["control"] = True
        if public:
            owner["public_reporting"] = True
        owner["_code"] = code  # sort key only; stripped before writing
        firms.setdefault(str(crd), []).append(owner)

    total = sum(len(v) for v in firms.values())
    payload_firms: dict[str, dict] = {}
    for crd, owners in firms.items():
        owners.sort(
            key=lambda o: (
                o["schedule"],
                _CODE_RANK.get(o["_code"], 9),
                not o.get("control", False),
                o["name"] or "",
            )
        )
        kept = owners[:MAX_OWNERS_PER_FIRM]
        for o in kept:
            del o["_code"]
        entry: dict = {"owners": kept}
        if len(owners) > MAX_OWNERS_PER_FIRM:
            entry["omitted"] = len(owners) - MAX_OWNERS_PER_FIRM
        payload_firms[crd] = entry

    body = json.dumps(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "firms": payload_firms,
        },
        separators=(",", ":"),
    )
    # Workers Static Assets rejects any single file over 25 MiB. Fail here,
    # where the cause is obvious, rather than at deploy time on an opaque
    # upload error — the adviser universe only grows.
    size_mb = len(body.encode()) / 1_048_576
    if size_mb > MAX_EXPORT_MIB:
        raise SystemExit(
            f"error: {out_path} would be {size_mb:.1f} MiB, over the {MAX_EXPORT_MIB} MiB "
            "guard (Workers Static Assets caps a single file at 25 MiB). Lower "
            "MAX_OWNERS_PER_FIRM or split the export."
        )

    out_path.write_text(body)
    print(
        f"exported {total:,} owner rows for {len(payload_firms):,} firms "
        f"to {out_path} ({size_mb:.1f} MiB)"
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["load", "snapshot", "export", "run"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OWNERS_OUT)
    args = parser.parse_args()

    if args.stage == "export":
        export_firm_owners(args.db, args.out)
        return 0

    con = connect(args.db)
    try:
        if args.stage in ("load", "run"):
            stage_load(con)
        if args.stage in ("snapshot", "run"):
            stage_snapshot(con)
    finally:
        con.close()
    if args.stage == "run":
        export_firm_owners(args.db, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
