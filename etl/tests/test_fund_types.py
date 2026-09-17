import json

from etl.fund_types import export, main_fund_type


def fund(type_, gav, feeder=False):
    return {"type": type_, "gav": gav, "is_feeder_fund": feeder}


def test_main_fund_type_is_the_majority_of_assets():
    assert main_fund_type([fund("Hedge Fund", 900), fund("Private Equity Fund", 100)]) == "hedge"


def test_main_fund_type_is_mixed_without_a_majority():
    funds = [fund("Hedge Fund", 40), fund("Private Equity Fund", 35), fund("Real Estate Fund", 25)]
    assert main_fund_type(funds) == "mixed"


def test_feeder_funds_are_not_counted_twice():
    # The feeder's assets are already inside its master fund.
    funds = [fund("Hedge Fund", 100), fund("Venture Capital Fund", 500, feeder=True)]
    assert main_fund_type(funds) == "hedge"


def test_fund_counts_decide_when_no_assets_are_reported():
    funds = [fund("Venture Capital Fund", None), fund("Venture Capital Fund", 0), fund("Hedge Fund", None)]
    assert main_fund_type(funds) == "venture"


def test_no_typed_funds_is_unknown():
    assert main_fund_type([]) is None
    assert main_fund_type([fund(None, 100)]) is None


def test_export_writes_one_code_per_firm(tmp_path):
    src = tmp_path / "firm_private_funds.json"
    src.write_text(
        json.dumps(
            {
                "generated_at": "2026-09-10T00:00:00+00:00",
                "firms": {"1": [fund("Real Estate Fund", 10)], "2": []},
            }
        )
    )
    out = tmp_path / "firm_fund_types.json"
    assert export(src, out) == 1
    data = json.loads(out.read_text())
    assert data["firms"] == {"1": "real_estate"}
    assert data["source_generated_at"] == "2026-09-10T00:00:00+00:00"
