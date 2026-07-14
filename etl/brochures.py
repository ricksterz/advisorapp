"""Brochure PDF pipeline: Form ADV Part 2A -> deal-structuring flags.

Populates the deal_structuring table (proprietary_funds, revenue_sharing,
affiliated_gp_lp) from firm brochures, with the matched snippet stored per
flag so every flag is auditable. Extraction is deliberately explainable
keyword/section heuristics — consistent with the app's methodology-as-code
positioning — not a model.

Data sources (public, no key; see docs/pdf-pipeline-scope.md):
- brochure inventory: https://api.adviserinfo.sec.gov/search/firm/{crd}
- brochure PDF: files.adviserinfo.sec.gov .../crd_iapd_Brochure.aspx?BRCHR_VRSN_ID={id}

Stages are resumable and incremental (keyed on brochureVersionID); PDFs and
extracted text live in a local cache dir, never in git.

Usage:
    python -m etl.brochures run --db data/advisor.duckdb --limit 200
    python -m etl.brochures enumerate --limit 500     # inventory only
    python -m etl.brochures fetch                      # download missing PDFs
    python -m etl.brochures flags                      # extract + flag
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import requests

from etl.config import HTTP_HEADERS, REPO_ROOT, SCHEMA_PATH
from etl.config import DB_PATH as DEFAULT_DB

FIRM_API = "https://api.adviserinfo.sec.gov/search/firm/{crd}"
BROCHURE_PDF = (
    "https://files.adviserinfo.sec.gov/IAPD/Content/Common/"
    "crd_iapd_Brochure.aspx?BRCHR_VRSN_ID={version_id}"
)
CACHE_DIR = REPO_ROOT / "data" / "brochures"  # gitignored via data/
THROTTLE_SECONDS = 0.5  # polite crawl of a public regulator API

# The adviserinfo WAF 403s bot-style User-Agents (including the project's
# HTTP_HEADERS one and "Mozilla/5.0 (compatible; ...)"); it requires a full
# browser UA string. Same public, keyless endpoints the IAPD site itself uses.
API_HEADERS = {
    **HTTP_HEADERS,
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
}

# ---------------------------------------------------------------------------
# Flag heuristics. Each flag: section anchors (Part 2A item headings that make
# a match high-confidence) + patterns. A pattern match inside an anchored
# section sets the flag; matches elsewhere in the document also count but the
# section split keeps snippets tied to the right disclosure context.
# ---------------------------------------------------------------------------

FLAG_PATTERNS: dict[str, re.Pattern] = {
    # Firm places clients in funds it (or an affiliate) manages/sponsors.
    "proprietary_funds": re.compile(
        r"proprietary fund|affiliated fund|invest(?:s|ing)? client (?:assets|accounts) in "
        r"(?:funds?|vehicles?) (?:managed|sponsored|advised) by|"
        r"funds? (?:that (?:we|the firm)|managed by (?:us|the firm|an affiliate))|"
        r"recommends? (?:its|our) own (?:funds?|products?)",
        re.IGNORECASE,
    ),
    # Referral / revenue-sharing compensation arrangements.
    "revenue_sharing": re.compile(
        r"revenue[- ]shar\w+|referral fee|compensat\w+ for (?:client )?referrals|"
        r"solicit\w+ arrangement|paid (?:a portion|a percentage) of (?:the )?(?:advisory )?fees?|"
        r"12b-1 fee",
        re.IGNORECASE,
    ),
    # Affiliate serves as GP / managing member of fund structures.
    "affiliated_gp_lp": re.compile(
        r"(?:serves?|acts?|acting) as (?:the )?(?:general partner|managing member)|"
        r"affiliated? (?:entity |company )?(?:is|as) (?:the )?general partner|"
        r"general partner of (?:the|each|certain|various|one or more) "
        r"(?:funds?|partnerships?|vehicles?)|affiliated general partner",
        re.IGNORECASE,
    ),
}

SNIPPET_CHARS = 160


def extract_pdf_text(pdf_path: Path) -> str | None:
    """Text of a brochure PDF, or None when extraction fails."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(pdf_path))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception:  # damaged/encrypted PDFs happen in the wild
        return None


def textify(pdf_path: Path) -> Path | None:
    """Convert a cached PDF to its .txt sidecar and delete the PDF.

    Extracted text is what the flags stage reads and is ~50-100x smaller than
    the PDF, which keeps the full-universe corpus in low single-digit GB.
    On extraction failure the PDF is kept so a later pass can retry.
    """
    text = extract_pdf_text(pdf_path)
    if text is None:
        return None
    txt_path = pdf_path.with_suffix(".txt")
    txt_path.write_text(text, encoding="utf-8", errors="replace")
    pdf_path.unlink()
    return txt_path


