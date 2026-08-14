"""Ownership change timeline from consecutive Form ADV filings.

etl/ownership.py keeps only each firm's most recent ownership-bearing filing.
ownership_filings, though, holds every filing across all cached archives — so
diffing consecutive filings per firm yields when an owner or officer arrived,
left, or changed stake. That is the one thing a current-state card cannot show.

IDENTITY IS THE WHOLE PROBLEM. Matching a party across filings by name alone
is wrong in both directions, verified against a real 2026-06 pull (19,055
rows, 522 filings containing a repeated name):

  - 384 repeats are the SAME party at two points of a Schedule B chain,
    distinguished only by which entity they own. Ignoring owned_entity merges
    them and invents departures when one link changes.
  -   8 repeats are DIFFERENT people who share a name, distinguished only by
    OwnerID. Keying on name alone silently merges two humans.
  - 122 repeats are one person holding two titles ("PRESIDENT" and
    "SHAREHOLDER"). These SHOULD collapse to one identity, so titles are
    aggregated per identity rather than treated as distinguishing.

OwnerID would be the natural key but is only populated for individuals: 100%
of them, against 3% of domestic and 2% of foreign entities. So the key is
OwnerID when present and the normalized name otherwise, always paired with
schedule and owned_entity.

Usage:
    python -m etl.ownership_changes --db data/advisor.duckdb \
        --out frontend/public/ownership_changes.json
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import REPO_ROOT
from etl.ownership import OWNERSHIP_LABELS

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "ownership_changes.json"

# Most firms amend once or twice a year; a firm with a long tail of events is
# usually a large filer restating routinely rather than genuinely churning.
MAX_EVENTS_PER_FIRM = 40

_PUNCT = re.compile(r"[^A-Z0-9 ]")
_WS = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    """Loose match for parties with no OwnerID (i.e. entities).

    Deliberately gentler than provider_stats.provider_key: that one strips
    entity-type words to merge "Wells Fargo & Co" with "& Company", which is
    right for ranking providers but wrong here, where "SMITH HOLDINGS LLC" and
    "SMITH HOLDINGS LP" may be genuinely different links in a chain.
    """
    return _WS.sub(" ", _PUNCT.sub(" ", (name or "").upper())).strip()


def identity(row: dict) -> tuple:
    """Stable key for one party within one schedule of one firm's filings."""
    owner_id = (row.get("owner_id") or "").strip()
    who = f"id:{owner_id}" if owner_id else f"nm:{normalize_name(row.get('owner_name'))}"
    return (row.get("schedule"), who, normalize_name(row.get("owned_entity")))


def _party(rows: list[dict]) -> dict:
    """Collapse the rows sharing one identity in a single filing.

    Titles are unioned rather than picked: one person legitimately appears
    twice with two roles, and choosing arbitrarily would flip between filings
    and read as a change that never happened.
    """
    first = rows[0]
    titles = sorted({(r.get("title_or_status") or "").strip() for r in rows if r.get("title_or_status")})
    return {
        "name": first.get("owner_name"),
        "schedule": first.get("schedule"),
        "owns": first.get("owned_entity"),
        "code": first.get("ownership_code"),
        "titles": titles,
        "is_individual": first.get("entity_type") == "I",
    }


def diff_filings(prev: list[dict], curr: list[dict]) -> list[dict]:
    """Events between two consecutive filings of the same firm."""
    def by_identity(rows):
        out: dict[tuple, list[dict]] = {}
        for r in rows:
            out.setdefault(identity(r), []).append(r)
        return {k: _party(v) for k, v in out.items()}

    a, b = by_identity(prev), by_identity(curr)
    events: list[dict] = []

    for key in b.keys() - a.keys():
        p = b[key]
        events.append({"type": "added", **_public(p)})
    for key in a.keys() - b.keys():
        p = a[key]
        events.append({"type": "removed", **_public(p)})
    for key in a.keys() & b.keys():
        before, after = a[key], b[key]
        if before["code"] != after["code"]:
            events.append(
                {
                    "type": "stake_changed",
                    **_public(after),
                    "from_stake": OWNERSHIP_LABELS.get((before["schedule"], before["code"])),
                }
            )
    # Deterministic order so the export is stable between runs.
    events.sort(key=lambda e: (e["type"], e.get("name") or ""))
    return events


def _public(party: dict) -> dict:
    out = {
        "name": party["name"],
        "schedule": party["schedule"],
        "stake": OWNERSHIP_LABELS.get((party["schedule"], party["code"])),
    }
    if party["titles"]:
        out["title"] = "; ".join(party["titles"])
    if party["owns"]:
        out["owns"] = party["owns"]
    if party["is_individual"]:
        out["is_individual"] = True
    return out


def build_changes(con: duckdb.DuckDBPyConnection) -> dict:
    rows = con.execute(
        """
        SELECT crd, filing_id, date_submitted, schedule, owner_name, owner_id,
               entity_type, owned_entity, title_or_status, ownership_code
        FROM ownership_filings
        ORDER BY crd, date_submitted, filing_id
        """
    ).fetchall()
    cols = [
        "crd", "filing_id", "date_submitted", "schedule", "owner_name", "owner_id",
        "entity_type", "owned_entity", "title_or_status", "ownership_code",
    ]

    # crd -> filing_id -> rows, preserving filing order
    per_firm: dict[int, dict] = {}
    for r in rows:
        d = dict(zip(cols, r))
        per_firm.setdefault(d["crd"], {}).setdefault(
            (d["date_submitted"], d["filing_id"]), []
        ).append(d)

    firms: dict[str, list[dict]] = {}
    for crd, filings in per_firm.items():
        ordered = sorted(filings.items())
        if len(ordered) < 2:
            continue  # nothing to diff — one filing is not a change
        timeline = []
        for (_, prev_rows), (curr_key, curr_rows) in itertools.pairwise(ordered):
            events = diff_filings(prev_rows, curr_rows)
            if not events:
                continue
            timeline.append(
                {
                    "date": str(curr_key[0]),
                    "filing_id": curr_key[1],
                    "events": events,
                }
            )
        if timeline:
            timeline.reverse()  # newest first
            firms[str(crd)] = timeline[:MAX_EVENTS_PER_FIRM]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "firms": firms,
    }


def export_ownership_changes(db_path: Path, out_path: Path) -> bool:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        payload = build_changes(con)
    except duckdb.CatalogException:
        payload = {"firms": {}}
    finally:
        con.close()

    if not payload.get("firms"):
        print(f"no ownership history in {db_path}; leaving {out_path} untouched")
        return False

    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    n_events = sum(len(e["events"]) for v in payload["firms"].values() for e in v)
    print(
        f"exported {n_events:,} ownership events across "
        f"{len(payload['firms']):,} firms to {out_path}"
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    export_ownership_changes(args.db, args.out)


if __name__ == "__main__":
    main()
