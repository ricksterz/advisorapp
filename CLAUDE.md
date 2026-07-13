# Open Disclosure — Advisor Comp & Structure Analytics

## Purpose
Analytics app benchmarking investment advisory firms by AUM, client type mix,
discretionary vs. non-discretionary assets, compensation structure, and
affiliated asset-management/deal-structuring arms — using public regulatory data only.

## Data sources (public, no paid keys)
- SEC Form ADV bulk data (investment.gov IAPD bulk XML/CSV)
- FINRA BrokerCheck / IAPD individual advisor data
- SEC EDGAR full-text search + filings API (parent company cross-reference)
- DOL Form 5500 bulk files (efast.dol.gov) for institutional/plan-fiduciary slice

## Core schema
- firms: CRD, legal name, AUM (discretionary/non-discretionary), client type mix,
  fee structure, headcount, affiliated entities, disciplinary flag count
- advisors: CRD, current firm, licenses, tenure, disciplinary history, prior firms
- deal_structuring: parsed ADV Part 2 brochure flags (proprietary fund usage,
  revenue sharing, affiliated GP/LP structures)

## Stack
Python ETL (pandas, lxml) -> DuckDB/Postgres -> FastAPI backend -> React frontend

## Build order
1. ADV bulk-data ingestion + normalization (everything else depends on this schema)
2. Firm/advisor tables + basic filterable UI
3. Peer benchmarking (percentile rank by AUM-per-advisor, fee structure, client mix)
4. Deal-structuring flag layer (v2 - brochure PDF parsing is messy, iterate after core works)
