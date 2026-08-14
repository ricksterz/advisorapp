"""Tests for Schedule A/B ownership parsing and reconstruction.

Both regressions guarded here were silent on real data: the "NA" ownership
code being swallowed by pandas' default NA handling, and the DE/FE/I column
never resolving because its normalized header keeps the slashes.
"""

from __future__ import annotations

import io
import zipfile

import duckdb
import pandas as pd
import pytest

from etl.ownership import (
    OWNERSHIP_LABELS,
    parse_schedule_ab,
    stage_snapshot,
)
from etl.pulse_history import _read_member_csv

HEADER = (
    "FilingID,SchA-3,Schedule,Full Legal Name,DE/FE/I,Entity in Which,"
    "Title or Status,Status Acquired,Ownership Code,Control Person,PR,OwnerID\n"
)


def _csv(*rows: str) -> pd.DataFrame:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("m.csv", HEADER + "".join(r + "\n" for r in rows))
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
        return _read_member_csv(zf, "m.csv", keep_default_na=False)


def test_na_ownership_code_survives_pandas_na_handling():
    # "NA" is a real Schedule A code meaning "under 5%" — the single most
    # common band. Read with pandas defaults it becomes NaN and the band is
    # silently erased from tens of thousands of rows.
    df = parse_schedule_ab(_csv("1,Y,A,DOE JANE,I,,PRESIDENT,08/2012,NA,Y,N,999"))
    assert df.iloc[0]["ownership_code"] == "NA"


def test_de_fe_i_column_resolves_despite_slashes_in_its_header():
    # normalize_header("DE/FE/I") keeps the slashes; looking it up as "DEFEI"
    # silently yielded a null entity_type for every row.
    df = parse_schedule_ab(_csv("1,Y,A,ACME LLC,DE,,PARENT,09/2003,E,Y,N,"))
    assert df.iloc[0]["entity_type"] == "DE"


def test_yes_no_booleans_are_parsed_as_booleans():
    df = parse_schedule_ab(
        _csv(
            "1,Y,A,DOE JANE,I,,PRESIDENT,08/2012,NA,Y,N,999",
            "1,,B,HOLDCO INC,DE,ACME LLC,PARENT,09/2003,E,N,Y,",
        )
    )
    assert list(df["is_control_person"]) == [True, False]
    assert list(df["is_public_reporting"]) == [False, True]


def test_rows_outside_schedule_a_or_b_are_dropped():
    df = parse_schedule_ab(
        _csv(
            "1,Y,A,KEEP ME,I,,PRESIDENT,08/2012,NA,Y,N,1",
            "1,,R,DROP ME,I,,OTHER,08/2012,NA,Y,N,2",
        )
    )
    assert list(df["owner_name"]) == ["KEEP ME"]


def test_ownership_labels_are_keyed_by_schedule_and_code():
    # F exists only on Schedule B and is NOT a percentage; NA/A/B exist only
    # on Schedule A. Keying by code alone would mislabel one of them.
    assert ("B", "F") in OWNERSHIP_LABELS
    assert ("A", "F") not in OWNERSHIP_LABELS
    assert ("A", "NA") in OWNERSHIP_LABELS
    assert ("B", "NA") not in OWNERSHIP_LABELS
    assert "%" not in OWNERSHIP_LABELS[("B", "F")]
    # the shared letters must still agree across schedules
    assert OWNERSHIP_LABELS[("A", "E")] == OWNERSHIP_LABELS[("B", "E")]


def _db(tmp_path, rows):
    path = tmp_path / "t.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        "CREATE TABLE ownership_filings (filing_id BIGINT, crd BIGINT, "
        "date_submitted DATE, schedule VARCHAR, owner_name VARCHAR, "
        "owner_id VARCHAR, entity_type VARCHAR, owned_entity VARCHAR, "
        "title_or_status VARCHAR, status_acquired VARCHAR, "
        "ownership_code VARCHAR, is_control_person BOOLEAN, "
        "is_public_reporting BOOLEAN, source_archive VARCHAR)"
    )
    con.execute(
        "CREATE TABLE firm_owners (crd BIGINT, filing_id BIGINT, schedule VARCHAR, "
        "owner_name VARCHAR, owner_id VARCHAR, entity_type VARCHAR, "
        "owned_entity VARCHAR, title_or_status VARCHAR, status_acquired VARCHAR, "
        "ownership_code VARCHAR, is_control_person BOOLEAN, is_public_reporting BOOLEAN)"
    )
    if rows:
        con.executemany(
            "INSERT INTO ownership_filings (filing_id, crd, date_submitted, schedule, "
            "owner_name, ownership_code) VALUES (?,?,?,?,?,?)",
            rows,
        )
    return con


def test_snapshot_takes_only_the_most_recent_filing(tmp_path):
    # An officer present in the old filing but absent from the new one has
    # left; merging across filings would keep showing them as current.
    con = _db(
        tmp_path,
        [
            (10, 1, "2025-01-31", "A", "DEPARTED OFFICER", "NA"),
            (10, 1, "2025-01-31", "A", "STILL HERE", "NA"),
            (20, 1, "2026-06-30", "A", "STILL HERE", "NA"),
            (20, 1, "2026-06-30", "A", "NEW OFFICER", "NA"),
        ],
    )
    stage_snapshot(con)
    names = {r[0] for r in con.execute("SELECT owner_name FROM firm_owners").fetchall()}
    con.close()
    assert names == {"STILL HERE", "NEW OFFICER"}


def test_snapshot_keeps_every_row_of_the_winning_filing(tmp_path):
    # dense_rank (not row_number) — all rows of the winning filing tie at 1.
    con = _db(
        tmp_path,
        [(20, 1, "2026-06-30", "A", f"OWNER {i}", "NA") for i in range(5)],
    )
    stage_snapshot(con)
    n = con.execute("SELECT count(*) FROM firm_owners").fetchone()[0]
    con.close()
    assert n == 5


def test_snapshot_is_per_firm_not_global(tmp_path):
    # Firm 2's only filing is older than firm 1's; it must still be kept.
    con = _db(
        tmp_path,
        [
            (20, 1, "2026-06-30", "A", "FIRM ONE OWNER", "NA"),
            (10, 2, "2025-01-31", "A", "FIRM TWO OWNER", "NA"),
        ],
    )
    stage_snapshot(con)
    crds = {r[0] for r in con.execute("SELECT crd FROM firm_owners").fetchall()}
    con.close()
    assert crds == {1, 2}


def test_parse_rejects_an_archive_missing_required_columns():
    bad = pd.DataFrame({"Nope": ["x"]})
    with pytest.raises(SystemExit, match="missing required columns"):
        parse_schedule_ab(bad)
