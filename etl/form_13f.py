"""Form 13F institutional holdings: SEC data sets -> DuckDB -> form_13f.json.

Source: SEC's Form 13F data sets, one zip per three-month filing window
(SUBMISSION, COVERPAGE, SUMMARYPAGE, OTHERMANAGER2, INFOTABLE, plus a readme).
Schema verified against the real 01jun2026-31aug2026 file on 2026-09-16.

    https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets

A 13F lists a manager's US-listed stock, ETF, option and convertible positions
at quarter end. It is not assets under management, and the site says so.

What the real file taught, all checked rather than assumed:

  * Filers report their own CRD and SEC file number when they have one, and
    most firms match on those exactly. CRD is optional on the form, though,
    and about 2,300 registered advisers leave it blank; those are matched on
    exact name plus state, verified against the city on both filings (see
    export). Nothing is matched fuzzily.
  * The biggest filers without a CRD are parent holding companies, not hidden
    family offices: BlackRock, Inc., State Street Corp and FMR file one
    combined report and name their subsidiary advisers as "included managers".
    About 400 registered firms appear only that way. They are linked to the parent's
    filing and labelled as such, never credited with the parent's portfolio.
  * Every data set carries late filings for old periods (a 2001 quarter filed
    in 2026), so the export picks the quarter most filers reported on.
  * Amendments either restate a report (replace it) or add new holdings.
  * Option rows report the notional value of the underlying. Summed into a
    total they turn market makers into the largest "investors" in the country,
    so positions and options are kept apart.
  * Values are whole dollars since January 2023, but not every filer got the
    memo: 108 of 8,857 Q2 2026 filings don't reconcile with their own stated
    total, some off by exactly 1,000x. Each filing's scale is judged against
    the market: the median ratio of its implied share prices to every other
    filer's for the same securities. Filings that fit no plausible scale keep
    their holdings list but publish no dollar figures.

www.sec.gov rejects automated clients that don't declare a contact, so fetch
needs SEC_CONTACT_EMAIL set (see etl/config.sec_www_headers).

Usage:
    SEC_CONTACT_EMAIL=you@example.com python -m etl.form_13f fetch
    python -m etl.form_13f load   --db data/advisor.duckdb
    python -m etl.form_13f export --db data/advisor.duckdb --out frontend/public/form_13f.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

import duckdb
import requests

from etl.config import DB_PATH as DEFAULT_DB
from etl.config import RAW_DIR, REPO_ROOT, SCHEMA_PATH, sec_www_headers

F13_RAW_DIR = RAW_DIR / "13f"
DATA_SETS_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "form_13f.json"

TOP_HOLDINGS = 10
HOLDING_TYPES = ("13F-HR", "13F-HR/A")

# A filing's implied prices must sit within this factor of the market's to be
# trusted at a given scale. Real filers disagree on price by a few percent
# (different pricing sources, rounding); a units mistake is off by 1,000x.
PRICE_TOLERANCE = 2.0
CANDIDATE_SCALES = (1.0, 1000.0, 0.001)
MIN_PRICED_POSITIONS = 3


# --------------------------------------------------------------------------- fetch


def latest_data_set_url(page_html: str) -> str | None:
    """The newest zip on SEC's data set page, which lists newest first."""
    links = re.findall(r'href="([^"]+_form13f\.zip)"', page_html)
    if not links:
        return None
    link = links[0]
    return link if link.startswith("http") else "https://www.sec.gov" + link


