"""Service-provider league table from Form ADV Schedule D 7.B.1.

Every private fund names the firms that audit it, hold its assets, administer
it, broker for it and market it (7.B.1.(a).23/24/25/26/28). etl/private_funds.py
already loads those rows; this ranks them, answering "which auditors and
custodians does the registered-adviser industry actually use, and how big are
the advisers behind them".

No new data source: it reads private_fund_providers, the reconstructed
latest-known-state table, and joins it back to the funds it serves.

Two correctness decisions worth knowing about:

1. Providers join to funds on BOTH filing_id and reference_id. reference_id is
   only unique within a single filing (see schema.sql), so joining on it alone
   silently attaches providers to the wrong funds.

2. Gross asset value excludes feeder funds. A master/feeder pair reports the
   same capital twice -- the trap PR #49 fixed for the private-funds page --
   so summing raw GAV would overstate every provider's book. Fund and firm
   counts are unaffected and use all rows.

Deliberate non-goal: this ranks legal entities as filed, not parent brands.
"Goldman Sachs & Co. LLC", "Goldman Sachs Bank USA" and "Goldman Sachs
International" are three different entities doing different jobs, and rolling
them into one "Goldman Sachs" row would require a hand-maintained alias map
that silently rots as entities are renamed. Filed-entity precision is the
honest default; a brand layer, if ever wanted, belongs on top of it.

Usage:
    python -m etl.provider_stats --db data/advisor.duckdb \
        --out frontend/public/service_providers.json
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.private_fund_stats import _normalize_provider

TOP_N = 40

ROLE_LABELS = {
    "auditor": "Auditors",
    "custodian": "Custodians",
    "prime_broker": "Prime brokers",
    "administrator": "Administrators",
    "marketer": "Marketers",
}

# Entity-type words that carry no identity: dropping them merges "Wells Fargo
# & Co" with "Wells Fargo & Company", and "Computershare Trust Co" with
# "Computershare Trust Company NA". Verified against the real corpus -- of 474
# groups that merge only because of this, every one sampled was the same firm
# written differently, not two firms collapsed into one.
_ENTITY_WORDS = re.compile(
    r"\b(LLP|LLC|INC|PC|PLLC|LTD|LP|NA|CO|CORP|COMPANY|LIMITED|AND)\b"
)


def provider_key(name: str) -> str:
    """Grouping key that survives punctuation, spacing and entity-type noise.

    _normalize_provider alone strips trailing suffixes, which leaves real
    splits in the filed data: "PRICEWATERHOUSECOOPERS" vs "PRICEWATERHOUSE
    COOPERS" (a space), "J.P. MORGAN CHASE BANK" vs "JPMORGAN CHASE BANK"
    (two periods), plus stray quotes and doubled spaces from hand-typed
    filings. Collapsing all of it merges 1,756 keys that are genuinely the
    same firm.

    Kept separate from _normalize_provider rather than replacing it: that
    function also groups Form D placement agents, and changing it would move
    already-published numbers on the capital-formation page. Worth unifying,
    but as its own change with its own before/after.
    """
    n = re.sub(r"[^A-Z0-9 ]", " ", _normalize_provider(name).upper())
    n = re.sub(r"\s+", " ", n).strip()
    # Dropping punctuation splits initialisms into loose letters -- "J.P."
    # becomes "J P" and "N.A." becomes "N A" -- which then hide from the
    # entity-word pass below, so "JPMORGAN CHASE BANK" and "J.P. MORGAN CHASE
    # BANK, N.A." stayed separate. Rejoin adjacent single letters first.
    prev = None
    while prev != n:
        prev = n
        n = re.sub(r"\b([A-Z]) (?=[A-Z]\b)", r"\1", n)
    prev = None
    while prev != n:
        prev = n
        n = re.sub(r"\s+", " ", _ENTITY_WORDS.sub(" ", n)).strip()
    collapsed = re.sub(r"\s+", "", n)
    # A name made entirely of entity words ("LLC") would collapse to nothing;
    # fall back to the raw text so those rows stay distinct instead of merging.
    return collapsed or name.strip().upper()


def provider_rows(con: duckdb.DuckDBPyConnection) -> list[tuple]:
    return con.execute(
        """
        SELECT p.role, p.provider_name, f.crd, f.gross_asset_value, f.is_feeder_fund
        FROM private_fund_providers p
        JOIN private_funds f USING (filing_id, reference_id)
        WHERE p.provider_name IS NOT NULL AND trim(p.provider_name) <> ''
        """
    ).fetchall()


def rank_providers(rows: list[tuple], top_n: int = TOP_N) -> dict[str, list[dict]]:
    grouped: dict[tuple[str, str], dict] = {}
    for role, name, crd, gav, is_feeder in rows:
        entry = grouped.setdefault(
            (role, provider_key(name)),
            {"firms": set(), "funds": 0, "gav": 0.0, "spellings": {}},
        )
        entry["funds"] += 1
        if crd is not None:
            entry["firms"].add(crd)
        entry["spellings"][name] = entry["spellings"].get(name, 0) + 1
        if not is_feeder and gav:
            entry["gav"] += gav

    by_role: dict[str, list[dict]] = {}
    for (role, _key), entry in grouped.items():
        by_role.setdefault(role, []).append(
            {
                # Display the spelling the filings use most often, so the row
                # reads the way the industry writes it rather than as the
                # punctuation-stripped grouping key.
                "name": max(entry["spellings"].items(), key=lambda kv: kv[1])[0],
                "firms": len(entry["firms"]),
                "funds": entry["funds"],
                "gav": entry["gav"] or None,
                "variants": len(entry["spellings"]),
            }
        )
    for role, entries in by_role.items():
        entries.sort(key=lambda e: (-e["firms"], -e["funds"], e["name"]))
        by_role[role] = entries[:top_n]
    return by_role


def export_provider_stats(db_path: Path, out_path: Path) -> bool:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = provider_rows(con)
    finally:
        con.close()

    # CI ingests a fresh ADV base with no private-fund archives, so the table
    # is empty there. Skip rather than overwrite the committed file with an
    # empty one -- same guard every other export_* uses.
    if not rows:
        print(f"no provider data in {db_path}; leaving {out_path} untouched")
        return False

    by_role = rank_providers(rows)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "roles": [
            {"role": r, "label": ROLE_LABELS.get(r, r), "providers": by_role[r]}
            for r in ROLE_LABELS
            if by_role.get(r)
        ],
        "total_relationships": len(rows),
    }
    out_path.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")
    print(
        f"wrote {out_path} ({len(payload['roles'])} roles, "
        f"{len(rows):,} fund-provider relationships)"
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    export_provider_stats(args.db, args.out)


if __name__ == "__main__":
    main()
