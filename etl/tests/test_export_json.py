import json
from datetime import datetime, timezone

import duckdb

from etl.config import SCHEMA_PATH
from etl.export_json import export_advisor_bios, export_deal_flags


def _make_db(tmp_path, with_flags):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute("INSERT INTO firms (crd, legal_name) VALUES (1, 'ACME'), (2, 'BETA')")
    if with_flags:
        con.execute(
            """
            INSERT INTO deal_structuring
                (firm_crd, source_document, proprietary_funds, revenue_sharing,
                 affiliated_gp_lp, evidence, extracted_at)
            VALUES
                (1, '111', true, false, true, ?, ?),
                (2, '222', false, false, false, NULL, ?)
            """,
            [
                json.dumps({"proprietary_funds": "places clients in affiliated funds"}),
                datetime.now(timezone.utc),
                datetime.now(timezone.utc),
            ],
        )
    con.close()
    return db


def test_export_deal_flags_writes_flags_and_evidence(tmp_path):
    out = tmp_path / "deal_flags.json"
    n = export_deal_flags(_make_db(tmp_path, with_flags=True), out)
    assert n == 2
    payload = json.loads(out.read_text())
    assert set(payload["firms"]) == {"1", "2"}
    assert payload["firms"]["1"] == {
        "pf": True,
        "rs": False,
        "gp": True,
        "evidence": {"proprietary_funds": "places clients in affiliated funds"},
    }
    # a firm with no matches carries flags but no evidence key
    assert payload["firms"]["2"] == {"pf": False, "rs": False, "gp": False}


def test_export_deal_flags_skips_when_empty_leaving_committed_file(tmp_path):
    # This is the CI-safety path: a fresh ingest has no brochure data, so the
    # committed deal_flags.json must be left untouched rather than clobbered.
    out = tmp_path / "deal_flags.json"
    out.write_text('{"committed": true}')
    n = export_deal_flags(_make_db(tmp_path, with_flags=False), out)
    assert n == 0
    assert json.loads(out.read_text()) == {"committed": True}


def _make_db_with_advisors(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute("INSERT INTO firms (crd, legal_name) VALUES (1, 'ACME'), (2, 'BETA')")
    now = datetime.now(timezone.utc)
    con.execute(
        """
        INSERT INTO advisors
            (crd, full_name, current_firm_crd, bio_text, source_version_id, source_name, extracted_at)
        VALUES
            (4665596, 'Wyatt Evan Lewis', 1, 'Born 1974. BA Economics, UC Santa Cruz.', 1012112, 'ADV 2B', ?),
            (NULL, 'Karl Benjamin Ruff', 1, 'AB in Economics, University of Chicago.', 959418, 'ADV 2B', ?)
        """,
        [now, now],
    )
    con.close()
    return db


def test_export_advisor_bios_groups_by_firm_and_keeps_provenance(tmp_path):
    out = tmp_path / "advisor_bios.json"
    n = export_advisor_bios(_make_db_with_advisors(tmp_path), out)
    assert n == 2
    payload = json.loads(out.read_text())
    assert set(payload["firms"]) == {"1"}  # firm 2 has no advisors, never appears
    bios = payload["firms"]["1"]
    assert len(bios) == 2
    lewis = next(b for b in bios if b["name"] == "Wyatt Evan Lewis")
    assert lewis["crd"] == 4665596
    assert lewis["source_version_id"] == 1012112
    assert lewis["source_name"] == "ADV 2B"
    # CRD is nullable: ~35%+ of advisors never state one in the source text
    ruff = next(b for b in bios if b["name"] == "Karl Benjamin Ruff")
    assert ruff["crd"] is None


def test_export_advisor_bios_joins_individual_disclosures_by_crd(tmp_path):
    db = _make_db_with_advisors(tmp_path)
    con = duckdb.connect(str(db))
    con.execute(
        """
        INSERT INTO individual_disclosures
            (crd, full_name, has_reg_action, has_criminal, has_bankruptcy,
             has_civil_judicial, has_bond, has_judgment, has_investigation,
             has_customer_complaint, has_termination, flag_count, iapd_link,
             source_archive, fetched_at)
        VALUES
            (4665596, 'WYATT LEWIS', false, false, false, false, false,
             true, false, true, false, 2,
             'https://adviserinfo.sec.gov/individual/summary/4665596',
             'IA_INDVL_Feed_01_01_2026.xml.zip', ?)
        """,
        [datetime.now(timezone.utc)],
    )
    con.close()

    out = tmp_path / "advisor_bios.json"
    n = export_advisor_bios(db, out)
    assert n == 2
    payload = json.loads(out.read_text())
    bios = payload["firms"]["1"]
    lewis = next(b for b in bios if b["name"] == "Wyatt Evan Lewis")
    assert lewis["disclosures"] == {
        "flags": {
            "has_reg_action": False,
            "has_criminal": False,
            "has_bankruptcy": False,
            "has_civil_judicial": False,
            "has_bond": False,
            "has_judgment": True,
            "has_investigation": False,
            "has_customer_complaint": True,
            "has_termination": False,
        },
        "flag_count": 2,
        "iapd_link": "https://adviserinfo.sec.gov/individual/summary/4665596",
    }
    # Karl Benjamin Ruff has no CRD at all, so no join is possible or expected.
    ruff = next(b for b in bios if b["name"] == "Karl Benjamin Ruff")
    assert "disclosures" not in ruff


def test_export_advisor_bios_skips_when_empty_leaving_committed_file(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.close()
    out = tmp_path / "advisor_bios.json"
    out.write_text('{"committed": true}')
    n = export_advisor_bios(db, out)
    assert n == 0
    assert json.loads(out.read_text()) == {"committed": True}
