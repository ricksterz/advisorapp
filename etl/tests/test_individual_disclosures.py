import io
import zipfile
from datetime import datetime, timezone

import duckdb

from etl.config import SCHEMA_PATH
from etl.individual_disclosures import parse_feed, stage_load

# Shape verified against the real IA_INDVL_Feed_MM_DD_YYYY.xml.zip
# (2026-07-21 feasibility spike): <Indvls><Indvl><Info .../><DRPs><DRP
# .../></DRPs></Indvl>...</Indvls>. A <DRPs/> self-close (no DRP child) is
# the common case (~85% of the real feed) and must be skipped, not counted
# as zero flags.
FLAGGED_INDVL = """
<Indvl>
  <Info lastNm="SMITH" firstNm="RAYMOND" indvlPK="731506"
        link="https://adviserinfo.sec.gov/individual/summary/731506"/>
  <DRPs>
    <DRP hasRegAction="N" hasCriminal="N" hasBankrupt="N" hasCivilJudc="N"
         hasBond="N" hasJudgment="Y" hasInvstgn="N" hasCustComp="Y" hasTermination="N"/>
  </DRPs>
</Indvl>
"""

CLEAN_INDVL = """
<Indvl>
  <Info lastNm="SINGER" firstNm="JOSEPH" indvlPK="3095077"
        link="https://adviserinfo.sec.gov/individual/summary/3095077"/>
  <DRPs/>
</Indvl>
"""


def _zip_with(*bodies: str) -> zipfile.ZipFile:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i, body in enumerate(bodies, start=1):
            xml = f'<?xml version="1.0" encoding="ISO-8859-1"?><IAPDIndividualReport><Indvls>{body}</Indvls></IAPDIndividualReport>'
            zf.writestr(f"IA_Indvl_Feeds{i}.xml", xml)
    buf.seek(0)
    return zipfile.ZipFile(buf)


def test_parse_feed_keeps_only_flagged_individuals():
    zf = _zip_with(FLAGGED_INDVL + CLEAN_INDVL)
    out, total = parse_feed(zf)
    assert total == 2
    assert len(out) == 1
    row = out.iloc[0]
    assert row["crd"] == 731506
    assert row["full_name"] == "RAYMOND SMITH"
    assert bool(row["has_judgment"]) is True
    assert bool(row["has_customer_complaint"]) is True
    assert bool(row["has_reg_action"]) is False
    assert row["flag_count"] == 2
    assert row["iapd_link"] == "https://adviserinfo.sec.gov/individual/summary/731506"


def test_parse_feed_reads_across_multiple_archive_members():
    # The real feed splits ~436K individuals across ~20 XML members in one
    # zip; a flagged individual in any member must be found, and the total
    # count must span every member too.
    zf = _zip_with(CLEAN_INDVL, FLAGGED_INDVL, CLEAN_INDVL)
    out, total = parse_feed(zf)
    assert total == 3
    assert list(out["crd"]) == [731506]


def test_parse_feed_empty_when_nothing_flagged():
    zf = _zip_with(CLEAN_INDVL)
    out, total = parse_feed(zf)
    assert total == 1
    assert len(out) == 0
    assert list(out.columns)  # still has the expected columns, just no rows


def test_stage_load_replaces_table_wholesale(tmp_path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())

    archive = tmp_path / "IA_INDVL_Feed_01_01_2026.xml.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        xml = (
            '<?xml version="1.0" encoding="ISO-8859-1"?>'
            f"<IAPDIndividualReport><Indvls>{FLAGGED_INDVL}</Indvls></IAPDIndividualReport>"
        )
        zf.writestr("IA_Indvl_Feeds1.xml", xml)

    n = stage_load(con, archive)
    assert n == 1
    row = con.execute(
        "SELECT crd, flag_count, source_archive FROM individual_disclosures"
    ).fetchone()
    assert row == (731506, 2, "IA_INDVL_Feed_01_01_2026.xml.zip")
    meta = con.execute(
        "SELECT source_archive, total_individuals, flagged_individuals FROM individual_disclosures_meta"
    ).fetchone()
    assert meta == ("IA_INDVL_Feed_01_01_2026.xml.zip", 1, 1)

    # fetched_at must round-trip as the true UTC instant, not shift with the
    # local system timezone — DuckDB silently reinterprets a tz-aware insert
    # as local wall-clock time (verified separately), which would make
    # individual_disclosures_stats.py's as_of wrong on any non-UTC machine.
    fetched_at = con.execute("SELECT fetched_at FROM individual_disclosures_meta").fetchone()[0]
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs((fetched_at - now_utc).total_seconds()) < 60

    # A later daily file supersedes the last one entirely.
    archive2 = tmp_path / "IA_INDVL_Feed_01_02_2026.xml.zip"
    with zipfile.ZipFile(archive2, "w") as zf:
        xml = (
            '<?xml version="1.0" encoding="ISO-8859-1"?>'
            f"<IAPDIndividualReport><Indvls>{CLEAN_INDVL}</Indvls></IAPDIndividualReport>"
        )
        zf.writestr("IA_Indvl_Feeds1.xml", xml)
    n2 = stage_load(con, archive2)
    assert n2 == 0
    assert con.execute("SELECT count(*) FROM individual_disclosures").fetchone()[0] == 0
    meta2 = con.execute(
        "SELECT source_archive, total_individuals, flagged_individuals FROM individual_disclosures_meta"
    ).fetchone()
    assert meta2 == ("IA_INDVL_Feed_01_02_2026.xml.zip", 1, 0)
    con.close()
