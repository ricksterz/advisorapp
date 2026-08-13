"""Tests for the service-provider league table.

The regressions worth guarding are the two silent ones: joining providers to
funds on reference_id alone (which attaches them to the wrong funds), and
summing feeder-fund GAV (which double-counts master/feeder capital).
"""

from __future__ import annotations

import json

import duckdb
import pytest

from etl.provider_stats import (
    export_provider_stats,
    provider_key,
    provider_rows,
    rank_providers,
)


def test_provider_key_merges_punctuation_and_spacing_variants():
    # Real splits observed in the filed data.
    assert provider_key("PRICEWATERHOUSECOOPERS LLP") == provider_key(
        "PRICEWATERHOUSE COOPERS"
    )
    assert provider_key("J.P. MORGAN CHASE BANK, N.A.") == provider_key(
        "JPMORGAN CHASE BANK"
    )
    assert provider_key("KPMG LLP") == provider_key("KPMG, LLP.")
    assert provider_key("Wells Fargo & Co") == provider_key("WELLS FARGO & COMPANY")


def test_provider_key_keeps_distinct_entities_apart():
    # Same brand, genuinely different filed entities — must not merge.
    assert provider_key("GOLDMAN SACHS & CO. LLC") != provider_key(
        "GOLDMAN SACHS BANK USA"
    )
    assert provider_key("KPMG LLP") != provider_key("KPMG LUXEMBOURG")


def test_provider_key_survives_a_name_of_only_entity_words():
    # Would collapse to "" and merge every such row into one bogus group.
    assert provider_key("LLC") != ""
    assert provider_key("LLC") != provider_key("LTD")


def test_rank_counts_distinct_firms_not_fund_rows():
    # One adviser (crd 1) with three funds at the same auditor is one firm.
    rows = [
        ("auditor", "KPMG LLP", 1, 100.0, False),
        ("auditor", "KPMG LLP", 1, 100.0, False),
        ("auditor", "KPMG, LLP.", 1, 100.0, False),
        ("auditor", "KPMG LLP", 2, 100.0, False),
    ]
    kpmg = rank_providers(rows)["auditor"][0]
    assert kpmg["firms"] == 2
    assert kpmg["funds"] == 4
    assert kpmg["name"] == "KPMG LLP"  # most common spelling wins
    assert kpmg["variants"] == 2


def test_gav_excludes_feeder_funds():
    # A feeder reports the same capital as its master; counting both doubles it.
    rows = [
        ("custodian", "STATE STREET", 1, 1_000.0, False),
        ("custodian", "STATE STREET", 1, 1_000.0, True),
    ]
    entry = rank_providers(rows)["custodian"][0]
    assert entry["gav"] == 1_000.0
    assert entry["funds"] == 2  # counts are unaffected by the GAV exclusion


def test_ranking_is_by_distinct_firms_and_respects_top_n():
    rows = [("auditor", f"F{i}", crd, 1.0, False) for i in range(3) for crd in range(i + 1)]
    ranked = rank_providers(rows, top_n=2)["auditor"]
    assert [e["name"] for e in ranked] == ["F2", "F1"]


def _db(tmp_path, provider_rows_, fund_rows):
    path = tmp_path / "t.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        "CREATE TABLE private_fund_providers "
        "(filing_id BIGINT, reference_id BIGINT, role VARCHAR, provider_name VARCHAR)"
    )
    con.execute(
        "CREATE TABLE private_funds (fund_id VARCHAR, crd BIGINT, "
        "gross_asset_value DOUBLE, is_feeder_fund BOOLEAN, "
        "reference_id BIGINT, filing_id BIGINT)"
    )
    if provider_rows_:
        con.executemany("INSERT INTO private_fund_providers VALUES (?,?,?,?)", provider_rows_)
    if fund_rows:
        con.executemany("INSERT INTO private_funds VALUES (?,?,?,?,?,?)", fund_rows)
    con.close()
    return path


def test_join_uses_filing_id_so_reference_ids_do_not_cross_filings(tmp_path):
    # reference_id 1 exists in both filings and points at a different fund in
    # each. Joining on reference_id alone would cross them and double every
    # count; the provider below must attach to fund A only.
    db = _db(
        tmp_path,
        [(10, 1, "auditor", "KPMG LLP")],
        [("A", 100, 5.0, False, 1, 10), ("B", 200, 7.0, False, 1, 20)],
    )
    con = duckdb.connect(str(db), read_only=True)
    rows = provider_rows(con)
    con.close()
    assert len(rows) == 1
    assert rows[0][2] == 100  # crd of fund A, not B


def test_export_skips_when_there_is_no_provider_data(tmp_path):
    db = _db(tmp_path, [], [])
    out = tmp_path / "service_providers.json"
    out.write_text('{"sentinel": true}')
    assert export_provider_stats(db, out) is False
    # the committed file must survive a CI run against a fresh ADV-only DB
    assert json.loads(out.read_text()) == {"sentinel": True}


def test_export_writes_roles_in_label_order(tmp_path):
    db = _db(
        tmp_path,
        [(10, 1, "custodian", "STATE STREET"), (10, 2, "auditor", "KPMG LLP")],
        [("A", 100, 5.0, False, 1, 10), ("B", 200, 7.0, False, 2, 10)],
    )
    out = tmp_path / "service_providers.json"
    assert export_provider_stats(db, out) is True
    payload = json.loads(out.read_text())
    assert [r["role"] for r in payload["roles"]] == ["auditor", "custodian"]
    assert payload["roles"][0]["label"] == "Auditors"
    assert payload["total_relationships"] == 2


@pytest.mark.parametrize("role", ["auditor", "custodian", "prime_broker"])
def test_empty_roles_are_omitted_rather_than_emitted_blank(tmp_path, role):
    db = _db(
        tmp_path,
        [(10, 1, role, "SOME PROVIDER")],
        [("A", 100, 5.0, False, 1, 10)],
    )
    out = tmp_path / "service_providers.json"
    export_provider_stats(db, out)
    payload = json.loads(out.read_text())
    assert [r["role"] for r in payload["roles"]] == [role]
