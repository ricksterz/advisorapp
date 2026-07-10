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

CREATE TABLE IF NOT EXISTS advisors (
    crd                 BIGINT PRIMARY KEY,       -- individual advisor CRD
    full_name           VARCHAR,
    current_firm_crd    BIGINT,                   -- FK -> firms.crd
    licenses            VARCHAR,                  -- comma-separated exam/license codes
    tenure_years        DOUBLE,                   -- years at current firm
    disciplinary_count  INTEGER DEFAULT 0,
    prior_firm_crds     VARCHAR                   -- comma-separated prior firm CRDs
);

CREATE TABLE IF NOT EXISTS deal_structuring (
    firm_crd            BIGINT,                   -- FK -> firms.crd
    source_document     VARCHAR,                  -- brochure filename / URL
    proprietary_funds   BOOLEAN,                  -- firm places clients in its own funds
    revenue_sharing     BOOLEAN,
    affiliated_gp_lp    BOOLEAN,                  -- affiliated GP/LP fund structures
    extracted_at        TIMESTAMP
);