def stage_fetch() -> Path | None:
    headers = sec_www_headers()
    page = requests.get(DATA_SETS_PAGE, headers=headers, timeout=60)
    page.raise_for_status()
    url = latest_data_set_url(page.text)
    if not url:
        sys.exit("error: no 13F data set links found on the SEC page")
    F13_RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = F13_RAW_DIR / url.rsplit("/", 1)[-1]
    if dest.exists():
        print(f"already have {dest.name}")
        return dest
    print(f"downloading {url}")
    with requests.get(url, headers=headers, timeout=600, stream=True) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(".part")
        with tmp.open("wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
        tmp.rename(dest)
    print(f"saved {dest} ({dest.stat().st_size / 1e6:.1f} MB)")
    return dest


# --------------------------------------------------------------------------- load


def _tsv(directory: Path, name: str) -> str:
    # quote='' because SEC's TSVs don't quote fields and issuer names contain
    # stray double quotes that would otherwise swallow the rest of the line.
    path = directory / f"{name}.tsv"
    return f"read_csv('{path}', delim='\t', header=true, all_varchar=true, quote='', escape='')"


def load_archive(con: duckdb.DuckDBPyConnection, zip_path: Path) -> None:
    archive = zip_path.name
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        d = Path(tmp)
        for table in ("f13_filings", "f13_included_managers", "f13_holdings"):
            con.execute(f"DELETE FROM {table} WHERE source_archive = ?", [archive])  # nosec B608

        date = "try_strptime({col}, '%d-%b-%Y')::DATE"
        con.execute(
            f"""
            INSERT INTO f13_filings
            SELECT s.ACCESSION_NUMBER, s.CIK,
                   {date.format(col='s.PERIODOFREPORT')}, {date.format(col='s.FILING_DATE')},
                   s.SUBMISSIONTYPE, nullif(trim(c.AMENDMENTTYPE), ''),
                   c.FILINGMANAGER_NAME, c.FILINGMANAGER_CITY, c.FILINGMANAGER_STATEORCOUNTRY,
                   try_cast(nullif(trim(c.CRDNUMBER), '') AS BIGINT),
                   nullif(trim(c.SECFILENUMBER), ''),
                   try_cast(p.TABLEVALUETOTAL AS DOUBLE), try_cast(p.TABLEENTRYTOTAL AS INTEGER),
                   ?
            FROM {_tsv(d, 'SUBMISSION')} s
            JOIN {_tsv(d, 'COVERPAGE')} c USING (ACCESSION_NUMBER)
            LEFT JOIN {_tsv(d, 'SUMMARYPAGE')} p USING (ACCESSION_NUMBER)
            """,  # nosec B608 -- paths come from our own temp dir, not user input
            [archive],
        )
        con.execute(
            f"""
            INSERT INTO f13_included_managers
            SELECT ACCESSION_NUMBER, try_cast(SEQUENCENUMBER AS INTEGER), nullif(trim(CIK), ''),
                   try_cast(nullif(trim(CRDNUMBER), '') AS BIGINT), nullif(trim(SECFILENUMBER), ''),
                   NAME, ?
            FROM {_tsv(d, 'OTHERMANAGER2')}
            """,  # nosec B608
            [archive],
        )
        # Only holdings reports have positions; notices are 13F-NT.
        con.execute(
            f"""
            INSERT INTO f13_holdings
            SELECT i.ACCESSION_NUMBER, i.CUSIP, max(i.NAMEOFISSUER), i.TITLEOFCLASS,
                   nullif(trim(i.PUTCALL), ''),
                   sum(try_cast(i.VALUE AS DOUBLE)),
                   sum(CASE WHEN i.SSHPRNAMTTYPE = 'SH' THEN try_cast(i.SSHPRNAMT AS DOUBLE) END),
                   ?
            FROM {_tsv(d, 'INFOTABLE')} i
            GROUP BY i.ACCESSION_NUMBER, i.CUSIP, i.TITLEOFCLASS, nullif(trim(i.PUTCALL), '')
            """,  # nosec B608
            [archive],
        )
    n = con.execute(
        "SELECT count(*) FROM f13_filings WHERE source_archive = ?", [archive]
    ).fetchone()[0]
    h = con.execute(
        "SELECT count(*) FROM f13_holdings WHERE source_archive = ?", [archive]
    ).fetchone()[0]
    print(f"loaded {archive}: {n:,} filings, {h:,} holdings rows")


def stage_load(con: duckdb.DuckDBPyConnection) -> None:
    zips = sorted(F13_RAW_DIR.glob("*_form13f.zip"))
    if not zips:
        print(f"no 13F data sets in {F13_RAW_DIR}; run the fetch stage first")
        return
    for z in zips:
        load_archive(con, z)


# --------------------------------------------------------------------------- resolve


def effective_filings(rows: list[tuple]) -> dict[str, dict]:
    """Which filings make up each manager's holdings for one period.

    rows: (cik, accession_number, filing_date, submission_type, amendment_type).
    The base is the latest original report or restatement, since a restatement
    replaces everything before it. NEW HOLDINGS amendments filed on or after
    the base add to it. Returns {cik: {"base": accession, "additions": [...]}}.
    """
    by_cik: dict[str, list[tuple]] = {}
    for cik, acc, fdate, stype, atype in rows:
        if stype not in HOLDING_TYPES:
            continue
        by_cik.setdefault(cik, []).append((fdate, acc, stype, atype))
    out = {}
    for cik, filings in by_cik.items():
        bases = [f for f in filings if f[2] == "13F-HR" or (f[3] or "").upper() == "RESTATEMENT"]
        if not bases:
            continue  # only NEW HOLDINGS amendments, with no report to add them to
        base = max(bases, key=lambda f: (f[0], f[1]))
        additions = sorted(
            f[1]
            for f in filings
            if (f[3] or "").upper() == "NEW HOLDINGS" and (f[0], f[1]) >= (base[0], base[1])
        )
        out[cik] = {"base": base[1], "additions": additions}
    return out


def value_scale(ratios: list[float]) -> float | None:
    """The unit multiplier that brings a filing's implied prices in line with
    the market's, or None when no plausible one does.

    ratios: this filing's implied price / the market price, per security.
    """
    if len(ratios) < MIN_PRICED_POSITIONS:
        return 1.0  # too few priced positions to judge; trust the filing as filed
    m = median(ratios)
    for scale in CANDIDATE_SCALES:
        if 1 / PRICE_TOLERANCE <= m * scale <= PRICE_TOLERANCE:
            return scale
    return None


def market_prices(con: duckdb.DuckDBPyConnection, accessions: list[str]) -> dict[str, float]:
    """Median implied share price per CUSIP across all filings. A units mistake
    at one filer can't move a median across hundreds."""
    con.register("_acc", _one_column(accessions))
    rows = con.execute(
        """
        SELECT cusip, median(value / shares)
        FROM f13_holdings
        WHERE accession_number IN (SELECT a FROM _acc)
          AND put_call IS NULL AND shares > 0 AND value > 0
        GROUP BY cusip HAVING count(*) >= 5
        """
    ).fetchall()
    con.unregister("_acc")
    return dict(rows)


def _one_column(values: list[str]):
    import pandas as pd

    return pd.DataFrame({"a": values})


# --------------------------------------------------------------------------- export


_LEGAL_SUFFIX = re.compile(
    r"\b(l ?l ?c|l ?p|l ?l ?p|inc|corp|corporation|co|company|ltd|limited|pllc|pc|the)\b"
)


def normalized_name(name: str | None) -> str:
    """Firm name for exact comparison: case, punctuation and legal suffixes
    removed, so "Tortuga Wealth Management, Inc" equals "TORTUGA WEALTH
    MANAGEMENT INC". Still an exact comparison -- never a fuzzy one."""
    text = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower())
    return re.sub(r"\s+", " ", _LEGAL_SUFFIX.sub(" ", text)).strip()