# Brochures constantly *disclaim* these arrangements ("does not act as the
# general partner…", "Item 14 …: The Adviser does not compensate for client
# referrals"), and Item headings repeat the key phrases verbatim. A match is
# only accepted when no negation token appears nearby on either side; later
# affirmative matches in the same brochure still count.
NEGATION_WINDOW = 70
NEGATION = re.compile(
    r"\b(?:not|no|none|never|neither|nor|without|prohibits?|prohibited)\b", re.IGNORECASE
)


def _negated(flat: str, start: int, end: int) -> bool:
    # Windows stop at sentence boundaries so a "not" in an adjacent sentence
    # doesn't suppress a genuine affirmative match.
    before = re.split(r"[.;]", flat[max(0, start - NEGATION_WINDOW) : start])[-1]
    after = re.split(r"[.;]", flat[end : end + NEGATION_WINDOW])[0]
    return bool(NEGATION.search(before) or NEGATION.search(after))


def find_flags(text: str) -> dict[str, str]:
    """Return {flag: snippet} for each pattern affirmatively matched in the text."""
    flat = re.sub(r"\s+", " ", text)
    found: dict[str, str] = {}
    for flag, pattern in FLAG_PATTERNS.items():
        for m in pattern.finditer(flat):
            if _negated(flat, m.start(), m.end()):
                continue
            start = max(0, m.start() - SNIPPET_CHARS // 2)
            found[flag] = flat[start : m.end() + SNIPPET_CHARS // 2].strip()
            break
    return found


def parse_brochure_response(payload: dict) -> list[dict]:
    """brochuredetails from a firm-API response; [] when the firm has none."""
    try:
        source = payload["hits"]["hits"][0]["_source"]
        content = json.loads(source["iacontent"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return []
    return [
        {
            "version_id": b["brochureVersionID"],
            "name": b.get("brochureName"),
            "date_submitted": b.get("dateSubmitted"),
        }
        for b in (content.get("brochures") or {}).get("brochuredetails", [])
        if b.get("brochureVersionID")
    ]


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text())
    # CREATE TABLE IF NOT EXISTS doesn't alter tables that predate a schema
    # change; bring older databases up to date.
    con.execute("ALTER TABLE deal_structuring ADD COLUMN IF NOT EXISTS evidence VARCHAR")
    return con


def stage_enumerate(con: duckdb.DuckDBPyConnection, limit: int | None, rescan: bool = False) -> None:
    """Fetch each firm's brochure inventory.

    By default skips firms already enumerated, so an interrupted initial
    crawl resumes cheaply. Pass rescan=True for a data refresh: brochures get
    amended over time, so re-checking every firm is the only way to notice a
    new or replaced version_id for a firm we've already seen. INSERT OR
    REPLACE keyed on version_id makes this cheap when nothing changed.
    """
    query = "SELECT crd FROM firms ORDER BY aum_total DESC NULLS LAST"
    if not rescan:
        query = """
            SELECT f.crd FROM firms f
            WHERE f.crd NOT IN (SELECT DISTINCT firm_crd FROM brochures)
            ORDER BY f.aum_total DESC NULLS LAST
        """
    crds = [r[0] for r in con.execute(query).fetchall()]
    if limit:
        crds = crds[:limit]
    session = requests.Session()
    new = failed = 0
    for i, crd in enumerate(crds):
        try:
            resp = session.get(FIRM_API.format(crd=crd), headers=API_HEADERS, timeout=30)
            resp.raise_for_status()
            brochures = parse_brochure_response(resp.json())
        except (requests.RequestException, ValueError) as exc:
            # No sentinel on failure — the firm stays un-enumerated so the
            # next run retries it instead of treating it as brochure-free.
            failed += 1
            if failed <= 3:
                print(f"note: firm {crd} failed ({exc.__class__.__name__})")
            if failed >= 10 and new == 0:
                sys.exit("error: every request is failing — API blocked? aborting enumerate")
            time.sleep(THROTTLE_SECONDS)
            continue
        # A no-brochure sentinel row (version_id = -crd) marks a firm that
        # genuinely reports no brochures, keeping re-runs incremental.
        rows = brochures or [{"version_id": -crd, "name": None, "date_submitted": None}]
        for b in rows:
            con.execute(
                "INSERT OR REPLACE INTO brochures (version_id, firm_crd, name, date_submitted) VALUES (?, ?, ?, ?)",
                [b["version_id"], crd, b["name"], b["date_submitted"]],
            )
        new += len(brochures)
        if (i + 1) % 25 == 0:
            print(f"enumerated {i + 1}/{len(crds)} firms ({new} brochures, {failed} failed)")
        time.sleep(THROTTLE_SECONDS)
    print(f"enumerate done: {len(crds)} firms, {new} brochures, {failed} failed")


def stage_fetch(con: duckdb.DuckDBPyConnection, limit: int | None) -> None:
    """Download brochure PDFs that haven't been fetched yet."""
    rows = con.execute(
        "SELECT version_id FROM brochures WHERE version_id > 0 AND fetched_at IS NULL ORDER BY firm_crd"
    ).fetchall()
    if limit:
        rows = rows[:limit]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    ok = 0
    for i, (version_id,) in enumerate(rows):
        dest = CACHE_DIR / f"{version_id}.pdf"
        try:
            resp = session.get(
                BROCHURE_PDF.format(version_id=version_id), headers=API_HEADERS, timeout=120
            )
            if resp.ok and resp.content[:4] == b"%PDF":
                dest.write_bytes(resp.content)
                textify(dest)  # keep text, drop the PDF (disk budget)
                con.execute(
                    "UPDATE brochures SET fetched_at = ? WHERE version_id = ?",
                    [datetime.now(timezone.utc), version_id],
                )
                ok += 1
        except requests.RequestException:
            pass
        if (i + 1) % 25 == 0:
            print(f"fetched {i + 1}/{len(rows)} ({ok} ok)")
        time.sleep(THROTTLE_SECONDS)
    print(f"fetch done: {ok}/{len(rows)} PDFs")


def stage_flags(con: duckdb.DuckDBPyConnection, limit: int | None) -> None:
    """Flag brochures from their cached text (extracting stragglers from PDF)."""
    rows = con.execute(
        """
        SELECT b.version_id, b.firm_crd, b.name FROM brochures b
        WHERE b.fetched_at IS NOT NULL AND b.text_chars IS NULL
        ORDER BY b.firm_crd
        """
    ).fetchall()
    if limit:
        rows = rows[:limit]
    done = flagged = 0
    for version_id, crd, name in rows:
        txt = CACHE_DIR / f"{version_id}.txt"
        pdf = CACHE_DIR / f"{version_id}.pdf"
        if txt.exists():
            text = txt.read_text(encoding="utf-8", errors="replace")
        elif pdf.exists():
            textified = textify(pdf)
            if textified is None:
                print(f"note: extraction failed for {version_id}")
            text = textified.read_text(encoding="utf-8", errors="replace") if textified else ""
        else:
            continue
        con.execute(
            "UPDATE brochures SET text_chars = ? WHERE version_id = ?", [len(text), version_id]
        )
        flags = find_flags(text) if text else {}
        con.execute("DELETE FROM deal_structuring WHERE source_document = ?", [str(version_id)])
        con.execute(
            """
            INSERT INTO deal_structuring
                (firm_crd, source_document, proprietary_funds, revenue_sharing,
                 affiliated_gp_lp, evidence, extracted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                crd,
                str(version_id),
                "proprietary_funds" in flags,
                "revenue_sharing" in flags,
                "affiliated_gp_lp" in flags,
                json.dumps(flags) if flags else None,
                datetime.now(timezone.utc),
            ],
        )
        done += 1
        flagged += bool(flags)
    print(f"flags done: {done} brochures processed, {flagged} with >=1 flag")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["enumerate", "fetch", "flags", "run"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--limit", type=int, default=None, help="max items per stage")
    parser.add_argument(
        "--rescan",
        action="store_true",
        help="re-check every firm's brochure inventory, not just unenumerated ones "
        "(use for a data refresh; the initial crawl doesn't need this)",
    )
    args = parser.parse_args()

    if not args.db.exists():
        sys.exit(f"error: {args.db} not found — run `python -m etl.ingest_adv` first")
    con = connect(args.db)
    try:
        if args.stage in ("enumerate", "run"):
            stage_enumerate(con, args.limit, rescan=args.rescan)
        if args.stage in ("fetch", "run"):
            stage_fetch(con, args.limit)
        if args.stage in ("flags", "run"):
            stage_flags(con, args.limit)
    finally:
        con.close()


if __name__ == "__main__":
    main()
