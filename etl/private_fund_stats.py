"""Private funds aggregation: private_funds + private_fund_providers ->
frontend/public/private_funds.json.

No single "total private-fund GAV" headline is computed here, on purpose —
same reasoning as the site's homepage/Pulse aggregate-RAUM decision (PR #19,
PR #44): a fund complex's master fund and its feeder funds both report GAV
for effectively the same underlying assets (~3.7% of total GAV in a real
2026-06-30 pull), so a gross sum overstates distinct capital. Feeder funds
are excluded from every GAV sum here; figures are broken out per fund type
rather than combined into one number, which is both more useful and less
prone to the same "shocking total" misreading. A fund whose adviser
discloses it as a subadviser (rather than primary adviser) could in theory
also appear on another filer's schedule — a smaller, unresolved edge case,
noted in the methodology text rather than silently ignored.

Usage:
    python -m etl.private_fund_stats --db data/advisor.duckdb \
        --out frontend/public/private_funds.json \
        --firm-out frontend/public/firm_private_funds.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from etl.config import REPO_ROOT
from etl.config import DB_PATH as DEFAULT_DB

DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "private_funds.json"
DEFAULT_FIRM_OUT = REPO_ROOT / "frontend" / "public" / "firm_private_funds.json"

TOP_N_PROVIDERS = 10
TOP_N_FIRMS = 15
TOP_N_STATES = 10
# FirmDetail's PrivateFundsCard shows at most this many funds per firm
# (frontend/src/components/FirmDetail.jsx PRIVATE_FUNDS_SHOWN) — capping the
# export to match keeps firm_private_funds.json from ballooning on the
# handful of firms with 1000+ funds (uncapped: 30MB raw; capped: 17.6MB raw
# / 1.7MB gzipped, in line with advisor_bios.json's existing footprint).
MAX_FUNDS_PER_FIRM = 20

# Legal-suffix noise collapses distinct spellings of the same real firm
# ("KPMG LLP" / "KPMG" / "KPMG, LLP") for LEAGUE-TABLE GROUPING ONLY — the
# raw provider_name is preserved in the database untouched.
_SUFFIX_RE = re.compile(r"[,.]?\s*(LLP|LLC|L\.L\.P\.|L\.L\.C\.|INC\.?|P\.C\.|LTD\.?)$", re.I)


def _normalize_provider(name: str) -> str:
    prev = None
    n = name.strip().upper()
    while prev != n:
        prev = n
        n = _SUFFIX_RE.sub("", n).strip()
    return n or name.strip().upper()


def fund_type_series(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        """
        SELECT fund_type, count(*),
               sum(gross_asset_value) FILTER (NOT is_feeder_fund),
               median(gross_asset_value) FILTER (NOT is_feeder_fund)
        FROM private_funds
        WHERE fund_type IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC
        """
    ).fetchall()
    return [
        {"type": t, "count": n, "gav": gav, "median_gav": med}
        for t, n, gav, med in rows
    ]


def domicile_series(con: duckdb.DuckDBPyConnection, top_n: int = TOP_N_STATES) -> list[dict]:
    rows = con.execute(
        """
        SELECT coalesce(nullif(state, ''), country), count(*)
        FROM private_funds
        GROUP BY 1 ORDER BY 2 DESC LIMIT ?
        """,
        [top_n],
    ).fetchall()
    return [{"domicile": d, "count": n} for d, n in rows if d]


def top_firms(con: duckdb.DuckDBPyConnection, top_n: int = TOP_N_FIRMS) -> list[dict]:
    rows = con.execute(
        """
        SELECT pf.crd, coalesce(f.business_name, f.legal_name) AS name,
               count(*), sum(pf.gross_asset_value) FILTER (NOT pf.is_feeder_fund)
        FROM private_funds pf
        LEFT JOIN firms f ON f.crd = pf.crd
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT ?
        """,
        [top_n],
    ).fetchall()
    return [{"crd": crd, "name": name, "fund_count": n, "gav": gav} for crd, name, n, gav in rows]


def provider_leagues(con: duckdb.DuckDBPyConnection, top_n: int = TOP_N_PROVIDERS) -> dict[str, list[dict]]:
    roles = [r[0] for r in con.execute("SELECT DISTINCT role FROM private_fund_providers").fetchall()]
    out: dict[str, list[dict]] = {}
    for role in roles:
        rows = con.execute(
            "SELECT provider_name FROM private_fund_providers WHERE role = ?", [role]
        ).fetchall()
        counts: dict[str, int] = {}
        for (name,) in rows:
            key = _normalize_provider(name)
            counts[key] = counts.get(key, 0) + 1
        ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
        out[role] = [{"name": name, "fund_count": n} for name, n in ranked]
    return out


def export_private_fund_stats(db_path: Path, out_path: Path) -> int:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            as_of = con.execute("SELECT max(date_submitted) FROM private_funds").fetchone()[0]
        except duckdb.CatalogException:
            as_of = None
        if as_of is None:
            print("no private-fund snapshot in this database — private fund stats export skipped")
            return 0

        n_funds, n_firms = con.execute(
            "SELECT count(*), count(DISTINCT crd) FROM private_funds"
        ).fetchone()
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "as_of": str(as_of),
            "total_funds": n_funds,
            "total_firms": n_firms,
            "fund_types": fund_type_series(con),
            "domicile": domicile_series(con),
            "top_firms": top_firms(con),
            "providers": provider_leagues(con),
        }
    finally:
        con.close()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported private fund stats ({n_funds} funds, {n_firms} firms) to {out_path}")
    return n_funds


def export_firm_private_funds(db_path: Path, out_path: Path) -> int:
    """Per-firm fund list + named providers, lazy-loaded by FirmDetail —
    same pattern as deal_flags.json / advisor_bios.json."""
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            funds = con.execute(
                """
                SELECT crd, fund_id, fund_name, fund_type, state, country,
                       gross_asset_value, is_master_fund, is_feeder_fund, reference_id, filing_id
                FROM private_funds
                QUALIFY row_number() OVER (
                    PARTITION BY crd ORDER BY gross_asset_value DESC NULLS LAST
                ) <= ?
                ORDER BY crd, gross_asset_value DESC NULLS LAST
                """,
                [MAX_FUNDS_PER_FIRM],
            ).fetchall()
            providers = con.execute(
                "SELECT filing_id, reference_id, role, provider_name FROM private_fund_providers"
            ).fetchall()
        except duckdb.CatalogException:
            funds, providers = [], []
    finally:
        con.close()
    if not funds:
        print("no private-fund data in this database — firm private funds export skipped")
        return 0

    # A fund can have >1 raw provider row for the same (role, name) — e.g. the
    # marketer sub-item carries a SubreferenceID per marketing arrangement, so
    # the same marketer can appear more than once for one fund. Collapse to
    # unique (role, name) pairs: which sub-arrangement it came from isn't
    # something a reader needs, and duplicates would just look like a bug.
    providers_by_fund: dict[tuple, dict[tuple, dict]] = {}
    for filing_id, reference_id, role, name in providers:
        seen = providers_by_fund.setdefault((filing_id, reference_id), {})
        seen[(role, name)] = {"role": role, "name": name}

    firms: dict[str, list[dict]] = {}
    for crd, fund_id, fund_name, fund_type, state, country, gav, is_master, is_feeder, ref_id, filing_id in funds:
        firms.setdefault(str(crd), []).append(
            {
                "fund_id": fund_id,
                "name": fund_name,
                "type": fund_type,
                "domicile": state or country,
                "gav": gav,
                "is_master_fund": bool(is_master),
                "is_feeder_fund": bool(is_feeder),
                "providers": list(providers_by_fund.get((filing_id, ref_id), {}).values()),
            }
        )
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "firms": firms,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"exported {len(funds)} private funds for {len(firms)} firms to {out_path}")
    return len(funds)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--firm-out", type=Path, default=DEFAULT_FIRM_OUT)
    args = parser.parse_args()
    if not args.db.exists():
        sys.exit(f"error: {args.db} not found")
    export_private_fund_stats(args.db, args.out)
    export_firm_private_funds(args.db, args.firm_out)


if __name__ == "__main__":
    main()
