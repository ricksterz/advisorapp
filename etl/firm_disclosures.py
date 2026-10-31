"""Dated disclosure events per firm: Form ADV DRPs -> frontend/data/firm_disclosures.json.

Source: the SEC's monthly Form ADV filing archives that etl/pulse_history.py
already caches in data/raw/pulse/ (advFilingData, January 2025 onward). Each
carries the Disclosure Reporting Pages filed that month as separate tables:

    IA_DRP_Regulatory_*.csv      Item 11.C-11.G: regulator, sanction, money
    IA_DRP_Criminal_*.csv        Item 11.A-11.B: court, charge, disposition
    IA_DRP_Civil_Judicial_*.csv  Item 11.H: court, relief, resolution
    IA_DRP_Advisory_Affiliates_*.csv  which affiliates an event concerns

with dates, status, allegations and, crucially, "Filed Against": the
advisory firm itself, its affiliates, or both. The firm feed the rest of the
site uses reports Item 11 only as yes/no answers, and because Item 11 covers
every advisory affiliate, those answers grow with corporate size rather than
conduct (Morgan Stanley Smith Barney's events on file: 55 against the
adviser itself, the rest against affiliates).

What the real archives taught:

  * A filing does not restate a firm's earlier disclosure pages. Of 10,197
    pairs of consecutive DRP-carrying filings, 8,573 share no event at all.
    A firm's history is therefore the union across every archive, keeping
    each event's most recent version (by ReferenceID).
  * The same event is filed over and over under new ReferenceIDs: 82,450
    rows across the archives hold 11,502 distinct events, and one Edward
    Jones matter appears 909 times. Events are therefore also deduplicated
    by content (type, target, date, regulator or court, amount, text).
  * Events can be withdrawn: Remove-Affiliate (the affiliate left),
    Remove-Expired, Remove-Filed in Error. The latest version decides.
  * So coverage is events filed or updated since the first cached archive.
    Older events a firm hasn't touched since are not here; the site says so
    and links to the SEC's own record, which has everything.

Writes a build input, not a served file (it's large); the frontend build
(frontend/scripts/shard-data.mjs) cuts it into per-firm shards and the small
index the disclosure-outlier list reads.

Usage:
    python -m etl.firm_disclosures
"""

from __future__ import annotations

import argparse
import io
import json
import re
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd

from etl.config import RAW_DIR, REPO_ROOT

ARCHIVE_DIR = RAW_DIR / "pulse"
DEFAULT_OUT = REPO_ROOT / "frontend" / "data" / "firm_disclosures.json"
TEXT_LIMIT = 320

# Per DRP table: the columns that hold the same idea under different names.
KINDS = {
    "Regulatory": {
        "code": "R",
        "date": "Date Initiated",
        "by": "Initiated By",
        "what": ["Principal Sanction", "Principal Product"],
        "status": "Status",
        "resolution": "Resolution",
        "resolved": "Resolution Date",
        "text": ["Allegations", "Summary"],
    },
    "Criminal": {
        "code": "C",
        "date": "Date First Charged",
        "by": "Court",
        "what": ["Event Detail"],
        "status": "Status",
        "resolution": "Disposition",
        "resolved": "Status Date",
        "text": ["Summary", "Event Detail"],
    },
    "Civil_Judicial": {
        "code": "J",
        "date": "Filing Date",
        "by": "Initiated By",
        "what": ["Relief Sought"],
        "status": "Status",
        "resolution": "Resolution Type",
        "resolved": "Resolution Date",
        "text": ["Allegations", "Summary"],
    },
}
AGAINST = {"Advisory Firm": "F", "Affiliates": "A", "Firm and Affiliates": "B"}
REMOVE_COLUMNS = ("Remove-Affiliate", "Remove-Expired", "Remove-Filed in Error")


def read_csv(data: bytes, **kw) -> pd.DataFrame:
    # Free-text columns break a handful of rows per archive; skip those
    # rather than lose the file (same tolerance as etl/pulse_history.py).
    return pd.read_csv(
        io.BytesIO(data),
        dtype=str,
        encoding="latin-1",
        engine="python",
        on_bad_lines="skip",
        keep_default_na=False,  # empty cells stay "", never float NaN
        **kw,
    )


