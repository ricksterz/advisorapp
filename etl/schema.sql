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

-- One row per load: the TOTAL individuals scanned in that feed pull, not
-- just the flagged subset kept in individual_disclosures above — needed to
-- compute an honest industry-wide flagged rate (etl/individual_disclosures_stats.py)
-- without re-parsing the 175MB source feed at export time.
CREATE TABLE IF NOT EXISTS individual_disclosures_meta (
    source_archive          VARCHAR PRIMARY KEY,
    total_individuals       BIGINT,
    flagged_individuals     BIGINT,
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

-- ---------------------------------------------------------------------------
-- Private funds (etl/private_funds.py) — Form ADV Schedule D 7.B.1, one row
-- per private fund a registered adviser manages, plus 7.B.1's named
-- service-provider sub-items (7.B.1.(a).23/24/25/26/28: auditor, prime
-- broker, custodian, administrator, marketer). Lives in the SAME monthly
-- advFilingData archives etl/pulse_history.py already downloads — no new
-- data source. Same filing-window-not-snapshot problem as adv_filings:
-- private_fund_filings holds every raw filing row across all cached
-- archives; private_funds/private_fund_providers are the reconstructed
-- "latest known state per fund" (fund_id is a stable SEC-assigned
-- identifier, unlike reference_id which is only unique within one filing).
-- private_fund_snapshots adds the quarterly time series deferred from v1
-- (docs/industry-pulse-plan.md Phase 2b fast-follow): same reconstruction
-- as firm_snapshots (latest filing per fund on/before each quarter-end,
-- within the staleness window, excluding withdrawn firms), gated to the
-- SAME published-quarter list pulse_stats.py already computes from
-- firm_snapshots — one canonical completeness gate for the whole Pulse
-- surface rather than a second one recomputed for funds. No per-quarter
-- provider join: a trend needs fund counts/types/GAV, not the full
-- service-provider table replayed at every quarter-end.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private_fund_filings (
    filing_id           BIGINT,
    fund_id             VARCHAR,                  -- stable SEC fund identifier, e.g. 805-XXXXXXX
    reference_id        BIGINT,                    -- valid as a join key only within this filing_id
    crd                 BIGINT,                    -- adviser CRD, joined in from IA_ADV_Base_A
    date_submitted      DATE,
    fund_name           VARCHAR,
    fund_type           VARCHAR,
    state               VARCHAR,                  -- fund domicile
    country             VARCHAR,
    exclusion_3c1       BOOLEAN,
    exclusion_3c7       BOOLEAN,
    is_master_fund      BOOLEAN,
    is_feeder_fund      BOOLEAN,
    gross_asset_value   DOUBLE,
    source_archive      VARCHAR,
    PRIMARY KEY (filing_id, fund_id)
);

CREATE TABLE IF NOT EXISTS private_fund_provider_filings (
    filing_id           BIGINT,
    reference_id        BIGINT,
    role                VARCHAR,                  -- auditor | prime_broker | custodian | administrator | marketer
    provider_name       VARCHAR,
    city                VARCHAR,
    state               VARCHAR,
    country             VARCHAR,
    source_archive      VARCHAR
);

CREATE TABLE IF NOT EXISTS private_funds (
    fund_id             VARCHAR PRIMARY KEY,
    crd                 BIGINT,
    fund_name           VARCHAR,
    fund_type           VARCHAR,
    state               VARCHAR,
    country             VARCHAR,
    exclusion_3c1       BOOLEAN,
    exclusion_3c7       BOOLEAN,
    is_master_fund      BOOLEAN,
    is_feeder_fund      BOOLEAN,
    gross_asset_value   DOUBLE,
    reference_id        BIGINT,                    -- this fund's winning filing's reference_id
    filing_id           BIGINT,                    -- this fund's winning (most recent) filing
    date_submitted      DATE,
    source_archive      VARCHAR
);

CREATE TABLE IF NOT EXISTS private_fund_providers (
    filing_id           BIGINT,
    reference_id        BIGINT,
    role                VARCHAR,
    provider_name       VARCHAR,
    city                VARCHAR,
    state               VARCHAR,
    country             VARCHAR,
    source_archive      VARCHAR
);

CREATE TABLE IF NOT EXISTS private_fund_snapshots (
    snapshot_quarter    DATE,
    fund_id             VARCHAR,
    crd                 BIGINT,
    fund_type           VARCHAR,
    gross_asset_value   DOUBLE,
    is_feeder_fund      BOOLEAN,
    PRIMARY KEY (snapshot_quarter, fund_id)
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

-- ---------------------------------------------------------------------------
-- Form D exempt offerings (etl/form_d.py) — SEC's quarterly structured data
-- sets (six TSVs per quarter, downloaded manually: www.sec.gov WAF-blocks
-- automated clients, unlike the reports.adviserinfo.sec.gov host the ADV
-- pipelines use).
--
-- CRITICAL, verified against the real 2026Q2 file: an amendment (D/A, ~36% of
-- rows) RESTATES the cumulative amount sold for an ongoing offering rather
-- than reporting new capital. Summing TOTALAMOUNTSOLD across all rows
-- therefore counts the same dollars once per amendment — $2.97T for 2026Q2
-- vs $186B counting new offerings only, a 16x inflation. Every aggregate in
-- etl/form_d_stats.py counts NEW offerings only; is_amendment is kept here so
-- that choice stays visible and auditable rather than baked silently into the
-- load. Same family of trap as aggregate RAUM and master/feeder fund GAV.
--
-- One flat row per offering (submission + offering + primary issuer joined at
-- load time): unlike the ADV pipelines there is no point-in-time state to
-- reconstruct — each filing is an event, not a snapshot of a universe.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_d_offerings (
    accession_number        VARCHAR PRIMARY KEY,
    filing_date             DATE,
    quarter                 VARCHAR,              -- source file's quarter, e.g. 2026Q2
    submission_type         VARCHAR,              -- D | D/A
    is_amendment            BOOLEAN,
    previous_accession_number VARCHAR,            -- the offering this amends (may predate this quarter)
    industry_group          VARCHAR,
    investment_fund_type    VARCHAR,              -- Hedge Fund / PE / VC / Other (pooled funds only)
    is_pooled_fund          BOOLEAN,
    total_offering_amount   DOUBLE,               -- may be "indefinite" and hence null
    total_amount_sold       DOUBLE,
    min_investment          DOUBLE,
    has_non_accredited      BOOLEAN,
    issuer_name             VARCHAR,
    issuer_state            VARCHAR,
    entity_type             VARCHAR,
    source_archive          VARCHAR
);

-- Placement agents / brokers named on an offering. RECIPIENTCRDNUMBER is a
-- real CRD, but a 2026Q2 check matched only 137 of ~17K tracked advisers:
-- recipients are overwhelmingly broker-dealers, not the RIAs this site
-- covers, so this feeds an aggregate league table only — NOT a per-firm card,
-- which would be empty for ~99% of firms.
CREATE TABLE IF NOT EXISTS form_d_recipients (
    accession_number        VARCHAR,
    recipient_seq_key       VARCHAR,
    recipient_name          VARCHAR,
    recipient_crd           BIGINT,
    associated_bd_name      VARCHAR,
    associated_bd_crd       BIGINT,
    state                   VARCHAR,
    source_archive          VARCHAR
);