def name_state_index(firm_rows) -> dict[tuple[str, str], set[int]]:
    """(normalized name, state) -> registered firm CRDs, from both names."""
    index: dict[tuple[str, str], set[int]] = {}
    for crd, legal, business, state in firm_rows:
        for n in {normalized_name(legal), normalized_name(business)}:
            # Too short to identify anyone: "25 LLC" normalizes to "25".
            if len(n) >= 5 and not n.isdigit() and state:
                index.setdefault((n, state), set()).add(crd)
    return index


def choose_period(con: duckdb.DuckDBPyConnection):
    row = con.execute(
        """
        SELECT period FROM f13_filings WHERE submission_type = '13F-HR'
        GROUP BY period ORDER BY count(*) DESC, period DESC LIMIT 1
        """
    ).fetchone()
    return row[0] if row else None


def summarize_filer(holdings: list[tuple], scale: float | None) -> dict:
    """holdings: (cusip, issuer, title, put_call, value) for one manager's
    effective filings. Positions and option notional are reported apart."""
    positions: dict[str, list] = {}
    options = 0.0
    for cusip, issuer, title, put_call, value in holdings:
        v = value or 0.0
        if put_call:
            options += v
            continue
        p = positions.setdefault(cusip, [issuer, title, 0.0])
        p[2] += v
    total = sum(p[2] for p in positions.values())
    ranked = sorted(positions.items(), key=lambda kv: -kv[1][2])[:TOP_HOLDINGS]
    reliable = scale is not None
    top = [
        {
            "issuer": issuer,
            "cusip": cusip,
            "value": round(v * scale) if reliable else None,
            "pct": round(v / total, 4) if reliable and total else None,
        }
        for cusip, (issuer, _title, v) in ranked
    ]
    return {
        "value": round(total * scale) if reliable else None,
        "options_value": round(options * scale) if reliable and options else None,
        "positions": len(positions),
        "top": top,
        "values_reliable": reliable,
    }


