from datetime import datetime, timezone

import duckdb

from etl.advisor_bios import connect, find_bios, stage_bios
from etl.config import SCHEMA_PATH

# ---------------------------------------------------------------------------
# Heading variants. Each excerpt below is a literal (lightly trimmed) copy of
# real cached brochure text sampled from the corpus during development —
# same style as etl/tests/test_brochures.py's find_flags regression tests.
# ---------------------------------------------------------------------------


def test_en_dash_heading_single_person_no_crd():
    # version_id 959418, "Karl Benjamin Ruff (Ben)" — the most common heading
    # form ("Item 2 – ...", en-dash) and a document with no CRD anywhere in
    # the text, which is the majority case (well under two-thirds of
    # documents state one).
    text = """
    Part 2B of Form ADV: Brochure Supplement

    Item 1: Cover Page

    Karl Benjamin Ruff (Ben)

    Pearson Creek Capital Management LLC
    3057 North Rockwell Street, Suite 252
    Chicago, Illinois 60618
    (312) 878-5520

    March 21, 2025

    This brochure supplement provides information about Ben Ruff that supplements the Pearson
    Creek Capital Management LLC ("Pearson Creek") brochure. You should have received a copy of
    that brochure.

    Item 2: Educational Background and Business Experience

    Date of Birth: May 16, 1975
    University of Chicago, AB in Economics, May 1997
    Chartered Financial Analyst (CFA), September 2002

    Item 3: Disciplinary Information

    None to report.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "Karl Benjamin Ruff"
    assert bios[0]["crd"] is None
    assert "University of Chicago" in bios[0]["bio"]
    assert "Disciplinary Information" not in bios[0]["bio"]  # boundary excludes the next Item


def test_supervised_persons_name_label():
    # version_id 487451, "Paul F. Nastasi" — explicit "SUPERVISED PERSON'S
    # NAME:" label, the highest-confidence name source when present.
    text = """
    Part 2B of Form ADV: Brochure Supplement
    Item 1 Cover Page
    SUPERVISED PERSON'S NAME:
    Paul F. Nastasi
    408 Allegheny Avenue
    Towson, MD 21204

    Item 2 Educational Background and Business Experience

    Paul F. Nastasi, the supervised person, was born on April 14,1961. He obtained his B.A. degree
    from Loyola College in 1983.
    Item 3 Disciplinary Information

    There are no legal or disciplinary events.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "Paul F. Nastasi"


def test_ascii_hyphen_heading_with_crd_in_intro():
    # version_id 1012112, "Wyatt Evan Lewis" — "Item 2 - ..." (ascii hyphen,
    # not the en-dash) and an individual CRD stated parenthetically in the
    # cover-page intro sentence: "(CRD# 4665596)".
    text = """
    Page 1 of 4
    Item 1 - Cover Page

    WYATT EVAN LEWIS
    3590 Sacramento Dr.- Ste 140.
    San Luis Obispo, CA 93401

    This brochure supplement provides information about Wyatt E. Lewis (CRD# 4665596) that
    supplements the Lewis Financial, LLC disclosure brochure.

    Item 2 - Educational Background and Business Experience

    Wyatt Evan Lewis
    Year of birth: 1974
    BA in Economics, 1999, Univ. California Santa Cruz

    Item 3 - Disciplinary Information

    Your financial advisor has no legal or disciplinary events.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "WYATT EVAN LEWIS"
    assert bios[0]["crd"] == 4665596


def test_shortened_business_experience_heading_and_advisory_personnel_marker():
    # version_id 892462, "Steven Michael White" — "Item 2- Business
    # Experience" drops "Educational Background and" entirely, and the name
    # comes from an "Advisory Personnel" label rather than a "Cover Page" one.
    text = """
    Innovation Partners LLC: Form ADV, Part 2B Steven Michael White

    Fairview Plaza Office Complex
    5950 Fairview Road
    Charlotte, NC 28210

    Advisory Personnel
    Steven Michael White

             CRD#: 1022056

    Item 2- Business Experience

    Investment Advisor Name: Steven White
    Year of Birth: 1954
    Education: Steven Michael White is an investment advisor representative with IP Financial
    Advisory Services LLC.

    Item 3 – Disciplinary Information
    No information is applicable to this Item.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "Steven Michael White"
    assert bios[0]["crd"] == 1022056


