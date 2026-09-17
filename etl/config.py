"""Shared ETL configuration: paths and source URLs."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
DB_PATH = DATA_DIR / "advisor.duckdb"
SCHEMA_PATH = REPO_ROOT / "etl" / "schema.sql"

# SEC publishes monthly Form ADV compilation reports (CSV inside a zip) via the
# Investment Adviser Public Disclosure (IAPD) site. The filename carries the
# report date, e.g. IA_ADV_Base_A_20260601_20260630.zip — pass the exact URL
# with --url, or drop a downloaded zip/csv in data/raw/ and pass --input.
# Index of available files: https://adviserinfo.sec.gov/compilation
ADV_BULK_INDEX_URL = "https://adviserinfo.sec.gov/compilation"

# Identify ourselves to SEC servers (required by SEC fair-access policy).
HTTP_HEADERS = {
    "User-Agent": "advisorapp research tool (github.com/ricksterz/advisorapp)"
}


def sec_www_headers() -> dict[str, str]:
    """Headers for www.sec.gov, which (unlike reports.adviserinfo.sec.gov)
    403s any automated client that doesn't identify a contact, per SEC's
    fair-access policy. The contact comes from the SEC_CONTACT_EMAIL
    environment variable so it is never committed to the repository."""
    import os

    email = os.environ.get("SEC_CONTACT_EMAIL", "").strip()
    if not email:
        raise SystemExit(
            "error: set SEC_CONTACT_EMAIL to a real contact address; www.sec.gov "
            "rejects automated requests that don't declare one"
        )
    return {"User-Agent": f"Open Disclosure research {email}"}
