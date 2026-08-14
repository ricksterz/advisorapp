"""Tests for the ownership change timeline.

Every identity case here was observed in a real 2026-06 pull, not invented:
same party at two chain positions, two people sharing a name, and one person
holding two titles. Getting any of them wrong invents departures or merges
humans.
"""

from __future__ import annotations

import json

import duckdb

from etl.ownership_changes import (
    build_changes,
    diff_filings,
    export_ownership_changes,
    identity,
)


def row(**kw):
    base = {
        "schedule": "A",
        "owner_name": "DOE, JANE",
        "owner_id": "",
        "entity_type": "I",
        "owned_entity": None,
        "title_or_status": "CEO",
        "ownership_code": "NA",
    }
    base.update(kw)
    return base


def test_same_name_different_people_stay_distinct():
    # 8 real cases: identical name, different OwnerID.
    a = row(owner_name="MINKO, CHRISTOPHER, JOHN", owner_id="4954763")
    b = row(owner_name="MINKO, CHRISTOPHER, JOHN", owner_id="9999999")
    assert identity(a) != identity(b)


def test_same_party_at_two_chain_positions_stays_distinct():
    # 384 real cases: Schedule B, same holder, different owned entity.
    a = row(schedule="B", owner_id="1", owned_entity="TITAN EXECUTIVE II, LLC")
    b = row(schedule="B", owner_id="1", owned_entity="REID REAL ESTATE INVESTMENTS, LLC")
    assert identity(a) != identity(b)


def test_one_person_with_two_titles_collapses_to_one_identity():
    # 122 real cases. Two rows, one human — and crucially no phantom event.
    prev = [
        row(owner_id="5", title_or_status="PRESIDENT"),
        row(owner_id="5", title_or_status="SHAREHOLDER"),
    ]
    curr = [
        row(owner_id="5", title_or_status="SHAREHOLDER"),
        row(owner_id="5", title_or_status="PRESIDENT"),
    ]
    assert diff_filings(prev, curr) == []


def test_entities_without_an_owner_id_match_on_name():
    # Only ~3% of entities carry an OwnerID, so the name fallback must work.
    a = row(owner_name="ACME HOLDINGS, LLC", owner_id="", entity_type="DE")
    b = row(owner_name="ACME  HOLDINGS LLC", owner_id="", entity_type="DE")
    assert identity(a) == identity(b)


def test_added_and_removed_are_detected():
    prev = [row(owner_id="1", owner_name="STAYS"), row(owner_id="2", owner_name="LEAVES")]
    curr = [row(owner_id="1", owner_name="STAYS"), row(owner_id="3", owner_name="ARRIVES")]
    events = diff_filings(prev, curr)
    assert {(e["type"], e["name"]) for e in events} == {
        ("added", "ARRIVES"),
        ("removed", "LEAVES"),
    }


def test_stake_change_is_detected_with_the_previous_band():
    prev = [row(owner_id="1", ownership_code="NA")]
    curr = [row(owner_id="1", ownership_code="E")]
    (event,) = diff_filings(prev, curr)
    assert event["type"] == "stake_changed"
    assert event["from_stake"] == "under 5%"
    assert event["stake"] == "75% or more"


def test_schedule_b_other_code_is_labelled_non_numerically():
    # F exists only on Schedule B and is not a percentage.
    prev = [row(schedule="B", owner_id="1", ownership_code="E", owned_entity="X")]
    curr = [row(schedule="B", owner_id="1", ownership_code="F", owned_entity="X")]
    (event,) = diff_filings(prev, curr)
    assert "%" not in event["stake"]


def test_an_unchanged_filing_produces_no_events():
    rows = [row(owner_id="1"), row(owner_id="2", owner_name="OTHER")]
    assert diff_filings(rows, list(reversed(rows))) == []


def _db(tmp_path, records):
    """records: (crd, filing_id, date, schedule, name, owner_id, code)"""
    path = tmp_path / "chg.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        "CREATE TABLE ownership_filings (filing_id BIGINT, crd BIGINT, "
        "date_submitted DATE, schedule VARCHAR, owner_name VARCHAR, owner_id VARCHAR, "
        "entity_type VARCHAR, owned_entity VARCHAR, title_or_status VARCHAR, "
        "status_acquired VARCHAR, ownership_code VARCHAR, is_control_person BOOLEAN, "
        "is_public_reporting BOOLEAN, source_archive VARCHAR)"
    )
    if records:
        con.executemany(
            "INSERT INTO ownership_filings (crd, filing_id, date_submitted, schedule, "
            "owner_name, owner_id, entity_type, ownership_code) VALUES (?,?,?,?,?,?,'I',?)",
            records,
        )
    return path, con


def test_a_firm_with_one_filing_yields_no_timeline(tmp_path):
    _, con = _db(tmp_path, [(1, 10, "2025-06-30", "A", "SOLO", "1", "NA")])
    payload = build_changes(con)
    con.close()
    assert payload["firms"] == {}


def test_timeline_is_newest_first_and_dated_by_the_later_filing(tmp_path):
    _, con = _db(
        tmp_path,
        [
            (1, 10, "2025-06-30", "A", "FOUNDER", "1", "E"),
            (1, 20, "2025-12-31", "A", "FOUNDER", "1", "E"),
            (1, 20, "2025-12-31", "A", "NEWCOMER", "2", "NA"),
            (1, 30, "2026-06-30", "A", "NEWCOMER", "2", "NA"),
        ],
    )
    payload = build_changes(con)
    con.close()
    timeline = payload["firms"]["1"]
    assert [t["date"] for t in timeline] == ["2026-06-30", "2025-12-31"]
    assert timeline[0]["events"][0]["type"] == "removed"  # FOUNDER gone by 2026
    assert timeline[1]["events"][0]["type"] == "added"  # NEWCOMER arrived in 2025-12


def test_export_skips_and_preserves_the_file_when_no_history(tmp_path):
    path, con = _db(tmp_path, [(1, 10, "2025-06-30", "A", "SOLO", "1", "NA")])
    con.close()
    out = tmp_path / "ownership_changes.json"
    out.write_text('{"sentinel": true}')
    assert export_ownership_changes(path, out) is False
    assert json.loads(out.read_text()) == {"sentinel": True}