def test_bare_heading_with_no_item_number():
    # version_id 1020455, "John Wanvig" — some filers drop the "Item 2"
    # numbering entirely and use the bare heading text as-is.
    text = """
    Part 2B of Form ADV: Brochure Supplement

    John Wanvig
    Chemin du Clos de Leyterand 10

    This brochure supplement provides information about John Wanvig that
    supplements the White Lighthouse Investment Management SARL ADV brochure.

    Educational Background and Business Experience
    John Wanvig – Born 1961
    Education:
    Bachelor of Arts, Economics
    Cornell University – 1984

    Disciplinary Information
    There have been no disciplinary events against John Wanvig.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "John Wanvig"
    assert bios[0]["crd"] is None


# ---------------------------------------------------------------------------
# Multi-person documents
# ---------------------------------------------------------------------------


def test_multi_person_document_splits_each_supplement_and_keeps_crds_separate():
    # version_id 1016377 ("MCALVANY WEALTH MANAGEMENT..."), two supervised
    # persons combined into one Part 2A+2B document. Each person's own CRD
    # ("CRD No. ...") must stay attached to their own record, not bleed into
    # the other's.
    text = """
    David S. McAlvany
    CRD No. 324482

    MCALVANY WEALTH MANAGEMENT, LLC

    This brochure supplement provides information about David S. McAlvany that supplements
    the McAlvany Wealth Management, LLC ("MWM") brochure.

    Item 2. Educational Background and Business Experience

    YEAR OF BIRTH: 1974
    Biola University (La Mirada, CA)
    Bachelor of Arts, Humanities/Philosophy, Graduated 1997

    Item 3.  Disciplinary Information
    Mr. McAlvany does not have any history of such disciplinary events.

    Part 2B of Form ADV: Brochure Supplement
    Item 1. Cover Page

    Robert K Draper
    CRD No. 1707864

    MCALVANY WEALTH MANAGEMENT, LLC

    This brochure supplement provides information about Robert K Draper that supplements the
    McAlvany Wealth Management, LLC ("MWM") brochure.

    Item 2. Educational Background and Business Experience
    YEAR OF BIRTH: 1958
    Denver University (Denver, CO) Bachelor of Science Accountancy, 1985

    Item 3. Disciplinary Information
    MWM is required to disclose any legal or disciplinary events.
    """
    bios = find_bios(text)
    assert [b["name"] for b in bios] == ["David S. McAlvany", "Robert K Draper"]
    assert bios[0]["crd"] == 324482
    assert bios[1]["crd"] == 1707864
    assert "Biola University" in bios[0]["bio"]
    assert "Denver University" in bios[1]["bio"]
    # neither person's CRD leaks into the other's record
    assert "1707864" not in bios[0]["bio"] or bios[0]["crd"] != 1707864
    assert "324482" not in bios[1]["bio"] or bios[1]["crd"] != 324482


def test_internal_name_title_roster_splits_a_single_shared_heading():
    # version_id 1027605 ("WEAS ADV PART 2A"): a firm-wide combined document
    # puts SIX people under one shared "Item 2" heading, distinguished only
    # by repeated "NAME: ... TITLE: ..." labels in the body — no per-person
    # heading or cover page at all. Treating the whole span as one bio would
    # misattribute everyone's biography to the first name found.
    text = """
    Item 2 – Educational Background and Business Experience
    NAME: James Cahn TITLE: Chair of the Investment Committee & Chief Strategy Officer
    YEAR OF BIRTH: 1980
    EDUCATIONAL BACKGROUND: Bachelor's degree, Finance.

    NAME: Edward Douglas Huber TITLE: Deputy Chief Investment Officer
    YEAR OF BIRTH: 1985
    EDUCATIONAL BACKGROUND: Bachelor's degree, Economics.

    NAME: Gary Quinzel TITLE: VP, Portfolio Consulting, CFA®, CFP®
    YEAR OF BIRTH: 1977
    EDUCATIONAL BACKGROUND: Bachelor's degree, Accounting.

    Item 3 – Disciplinary Information
    None of the investment management department members noted above have any legal or
    disciplinary events to report.
    """
    bios = find_bios(text)
    assert [b["name"] for b in bios] == ["James Cahn", "Edward Douglas Huber", "Gary Quinzel"]
    assert "Chief Strategy Officer" in bios[0]["bio"]
    assert "Deputy Chief Investment Officer" in bios[1]["bio"]
    assert "Cahn" not in bios[1]["bio"]  # each record only carries its own person's text


# ---------------------------------------------------------------------------
# False-positive guards
# ---------------------------------------------------------------------------


def test_ignores_toc_entry_with_dot_leader_and_page_number():
    # Real false positive family, same as etl/brochures.py's TOC guard: a
    # table of contents repeats the Item 2 heading followed by a dot leader
    # and page number, which would otherwise look like a real (empty) bio.
    text = """
    Table of Contents
    Item 2 – Educational Background and Business Experience ..................................... 21
    Item 3 – Disciplinary Information

    The Firm provides investment management services to individual clients.
    """
    assert find_bios(text) == []


def test_ignores_toc_entry_with_roman_numeral_page_number():
    # version_id 1027947 ("BWM FORM ADV PART 2A & 2B"): front-matter table of
    # contents pages are numbered with lowercase roman numerals, not arabic.
    text = """
    Table of Contents
    Item 2 – Educational Background and Business Experience ...................................... iv
    Item 3 – Disciplinary Information

    The Firm provides investment management services to individual clients.
    """
    assert find_bios(text) == []


def test_ignores_toc_entry_padded_with_plain_whitespace():
    # version_id 995904: some filers pad a TOC entry with plain spaces
    # instead of a dot leader — collapsing whitespace (the first step of
    # every extraction here) destroys the run length a dot-leader check would
    # otherwise use, so this needs a different signal (a bare page number
    # immediately followed by the next "Item N" TOC entry).
    text = """
    Dagean A. Larsen

    This brochure supplement provides information about Dagean A. Larsen that supplements
    Siler Wealth Management's brochure.

    Item 1 – Cover Page                                   1
    Item 1A – Table of Contents                        2
    Item 2 - Educational Background and Business Experience                 3
    Item 3 - Disciplinary Information          4
    Item 4 - Other Business Activities           5

    Item 2
    Educational Background and Business Experience

    Name: Dagean A. Larsen
    Year of Birth: 1983

    Item 3 - Disciplinary Information
    None.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "Dagean A. Larsen"


