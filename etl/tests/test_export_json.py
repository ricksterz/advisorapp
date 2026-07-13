import json
from datetime import datetime, timezone

import duckdb

from etl.config import SCHEMA_PATH
from etl.export_json import export_deal_flags


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
