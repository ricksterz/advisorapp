-- Core schema for the advisor comp & structure analytics app.
-- Loaded into DuckDB by etl/ingest_adv.py; kept Postgres-compatible so the
-- same DDL can be reused when the backend moves off DuckDB.

CREATE TABLE IF NOT EXISTS firms (
    crd                     BIGINT PRIMARY KEY,   -- SEC/FINRA firm CRD number
    sec_number              VARCHAR,              -- e.g. 801-XXXXX
    legal_name              VARCHAR NOT NULL,
    business_name           VARCHAR,              -- "doing business as" name
    filing_date             DATE,                 -- date of the ADV filing this row came from
    state                   VARCHAR,              -- Item 1.F: principal office state (2-letter)
    website_url             VARCHAR,              -- Item 1.I: firm website (social profiles excluded)

    -- Item 5.F: regulatory assets under management (USD)
    aum_total               DOUBLE,
    aum_discretionary       DOUBLE,
    aum_non_discretionary   DOUBLE,
    accounts_total          BIGINT,
    accounts_discretionary  BIGINT,
    accounts_non_discretionary BIGINT,

    -- Item 5.A/5.B: headcount
    employees_total         BIGINT,
    employees_advisory      BIGINT,               -- employees performing advisory functions

    -- Item 5.D: client type mix, approximate percentage of clients (0-100).
    -- ADV reports ranges; we store the range midpoint (see normalize_pct_range).
    pct_clients_individuals     DOUBLE,           -- non-high-net-worth individuals
    pct_clients_hnw_individuals DOUBLE,
    pct_clients_pension_plans   DOUBLE,
    pct_clients_pooled_vehicles DOUBLE,           -- funds the firm advises
    pct_clients_corporations    DOUBLE,
    pct_clients_other           DOUBLE,

    -- Item 5.E: compensation / fee structure (checkboxes on the form)
    fee_pct_of_aum          BOOLEAN,
    fee_hourly              BOOLEAN,
    fee_subscription        BOOLEAN,
    fee_fixed               BOOLEAN,
    fee_commissions         BOOLEAN,
    fee_performance_based   BOOLEAN,
    fee_other               BOOLEAN,

    -- Item 7.A: affiliated entities (financial industry affiliations)
    affil_broker_dealer     BOOLEAN,
    affil_investment_company BOOLEAN,             -- registered fund
    affil_other_adviser     BOOLEAN,
    affil_pooled_vehicle_sponsor BOOLEAN,         -- sponsor/GP of private funds
    affil_count             INTEGER,              -- number of affiliation boxes checked

    -- Item 11: disciplinary disclosures
    disciplinary_flag_count INTEGER DEFAULT 0
);

-- Individual advisors. The original version of this table used
-- `crd BIGINT PRIMARY KEY` as the sole identity, which assumes every
-- advisor's CRD is known. That assumption breaks for Form ADV Part 2B
-- ("brochure supplement") extraction (etl/advisor_bios.py): sampling the
-- full brochure corpus found an individual CRD stated in the document text
-- for well under two-thirds of supervised persons — the rest simply never
-- disclose one in the body of the filing. A CRD-only primary key would
-- silently drop a large share of real advisors, so identity here is a
-- surrogate `id` instead: crd is a nullable, unindexed attribute, never a
-- key. Re-runs of the extractor stay idempotent via delete-then-insert keyed
-- on source_version_id (mirroring deal_structuring's source_document pattern
-- below), not via a stable natural key on the advisor row itself.
CREATE SEQUENCE IF NOT EXISTS advisor_id_seq START 1;