def test_ignores_bare_heading_phrase_embedded_in_prose():
    # version_id 1025324: the phrase "educational background and business
    # experience" appears verbatim in ordinary prose (not as a heading) right
    # after a real bio — "...His educational background and business
    # experience is as follows:". Only the genuine heading before it should
    # produce a record.
    text = """
    Item 2 - Educational Background and Business Experience
    David M. Jones was born in 1959. His educational background and business experience is as
    follows: Michigan State University, President, D & G Advisory Group.

    Item 3 - Disciplinary Information
    None.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "David M. Jones"


def test_rejects_name_directly_abutting_firms_own_name():
    # version_id 1025324: the cover page has nothing but whitespace between
    # the person's name and the firm's own name below it, and the firm here
    # is named after a co-founder ("Lindahl & Mansager") — NAME_TOKEN's
    # greedy match otherwise captures "Douglas Norman Mansager Lindahl". The
    # independent "...information about Douglas Norman Mansager that
    # supplements..." sentence elsewhere in the document doesn't have that
    # problem, and the shorter, agreed-upon name wins.
    text = """
    Item 1 – Cover Page

    Douglas Norman Mansager
    Lindahl & Mansager, Inc.

    This Brochure Supplement provides information about Douglas Norman Mansager
    that supplements the Lindahl & Mansager Brochure.

    Item 2- Educational Background and Business Experience

    Douglas Norman Mansager was born on January 21, 1949.

    Item 3 Disciplinary Information
    None.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["name"] == "Douglas Norman Mansager"


def test_skips_section_when_no_name_can_be_confidently_identified():
    # No cover page, no "information about" sentence, no supervised-person
    # label, and the bio content doesn't open with the name either — nothing
    # here should be confidently attributable to a person, so the whole
    # section is skipped rather than guessed at.
    text = """
    Item 2 – Educational Background and Business Experience

    Registered in 1998, earned a Series 65 license in 2001, and has served
    clients in the greater metro area for over twenty years.

    Item 3 – Disciplinary Information
    None.
    """
    assert find_bios(text) == []


def test_no_heading_at_all_yields_no_records():
    text = """
    Item 1 – Cover Page
    Some Firm, LLC
    123 Main Street

    Item 10 – Other Financial Industry Activities and Affiliations
    None.
    """
    assert find_bios(text) == []


# ---------------------------------------------------------------------------
# CRD extraction
# ---------------------------------------------------------------------------


def test_crd_label_variants():
    # Real label variants sampled: "CRD# 4665596", "CRD#: 1022056",
    # "(CRD# 4665596)", "CRD No. 324482", "CRD # 6701855".
    assert find_bios(
        """
        Item 1 – Cover Page
        Jane Doe
        CRD No. 7680872
        This brochure supplement provides information about Jane Doe that supplements the Firm brochure.
        Item 2 – Educational Background and Business Experience
        Jane Doe was born in 1980.
        Item 3 – Disciplinary Information
        None.
        """
    )[0]["crd"] == 7680872


