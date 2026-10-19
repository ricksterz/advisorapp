import io
import json
import zipfile

import duckdb
from lxml import etree

from etl import advisor_index as ai
from etl.config import SCHEMA_PATH

PERSON = """<Indvl>
  <Info lastNm="O'BRIEN-SMITH" firstNm="MARY" midNm="ANNE" indvlPK="4228803" link="x"/>
  <CrntEmps>
    <CrntEmp orgNm="STATE ONLY RIA" orgPK="999" city="NOWHERE" state="KS"/>
    <CrntEmp orgNm="BIG FIRM" orgPK="250" city="ST. LOUIS" state="MO">
      <BrnchOfLocs><BrnchOfLoc city="DENVER" state="CO"/></BrnchOfLocs>
      <CrntRgstns><CrntRgstn regAuth="CO" st="APPROVED" stDt="2015-03-01"/></CrntRgstns>
    </CrntEmp>
  </CrntEmps>
  <Dsgntns>
    <Dsgntn dsgntnNm="Chartered Financial Analyst"/>
    <Dsgntn dsgntnNm="Certified Financial Planner"/>
    <Dsgntn dsgntnNm="Something Else"/>
  </Dsgntns>
  <PrevRgstns><PrevRgstn orgPK="4" regBeginDt="2001-04-13" regEndDt="2008-01-01"/></PrevRgstns>
  <DRPs><DRP hasRegAction="N" hasCustComp="Y"/></DRPs>
</Indvl>"""


def test_parse_person_keeps_registered_employers_and_branch_location():
    p = ai.parse_person(etree.fromstring(PERSON), {250})
    assert p["crd"] == 4228803
    assert p["name"] == "Mary A. O'Brien-Smith"
    assert p["employers"] == [250]  # the state-only firm is dropped
    assert (p["city"], p["state"]) == ("Denver", "CO")  # branch, not head office
    assert p["designations"] == "CFA CFP"
    assert p["disclosure"] is True
    assert p["first_year"] == 2001


def test_parse_person_without_a_registered_employer_is_skipped():
    assert ai.parse_person(etree.fromstring(PERSON), {12345}) is None


def test_title_case_leaves_mixed_case_alone():
    assert ai.title_case("MCDONALD") == "Mcdonald"
    assert ai.title_case("McDonald") == "McDonald"
    assert ai.display_name("JOHN", "", "SMITH") == "John Smith"


def test_export_reads_the_newest_feed(tmp_path):
    feeds = tmp_path / "feeds"
    feeds.mkdir()
    for stamp, crd in (("07_21_2026", 1), ("09_09_2026", 2)):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("IA_Indvl_Feeds1.xml", f"<Indvls>{PERSON.replace('4228803', str(crd))}</Indvls>")
        (feeds / f"IA_INDVL_Feed_{stamp}.xml.zip").write_bytes(buf.getvalue())
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute("INSERT INTO firms (crd, legal_name) VALUES (250, 'BIG FIRM')")
    con.close()

    assert ai.latest_feed(feeds).name == "IA_INDVL_Feed_09_09_2026.xml.zip"
    assert ai.export(db, tmp_path, ai.latest_feed(feeds)) == 1
    data = json.loads((tmp_path / "advisors.json").read_text())
    assert data["people"] == [[2, "Mary A. O'Brien-Smith", [250], "Denver", "CO", "CFA CFP", 1, 2001]]
