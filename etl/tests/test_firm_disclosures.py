import json
import zipfile

import pandas as pd

from etl import firm_disclosures as fd


def _csv(rows, cols):
    return pd.DataFrame(rows, columns=cols).to_csv(index=False)


REG_COLS = [
    "FilingID", "Filed Against", "ReferenceID", "Remove-Affiliate", "Remove-Expired", "Remove-Filed in Error",
    "Initiated By", "Principal Sanction", "Principal Product", "Date Initiated", "Allegations", "Summary",
    "Status", "Resolution", "Resolution Date", "Monetary Amount",
]


def _archive(path, period, base_rows, reg_rows, affiliates=()):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(f"IA_ADV_Base_A_{period}.csv", _csv(base_rows, ["FilingID", "1E1"]))
        zf.writestr(f"IA_DRP_Regulatory_{period}.csv", _csv(reg_rows, REG_COLS))
        zf.writestr(
            f"IA_DRP_Advisory_Affiliates_{period}.csv",
            _csv(list(affiliates), ["FilingID", "ReferenceID", "Affiliate Name"]),
        )


def reg(fid, against, ref, date, *, remove="", amount="", status="Final", allegations="SEC ALLEGED X."):
    return [fid, against, ref, remove, "", "", "SEC", "Civil Penalty", "", date, allegations, "", status,
            "Order", "", amount]


def test_dates_text_and_amounts():
    assert fd.iso_date("05/21/2024") == "2024-05-21"
    assert fd.iso_date("5/2024") == "2024-05"
    assert fd.iso_date("2019") == "2019"
    assert fd.iso_date("") is None
    assert fd.amount("$1,200,000") == 1_200_000
    assert fd.amount("0") is None and fd.amount("n/a") is None
    assert fd.clean("  N/A ") is None
    assert fd.clean("word " * 100, 20).endswith("…")


def test_union_across_archives_latest_version_wins_and_removals_drop(tmp_path):
    # Jan: two events for firm 100, one for 200. Feb: firm 100 updates one
    # (now resolved, with a penalty) and withdraws the other as filed in error.
    _archive(
        tmp_path / "ADV_Filing_Data_20250101_20250131.zip", "20250101_20250131",
        [["1", "100"], ["2", "200"]],
        [reg("1", "Advisory Firm", "11", "03/01/2023", status="Pending"),
         reg("1", "Affiliates", "12", "06/01/2022"),
         reg("2", "Firm and Affiliates", "21", "01/15/2024")],
        [["1", "12", "SISTER BROKER LLC"]],
    )
    _archive(
        tmp_path / "ADV_Filing_Data_20250201_20250228.zip", "20250201_20250228",
        [["3", "100"]],
        [reg("3", "Advisory Firm", "11", "03/01/2023", amount="250000"),
         reg("3", "Affiliates", "12", "06/01/2022", remove="Y")],
    )
    out = tmp_path / "firm_disclosures.json"
    assert fd.export(tmp_path, out) == 2
    data = json.loads(out.read_text())
    assert (data["covers_from"], data["as_of"], data["archives"]) == ("2025-01-01", "2025-02-28", 2)
    firm100 = data["firms"]["100"]
    assert len(firm100) == 1
    assert firm100[0] == {
        "kind": "R", "against": "F", "date": "2023-03-01", "by": "SEC", "what": "Civil Penalty",
        "status": "Final", "resolution": "Order", "amount": 250000, "text": "SEC ALLEGED X.", "ref": "R11",
    }
    assert data["firms"]["200"][0]["against"] == "B"


def test_copies_of_one_event_under_new_reference_ids_fold_together(tmp_path):
    same = {"date": "05/01/2025", "amount": "100000", "allegations": "NASAA TASK FORCE ALLEGED Y."}
    _archive(
        tmp_path / "ADV_Filing_Data_20250501_20250531.zip", "20250501_20250531",
        [["1", "250"]],
        [reg("1", "Affiliates", "31", **same), reg("1", "Affiliates", "32", **same),
         reg("1", "Affiliates", "33", **{**same, "amount": "5000"})],
        [["1", "31", "A LLC"], ["1", "32", "B LLC"]],
    )
    out = tmp_path / "out.json"
    assert fd.export(tmp_path, out) == 2
    events = json.loads(out.read_text())["firms"]["250"]
    folded = next(e for e in events if e["amount"] == 100000)
    assert folded["affiliates"] == ["A LLC", "B LLC"]