def test_rejects_firms_own_crd_mentioned_near_a_persons_intro():
    # version_id 1043991: "...searching with the Advisor's firm name or
    # CRD# 170093" — the FIRM's CRD, mentioned in the same cover-page block
    # as a person's own bio. Must not be attributed to the person.
    text = """
    Item 1 – Cover Page
    Jeremy S. Martinson

    You may view the current Disclosure Brochure by searching with the Advisor's firm name or
    CRD# 170093.

    This brochure supplement provides information about Mr. Martinson is available on the SEC's
    Investment Adviser Public Disclosure website by searching with his full name or his individual
    CRD# 4587392.

    Item 2 – Educational Background and Business Experience
    Jeremy S. Martinson, CFP®, born in 1977, is dedicated to advising Clients.

    Item 3 – Disciplinary Information
    None.
    """
    bios = find_bios(text)
    assert len(bios) == 1
    assert bios[0]["crd"] == 4587392


# ---------------------------------------------------------------------------
# stage_bios / DB integration (mirrors etl/tests/test_brochures.py's
# stage-level tests for etl/brochures.py)
# ---------------------------------------------------------------------------


def _db_with_brochure(tmp_path, version_id, firm_crd, cache_dir, text):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute(SCHEMA_PATH.read_text())
    con.execute("INSERT INTO firms (crd, legal_name) VALUES (?, ?)", [firm_crd, f"FIRM {firm_crd}"])
    con.execute(
        "INSERT INTO brochures (version_id, firm_crd, name, fetched_at, text_chars) VALUES (?, ?, ?, ?, ?)",
        [version_id, firm_crd, "ADV 2B", datetime.now(timezone.utc), len(text)],
    )
    con.close()
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{version_id}.txt").write_text(text, encoding="utf-8")
    return db


_SAMPLE_TEXT = """
Item 1: Cover Page
Karl Benjamin Ruff (Ben)
This brochure supplement provides information about Ben Ruff that supplements the brochure.
Item 2: Educational Background and Business Experience
Date of Birth: May 16, 1975. University of Chicago, AB in Economics, May 1997.
Item 3: Disciplinary Information
None to report.
"""


def test_stage_bios_writes_advisors_and_marks_brochure_scanned(tmp_path, monkeypatch):
    cache_dir = tmp_path / "brochures"
    monkeypatch.setattr("etl.advisor_bios.CACHE_DIR", cache_dir)
    db = _db_with_brochure(tmp_path, 959418, 100, cache_dir, _SAMPLE_TEXT)

    con = connect(db)
    stage_bios(con, limit=None)

    rows = con.execute("SELECT full_name, crd, current_firm_crd, source_version_id FROM advisors").fetchall()
    assert rows == [("Karl Benjamin Ruff", None, 100, 959418)]
    (scanned,) = con.execute("SELECT bios_extracted_at FROM brochures WHERE version_id = 959418").fetchone()
    assert scanned is not None
    con.close()


def test_stage_bios_default_skips_already_scanned_brochures(tmp_path, monkeypatch):
    cache_dir = tmp_path / "brochures"
    monkeypatch.setattr("etl.advisor_bios.CACHE_DIR", cache_dir)
    db = _db_with_brochure(tmp_path, 959418, 100, cache_dir, _SAMPLE_TEXT)

    con = connect(db)
    stage_bios(con, limit=None)
    con.execute("DELETE FROM advisors")  # simulate the extractor having found nothing on a first pass
    stage_bios(con, limit=None)  # default run: already-scanned brochure should be skipped

    assert con.execute("SELECT count(*) FROM advisors").fetchone()[0] == 0
    con.close()


def test_stage_bios_rescan_reprocesses_everything(tmp_path, monkeypatch):
    cache_dir = tmp_path / "brochures"
    monkeypatch.setattr("etl.advisor_bios.CACHE_DIR", cache_dir)
    db = _db_with_brochure(tmp_path, 959418, 100, cache_dir, _SAMPLE_TEXT)

    con = connect(db)
    stage_bios(con, limit=None)
    con.execute("DELETE FROM advisors")
    stage_bios(con, limit=None, rescan=True)

    assert con.execute("SELECT count(*) FROM advisors").fetchone()[0] == 1
    con.close()


def test_stage_bios_is_idempotent_on_rerun():
    # Re-running against the same cached text must not duplicate rows —
    # delete-then-insert keyed on source_version_id, mirroring
    # deal_structuring's source_document pattern.
    bios_first = find_bios(_SAMPLE_TEXT)
    bios_second = find_bios(_SAMPLE_TEXT)
    assert bios_first == bios_second
