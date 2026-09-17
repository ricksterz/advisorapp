"""Each private fund manager's main fund type: firm_private_funds.json -> firm_fund_types.json.

The site tags a private fund manager with the kind of funds it mostly runs
(hedge, private equity, venture capital, real estate, credit). The per-fund
data lives in firm_private_funds.json, which is ~17 MB -- far too large to load
on the firm list just to filter by it -- so this writes one short code per firm.

"Mostly" means over half of the firm's gross asset value, from Schedule D
7.B.1. Feeder funds are left out because their assets are already counted in
the master fund they invest through. A firm with no reported assets falls back
to fund counts. A firm with no majority type is "mixed".

Usage:
    python -m etl.fund_types \\
        --funds frontend/public/firm_private_funds.json \\
        --out frontend/public/firm_fund_types.json
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from etl.config import REPO_ROOT

DEFAULT_FUNDS = REPO_ROOT / "frontend" / "public" / "firm_private_funds.json"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "firm_fund_types.json"

# Schedule D 7.B.1 fund types, as filed.
TYPE_CODES = {
    "Hedge Fund": "hedge",
    "Private Equity Fund": "private_equity",
    "Venture Capital Fund": "venture",
    "Real Estate Fund": "real_estate",
    "Securitized Asset Fund": "securitized",
    "Liquidity Fund": "liquidity",
    "Other Private Fund": "other",
}


def main_fund_type(funds: list[dict]) -> str | None:
    """The type holding over half of a firm's fund assets, "mixed" when none
    does, or None when the firm reports no typed funds."""
    counted = [f for f in funds if f.get("type") in TYPE_CODES and not f.get("is_feeder_fund")]
    if not counted:
        return None
    weights: dict[str, float] = defaultdict(float)
    total = sum(f.get("gav") or 0 for f in counted)
    for f in counted:
        weights[TYPE_CODES[f["type"]]] += (f.get("gav") or 0) if total > 0 else 1
    grand = sum(weights.values())
    code, weight = max(weights.items(), key=lambda kv: kv[1])
    return code if weight > grand / 2 else "mixed"


def export(funds_path: Path, out_path: Path) -> int:
    source = json.loads(funds_path.read_text())
    firms = {}
    for crd, funds in source.get("firms", {}).items():
        code = main_fund_type(funds)
        if code:
            firms[crd] = code
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_generated_at": source.get("generated_at"),
        "firms": firms,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"wrote {out_path}: main fund type for {len(firms):,} firms")
    return len(firms)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--funds", type=Path, default=DEFAULT_FUNDS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    export(args.funds, args.out)


if __name__ == "__main__":
    main()