def iso_date(value) -> str | None:
    """'05/21/2024' -> '2024-05-21'; '2024' or '05/2024' keep what they have."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", v)
    if m:
        return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}"
    m = re.fullmatch(r"(\d{1,2})/(\d{4})", v)
    if m:
        return f"{m[2]}-{int(m[1]):02d}"
    m = re.fullmatch(r"(\d{4})", v)
    return m[1] if m else None


def clean(value, limit: int | None = None) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value).strip()
    if not text or text.upper() in {"N/A", "NA", "NONE"}:
        return None
    if limit and len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0] + "…"
    return text


def amount(value) -> int | None:
    try:
        n = float(re.sub(r"[$,\s]", "", value)) if isinstance(value, str) else None
    except ValueError:
        return None
    return int(n) if n and n > 0 else None


def first(row, columns) -> str | None:
    for c in columns:
        v = clean(row.get(c), TEXT_LIMIT)
        if v:
            return v
    return None


def event_from_row(row: dict, spec: dict) -> dict:
    return {
        "kind": spec["code"],
        "against": AGAINST.get((row.get("Filed Against") or "").strip(), "F"),
        "date": iso_date(row.get(spec["date"])),
        "by": clean(row.get(spec["by"]), 120),
        "what": first(row, spec["what"]),
        "status": clean(row.get(spec["status"]), 40),
        "resolution": clean(row.get(spec["resolution"]), 80),
        "resolved": iso_date(row.get(spec["resolved"])),
        "amount": amount(row.get("Monetary Amount")),
        "text": first(row, spec["text"]),
        "removed": any((row.get(c) or "").strip().upper() == "Y" for c in REMOVE_COLUMNS),
    }


def archive_period(name: str) -> tuple[str, str] | None:
    m = re.search(r"(\d{8})_(\d{8})", name)
    if not m:
        return None
    return tuple(f"{s[:4]}-{s[4:6]}-{s[6:]}" for s in (m[1], m[2]))


def read_archive(path: Path) -> list[tuple[str, int, str, dict, list[str]]]:
    """(crd, filing id, ref, event, affiliate names) for every DRP row."""
    out = []
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()

        def member(prefix):
            return next((n for n in names if n.startswith(prefix)), None)

        base = member("IA_ADV_Base_A_")
        if not base:
            return out
        filings = read_csv(zf.read(base), usecols=lambda c: c in ("FilingID", "1E1"))
        crd_of = dict(zip(filings["FilingID"], filings["1E1"]))

        affiliates: dict[tuple[str, str], list[str]] = {}
        aff = member("IA_DRP_Advisory_Affiliates_")
        if aff:
            for r in read_csv(zf.read(aff)).to_dict("records"):
                name = clean(r.get("Affiliate Name"), 80)
                if name:
                    affiliates.setdefault((r["FilingID"], r["ReferenceID"]), []).append(name)

        for kind, spec in KINDS.items():
            m = member(f"IA_DRP_{kind}_")
            if not m:
                continue
            for r in read_csv(zf.read(m)).to_dict("records"):
                crd = crd_of.get(r.get("FilingID"))
                ref = r.get("ReferenceID")
                if not crd or not ref:
                    continue
                out.append(
                    (
                        crd,
                        int(r["FilingID"]),
                        f"{spec['code']}{ref}",
                        event_from_row(r, spec),
                        affiliates.get((r["FilingID"], ref), []),
                    )
                )
    return out


def content_key(e: dict) -> tuple:
    return (
        e["kind"], e["against"], e.get("date"), e.get("by"), e.get("amount"),
        (e.get("text") or "")[:160], e.get("what"),
    )


def merge(rows) -> dict[str, list[dict]]:
    """Latest version of each event per firm, removed events dropped,
    copies of the same event under different ReferenceIDs folded into one
    (their affiliate names merged), newest first."""
    latest: dict[tuple[str, str], tuple[int, dict, list[str]]] = {}
    for crd, fid, ref, event, affiliates in rows:
        key = (crd, ref)
        if key not in latest or fid > latest[key][0]:
            latest[key] = (fid, event, affiliates)
    distinct: dict[str, dict[tuple, dict]] = {}
    for (crd, ref), (_, event, affiliates) in sorted(latest.items()):
        if event["removed"]:
            continue
        e = {k: v for k, v in event.items() if k != "removed" and v is not None}
        events = distinct.setdefault(crd, {})
        kept = events.setdefault(content_key(e), {**e, "ref": ref})
        if affiliates and event["against"] != "F":
            names = kept.setdefault("affiliates", [])
            names.extend(n for n in affiliates if n not in names)
    firms: dict[str, list[dict]] = {}
    for crd, events in distinct.items():
        listed = list(events.values())
        for e in listed:
            if "affiliates" in e:
                e["affiliates"] = e["affiliates"][:5]
        listed.sort(key=lambda e: e.get("date") or "", reverse=True)
        firms[crd] = listed
    return firms


def export(archive_dir: Path, out_path: Path) -> int:
    archives = sorted(archive_dir.glob("ADV_Filing_Data_*.zip"))
    if not archives:
        print(f"no Form ADV archives in {archive_dir}; run `python -m etl.pulse_history fetch` first")
        return 0
    rows = [row for path in archives for row in read_archive(path)]
    firms = merge(rows)
    periods = [p for p in (archive_period(a.name) for a in archives) if p]
    payload = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "covers_from": min(p[0] for p in periods),
        "as_of": max(p[1] for p in periods),
        "archives": len(archives),
        "firms": firms,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    events = sum(len(v) for v in firms.values())
    print(
        f"wrote {out_path}: {events:,} disclosure events at {len(firms):,} firms, "
        f"filed or updated {payload['covers_from']} to {payload['as_of']} "
        f"({out_path.stat().st_size / 1e6:.1f} MB)"
    )
    return events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--archives", type=Path, default=ARCHIVE_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    export(args.archives, args.out)


if __name__ == "__main__":
    main()