def export(db_path: Path, out_path: Path) -> bool:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        try:
            period = choose_period(con)
        except duckdb.CatalogException:
            period = None
        if period is None:
            print(f"no 13F filings in this database; leaving {out_path} untouched")
            return False

        filing_rows = con.execute(
            """
            SELECT cik, accession_number, filing_date, submission_type, amendment_type
            FROM f13_filings WHERE period = ?
            """,
            [period],
        ).fetchall()
        effective = effective_filings(filing_rows)
        base_accessions = [e["base"] for e in effective.values()]
        all_accessions = base_accessions + [a for e in effective.values() for a in e["additions"]]

        prices = market_prices(con, base_accessions)

        meta = {
            acc: (cik, name, fdate, crd, secno, state)
            for acc, cik, name, fdate, crd, secno, state in con.execute(
                """
                SELECT accession_number, cik, manager_name, filing_date, crd, sec_file_number,
                       state_or_country
                FROM f13_filings WHERE period = ?
                """,
                [period],
            ).fetchall()
        }

        con.register("_acc", _one_column(all_accessions))
        holdings_by_acc: dict[str, list[tuple]] = {}
        for acc, cusip, issuer, title, put_call, value, shares in con.execute(
            """
            SELECT accession_number, cusip, issuer, title_of_class, put_call, value, shares
            FROM f13_holdings WHERE accession_number IN (SELECT a FROM _acc)
            """
        ).fetchall():
            holdings_by_acc.setdefault(acc, []).append((cusip, issuer, title, put_call, value, shares))
        con.unregister("_acc")

        filers: dict[str, dict] = {}
        for cik, e in effective.items():
            base_rows = holdings_by_acc.get(e["base"], [])
            ratios = [
                (value / shares) / prices[cusip]
                for cusip, _i, _t, put_call, value, shares in base_rows
                if put_call is None and shares and value and cusip in prices and prices[cusip] > 0
            ]
            scale = value_scale(ratios)
            rows = [r[:5] for acc in [e["base"], *e["additions"]] for r in holdings_by_acc.get(acc, [])]
            _cik, name, fdate, _crd, _secno, _state = meta[e["base"]]
            filers[cik] = {
                "name": name,
                "cik": cik,
                "accession": e["base"],
                "filed": str(fdate),
                **summarize_filer(rows, scale),
            }

        firm_rows = con.execute(
            "SELECT crd, legal_name, business_name, state, trim(sec_number) FROM firms"
        ).fetchall()
        firms_by_crd = {r[0]: r[4] for r in firm_rows}
        crd_by_secno = {sec: crd for crd, sec in firms_by_crd.items() if sec}
        by_name_state = name_state_index([r[:4] for r in firm_rows])

        firms: dict[str, dict] = {}
        # A firm's own filing: its CRD, or its SEC file number when it left CRD
        # blank -- exact identifiers first, for every filer.
        unmatched = []
        for cik, e in effective.items():
            _c, _n, _d, crd, secno, _s = meta[e["base"]]
            if crd in firms_by_crd:
                firms[str(crd)] = {"cik": cik, "own": True, "matched": "crd"}
            elif secno in crd_by_secno:
                firms[str(crd_by_secno[secno])] = {"cik": cik, "own": True, "matched": "sec_file_number"}
            else:
                unmatched.append(cik)

        # CRD is optional on the 13F cover page, and 2,264 registered advisers
        # leave it blank. They're matched by exact name and state, only when
        # exactly one registered firm fits. Checked against a field neither
        # match uses: 95.7% filed from the same city on both forms, and the
        # rest were overwhelmingly spellings ("ST. LOUIS" / "SAINT LOUIS") or
        # neighbouring towns (Miami / Coral Gables). Never overrides an exact match.
        for cik in unmatched:
            _c, name, _d, _crd, _secno, state = meta[effective[cik]["base"]]
            candidates = by_name_state.get((normalized_name(name), state), set())
            if len(candidates) == 1:
                (crd,) = candidates
                if str(crd) not in firms:
                    firms[str(crd)] = {"cik": cik, "own": True, "matched": "name_state"}

        # Firms named inside someone else's report, when they don't file their own.
        con.register("_acc", _one_column(base_accessions))
        included = con.execute(
            """
            SELECT m.accession_number, m.crd, m.sec_file_number
            FROM f13_included_managers m WHERE m.accession_number IN (SELECT a FROM _acc)
            """
        ).fetchall()
        con.unregister("_acc")
        cik_by_base = {e["base"]: cik for cik, e in effective.items()}
        for acc, crd, secno in included:
            match = crd if crd in firms_by_crd else crd_by_secno.get(secno)
            if match is None or firms.get(str(match), {}).get("own"):
                continue
            parent = cik_by_base[acc]
            current = firms.get(str(match))
            # Several parents can name the same firm; show the largest report.
            if current is None or (filers[parent]["value"] or 0) > (filers[current["cik"]]["value"] or 0):
                firms[str(match)] = {"cik": parent, "own": False, "matched": "included_manager"}
    finally:
        con.close()

    referenced = {f["cik"] for f in firms.values()}
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "period": str(period),
        "summary": {
            "filers": len(filers),
            "firms_own": sum(1 for f in firms.values() if f["own"]),
            "firms_matched_by_name": sum(1 for f in firms.values() if f["matched"] == "name_state"),
            "firms_included": sum(1 for f in firms.values() if not f["own"]),
            "filers_without_a_registered_firm": len(filers) - len({f["cik"] for f in firms.values() if f["own"]}),
            "values_unreliable": sum(1 for f in filers.values() if not f["values_reliable"]),
        },
        "filers": {cik: filers[cik] for cik in sorted(referenced)},
        "firms": firms,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    s = payload["summary"]
    print(
        f"wrote {out_path}: {s['filers']:,} filers for {period}; {s['firms_own']:,} firms file their "
        f"own, {s['firms_included']:,} are included in a parent's; {s['values_unreliable']} filings "
        "with no trustworthy dollar values"
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage", choices=["fetch", "load", "export"])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if args.stage == "fetch":
        stage_fetch()
    elif args.stage == "load":
        con = duckdb.connect(str(args.db))
        try:
            con.execute(SCHEMA_PATH.read_text())
            stage_load(con)
        finally:
            con.close()
    else:
        export(args.db, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