CREATE TABLE IF NOT EXISTS advisors (
    id                  BIGINT PRIMARY KEY DEFAULT nextval('advisor_id_seq'),
    crd                 BIGINT,                   -- individual CRD; NULL when the filing never states one
    full_name           VARCHAR NOT NULL,
    current_firm_crd    BIGINT,                   -- FK -> firms.crd
    licenses            VARCHAR,                  -- comma-separated exam/license codes (not yet populated)
    tenure_years        DOUBLE,                   -- years at current firm (not yet populated)
    disciplinary_count  INTEGER DEFAULT 0,
    prior_firm_crds     VARCHAR,                  -- comma-separated prior firm CRDs (not yet populated)

    -- Form ADV Part 2B, Item 2 ("Educational Background and Business
    -- Experience"): the advisor's own bio, extracted verbatim from a firm's
    -- brochure supplement text by etl/advisor_bios.py. Nullable because a
    -- future ingestion path (e.g. a bulk individual-CRD feed, should one ever
    -- exist) could populate advisor rows without bio text; every row written
    -- by advisor_bios.py today has one.
    bio_text            VARCHAR,
    source_version_id   BIGINT,                   -- FK -> brochures.version_id (provenance / audit trail)
    source_name         VARCHAR,                  -- brochures.name at extraction time, for display
    extracted_at        TIMESTAMP
);

-- Individual-level disclosure flags from the SEC's bulk IA_INDVL_Feed
-- (etl/individual_disclosures.py) — a daily-refreshed ~436K-person XML feed
-- found in the IAPD compilation manifest (2026-07-21 feasibility spike;
-- superseding this project's earlier, incorrect conclusion that no bulk
-- individual feed exists). Each person carries at most one <DRP> element
-- with nine Y/N disclosure-category attributes and no narrative, date, or
-- dollar detail — real dates/disposition require following iapd_link to the
-- individual's IAPD summary page, same "flag it, link out" pattern as
-- firms.disciplinary_flag_count. flag_count is how many of the nine
-- categories are flagged, not a count of distinct events. Only individuals
-- with >=1 flag are loaded (~14% of the feed): this is a supplementary
-- table meant to be joined against advisors.crd, not a general-purpose
-- roster of all SEC-registered individuals.
CREATE TABLE IF NOT EXISTS individual_disclosures (
    crd                     BIGINT PRIMARY KEY,   -- individual CRD (IAPD indvlPK)
    full_name               VARCHAR,               -- reconciliation/debug only, not for display
    has_reg_action          BOOLEAN,
    has_criminal            BOOLEAN,
    has_bankruptcy          BOOLEAN,
    has_civil_judicial      BOOLEAN,
    has_bond                BOOLEAN,
    has_judgment            BOOLEAN,
    has_investigation       BOOLEAN,
    has_customer_complaint  BOOLEAN,
    has_termination         BOOLEAN,
    flag_count              INTEGER,               -- categories flagged (1-9); not an event count
    iapd_link               VARCHAR,               -- full detail page (real dates/disposition live here)
    source_archive          VARCHAR,               -- feed filename, for provenance
    fetched_at              TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Industry Pulse (etl/pulse_history.py + etl/pulse_stats.py).
--
-- adv_filings holds individual Form ADV filings from the SEC's monthly
-- advFilingData archives (one row per filing, NOT per firm — an adviser can
-- file multiple amendments). firm_snapshots is derived from it: each CRD's
-- latest filing on or before a quarter-end, within a staleness window —
-- because the monthly archives are filing windows, not universe snapshots,
-- this reconstruction is the only way to get point-in-time quarterly state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adv_filings (
    filing_id           BIGINT PRIMARY KEY,
    crd                 BIGINT,
    legal_name          VARCHAR,
    date_submitted      DATE,
    state               VARCHAR,
    aum_total           DOUBLE,
    aum_discretionary   DOUBLE,
    employees_advisory  BIGINT,
    fee_pct_of_aum      BOOLEAN,
    fee_performance_based BOOLEAN,
    fee_commissions     BOOLEAN,
    disciplinary_flag_count INTEGER,
    source_archive      VARCHAR                   -- e.g. ADV_Filing_Data_20260601_20260630.zip
);

CREATE TABLE IF NOT EXISTS adv_withdrawals (
    filing_id           BIGINT PRIMARY KEY,       -- Form ADV-W filing
    crd                 BIGINT,
    filing_date         DATE,
    source_archive      VARCHAR
);

CREATE TABLE IF NOT EXISTS firm_snapshots (
    snapshot_quarter    DATE,                     -- quarter-end date
    crd                 BIGINT,
    aum_total           DOUBLE,
    aum_discretionary   DOUBLE,
    employees_advisory  BIGINT,
    state               VARCHAR,
    fee_pct_of_aum      BOOLEAN,
    fee_performance_based BOOLEAN,
    fee_commissions     BOOLEAN,
    disciplinary_flag_count INTEGER,
    PRIMARY KEY (snapshot_quarter, crd)
);

CREATE TABLE IF NOT EXISTS deal_structuring (
    firm_crd            BIGINT,                   -- FK -> firms.crd
    source_document     VARCHAR,                  -- brochure filename / URL
    proprietary_funds   BOOLEAN,                  -- firm places clients in its own funds
    revenue_sharing     BOOLEAN,
    affiliated_gp_lp    BOOLEAN,                  -- affiliated GP/LP fund structures
    evidence            VARCHAR,                  -- JSON: flag -> matched brochure snippet (audit trail)
    extracted_at        TIMESTAMP
);

-- Part 2A brochure inventory per firm, from the IAPD firm API. version_id +
-- date_submitted make monthly refreshes incremental: only changed brochures
-- get re-fetched and re-extracted.
CREATE TABLE IF NOT EXISTS brochures (
    version_id          BIGINT PRIMARY KEY,       -- IAPD brochureVersionID
    firm_crd            BIGINT,                   -- FK -> firms.crd
    name                VARCHAR,
    date_submitted      VARCHAR,                  -- as reported (M/D/YYYY)
    fetched_at          TIMESTAMP,                -- PDF downloaded
    text_chars          BIGINT,                   -- extracted text size (null = not extracted)
    bios_extracted_at   TIMESTAMP                 -- etl/advisor_bios.py last scanned this text for Part 2B bios
);
