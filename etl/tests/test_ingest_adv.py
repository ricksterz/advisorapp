from pathlib import Path

import duckdb

from etl.ingest_adv import extract_firms, load, read_source

FIXTURE = Path(__file__).parent / "fixtures" / "sample_adv_base.csv"


def test_extract_and_load(tmp_path):
    firms = extract_firms(read_source(FIXTURE))
    assert len(firms) == 3

    acme = firms.set_index("crd").loc[100001]
    assert acme["legal_name"] == "ACME WEALTH ADVISORS LLC"
    assert acme["aum_discretionary"] == 1_500_000_000
    assert acme["aum_total"] == 1_750_000_000
    assert acme["pct_clients_individuals"] == 38.0  # midpoint of 26-50%
    assert acme["fee_pct_of_aum"] and not acme["fee_hourly"]
    assert acme["affil_count"] == 2  # broker-dealer + pooled-vehicle sponsor
    assert acme["disciplinary_flag_count"] == 0

    blue = firms.set_index("crd").loc[100002]
    assert blue["fee_performance_based"]
    assert blue["disciplinary_flag_count"] == 1

    db = tmp_path / "test.duckdb"
    load(firms, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM firms").fetchone()[0] == 3
    # Re-loading is a full refresh, not an append.
    load(firms, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM firms").fetchone()[0] == 3
