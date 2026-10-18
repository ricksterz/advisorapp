import json
import math
import zipfile
from datetime import date

import duckdb
import pandas as pd

from etl import adviser_history as ah
from etl.config import SCHEMA_PATH


def test_report_links_skips_exempt_files_and_reads_both_date_styles():
    page = (
        '<a href="/files/x/ia010226.zip">a</a>'
        '<a href="/files/x/ia010226-exempt.zip">b</a>'
        '<a href="/files/x/ia09012026-registered.zip">c</a>'
        '<a href="/files/x/ia010324.xlsx">d</a>'
        '<a href="/files/x/notes.pdf">e</a>'
    )
    links = ah.report_links(page)
    assert links == {
        date(2026, 1, 2): "https://www.sec.gov/files/x/ia010226.zip",
        date(2026, 9, 1): "https://www.sec.gov/files/x/ia09012026-registered.zip",
        date(2024, 1, 3): "https://www.sec.gov/files/x/ia010324.xlsx",
    }


def test_reports_by_year_lists_january_first_then_fallbacks():
    links = {
        date(2019, 2, 1): "feb",
        date(2019, 1, 1): "jan",
        date(2012, 1, 1): "too-early",
    }
    assert ah.reports_by_year(links) == {2019: ["jan", "feb"]}


def test_extract_maps_columns_and_drops_rows_without_a_crd():
    raw = pd.DataFrame(
        {
            "Organization CRD#": ["100", None, "200"],
            "5A": ["12", "1", "3"],
            "5B(1)": ["4", "1", "3"],
            "5F(2)(c)": ["1,500,000,000", "1", "90000000"],
            "5F(2)(f)": ["300", "1", "40"],
        }
    )
    out = ah.extract(raw)
    assert list(out["crd"]) == [100, 200]
    assert list(out["aum_total"]) == [1.5e9, 9e7]
    assert list(out["employees_total"]) == [12, 3]


def test_extract_leaves_headcount_empty_in_vintages_without_it():
    raw = pd.DataFrame({"Organization CRD#": ["100"], "5F(2)(c)": ["5"], "5F(2)(f)": ["1"]})
    assert ah.extract(raw)["employees_total"].isna().all()


def test_compact_values():
    assert ah.compact_aum(1_234_567_890) == 1235
    assert ah.compact_aum(45_670_000) == 45.7
    assert ah.compact_aum(None) is None and ah.compact_aum(float("nan")) is None
    assert ah.non_advisory(10, 4) == 6
    assert ah.non_advisory(3, 5) is None  # contradictory counts
    assert ah.non_advisory(None, 4) is None


def test_segment_of_mirrors_the_site():
    row = {
        "pct_aum_wealth": 85.0,
        "pct_aum_registered_funds": 0.0,
        "pct_aum_private_funds": 0.0,
        "pct_aum_institutional": 15.0,
    }
    assert ah.segment_of(row) == "wealth"
    assert ah.segment_of({**row, "pct_aum_wealth": 50.0, "pct_aum_institutional": 50.0}) == "mixed"
    assert ah.segment_of(dict.fromkeys(row)) is None


def test_growth_fits_recover_how_staff_follows_aum_within_firms():
    years = list(range(2013, 2019))
    series = {}
    # Staff grows with the square root of AUM: slope 0.5, no drift.
    for crd in range(40):
        aum = [100.0 * (1.1 + crd / 100) ** i for i in range(6)]
        series[crd] = {"aum": aum, "support": [10 * math.sqrt(a / aum[0]) for a in aum]}
    fits = ah.growth_fits(series, years, dict.fromkeys(range(40), "wealth"))
    assert fits["wealth"]["pairs"] == 40
    assert abs(fits["wealth"]["slope"] - 0.5) < 1e-3
    assert abs(fits["wealth"]["intercept"]) < 1e-3


def _report(path, rows):
    df = pd.DataFrame(rows, columns=["Organization CRD#", "5A", "5B(1)", "5F(2)(c)", "5F(2)(f)"])
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(path.stem + ".csv", df.to_csv(index=False))


def test_load_and_export(tmp_path, monkeypatch):
    raw = tmp_path / "raw"
    raw.mkdir()
    monkeypatch.setattr(ah, "HISTORY_RAW_DIR", raw)
    monkeypatch.setattr(ah, "MIN_REPORT_BYTES", 0)
    _report(raw / "ia010224.zip", [["1", "10", "4", "100000000", "50"], ["9", "2", "1", "5000000", "3"]])
    _report(raw / "ia010225.zip", [["1", "14", "5", "250000000", "80"]])
    _report(raw / "ia020125.zip", [["1", "99", "1", "1", "1"]])  # later the same year: ignored

    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute(
        "INSERT INTO firms (crd, legal_name, pct_aum_wealth, pct_aum_registered_funds, "
        "pct_aum_private_funds, pct_aum_institutional) VALUES (1, 'A', 100, 0, 0, 0)"
    )
    ah.stage_load(con)
    ah.stage_load(con)  # reloading replaces, never duplicates
    assert con.execute("SELECT count(*) FROM adviser_annual").fetchone()[0] == 3
    con.close()

    out = tmp_path / "firm_trajectory.json"
    assert ah.export(db, out)
    data = json.loads(out.read_text())
    assert data["years"] == [2024, 2025]
    # Firm 9 isn't registered today, so only firm 1 is exported.
    assert data["firms"] == {"1": [[100, 250], [10, 14], [6, 9], [50, 80]]}
