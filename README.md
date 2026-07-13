# Open Disclosure

**Open Disclosure** benchmarks investment advisory firms by AUM, client mix,
compensation structure, and affiliated deal-structuring arms — built entirely
on public regulatory data (SEC Form ADV, IAPD/BrokerCheck, EDGAR, DOL 5500).

See [CLAUDE.md](CLAUDE.md) for the project brief, data sources, schema, and build order.

## Live demo (GitHub Pages)

Every push to `main` deploys a static build of the app to
**https://ricksterz.github.io/advisorapp/** via `.github/workflows/pages.yml`
(first run requires Pages to be enabled; the workflow attempts to enable it
automatically). The published site has no backend: the workflow runs the ETL,
exports the firms table to `firms.json`, and the React app filters it
client-side.

By default the site is built from the small sample fixture. To publish real
data, set a repository variable `ADV_COMPILATION_URL` (Settings → Secrets and
variables → Actions → Variables) pointing at an `IA_ADV_Base` compilation zip
from https://adviserinfo.sec.gov/compilation — a monthly scheduled run keeps
the snapshot fresh.

## Layout

- `etl/` — Python ingestion + normalization (Form ADV bulk data → DuckDB)
- `backend/` — FastAPI API over the analytics database
- `frontend/` — React (Vite) UI

## Quick start

```bash
pip install -r requirements.txt

# 1. Ingest a Form ADV compilation file (download from https://adviserinfo.sec.gov/compilation)
python -m etl.ingest_adv --input data/raw/IA_ADV_Base_A_<date>.zip

# 2. Run the API
uvicorn backend.app.main:app --reload   # http://localhost:8000/api/firms

# 3. Run the UI
cd frontend && npm install && npm run dev   # http://localhost:5173
```

## Tests

```bash
pytest etl/tests/
```

## Deployment

**Analytics.** The frontend loads the Cloudflare Web Analytics beacon in
production builds only, and only when a token is configured. After enabling
Web Analytics in the Cloudflare dashboard, set the token as an environment
variable in the Cloudflare Pages/Workers build settings (or in the CI build
environment):

```
VITE_CF_ANALYTICS_TOKEN=<your Web Analytics token>
```

Local dev builds never load the beacon, and production builds without the
variable simply skip it.

Google Analytics 4 (measurement ID `G-GYN9JCX9QR`) is wired directly in
`frontend/index.html` — measurement IDs are public, so no build variable is
needed. Like the Cloudflare beacon, it loads in production builds only.
