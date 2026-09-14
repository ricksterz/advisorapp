# Industry Pulse — plan (deliverables 1–3, pre-implementation)

Written 2026-07-18, against the codebase as of PR #40/#41 merged, PR #42 (advisor
bios) open. Scaffolding code (deliverable 4) starts only after Ricky confirms
this plan. Design reference: SEC Private Fund Statistics page (pattern, not
content).

## 0. Source verification (done before planning, per house rules)

- **Form D**: SEC publishes official quarterly structured data sets
  (sec.gov/data-research/sec-markets-data/form-d-data-sets) — six TSV tables
  per quarter (FORMDSUBMISSION, ISSUERS, OFFERING, RECIPIENTS, ...), covering
  every Reg D exempt-offering notice since 2008. Bulk, free, no key. ✔
- **Historical ADV**: SEC publishes quarterly Form ADV Part 1 CSVs from 2001
  (registered advisers) / 2011 (ERAs) — crucially including **all Schedules
  and DRPs**, not just the base table (adviserinfo.sec.gov/adv for 2025+,
  sec.gov FOIA page for earlier). This one source unlocks three brief
  requirements at once: YoY/QoQ deltas, registrations-vs-withdrawals (ADV-W
  data), and the ADV↔Form D linkage (Schedule D 7.B.(1) records each private
  fund an adviser manages, incl. Form D file numbers). ✔
- **BrokerCheck individual data**: verified earlier in this project — **no
  bulk feed exists**; individual records are per-CRD API lookups only. This
  materially constrains Phase 3 (see below). ✖ partially

## 0b. Source verification round 2 (2026-07-19, actual endpoints confirmed by download)

Found by reading the IAPD SPA's own JS bundle (the site is WAF-hostile to
non-browser clients; the reports host accepts the project UA):
- Manifest of current feeds: `reports.adviserinfo.sec.gov/reports/CompilationReports/CompilationReports.manifest.json`
- Historical/FOIA index: `reports.adviserinfo.sec.gov/reports/foia/reports_metadata.json`
  → sections: advFilingData (monthly `ADV_Filing_Data_YYYYMMDD_YYYYMMDD.zip`,
  2024→present, ~9MB/mo, 101 CSVs each incl. IA_ADV_Base_A/B, ALL Schedule D
  tables incl. the 7B1 family, and per-category DRP files), advW (monthly
  ADV-W withdrawal filings), advBrochures, firm CRS.
- **`IA_INDVL_Feed_MM_DD_YYYY.xml.zip` (167MB) exists in the compilation
  manifest — a bulk INDIVIDUAL adviser feed.** Our earlier "no bulk individual
  feed" conclusion was wrong; Phase 3's individual-level work is unblocked
  pending a schema look at this feed.
- Structural caveat: monthly files are FILING windows, not universe
  snapshots. Point-in-time quarterly snapshot = latest filing per CRD over
  the trailing 12 months → first complete snapshot ≈ 2025Q1; ~6-7 complete
  quarters available from this endpoint today. Pre-2024 extension possible
  later via the sec.gov FOIA archive (WAF'd for bots; manual download works).

## 1. Where aggregation runs — recommendation differs from the brief

The brief says "precompute via Cloudflare Worker cron." Recommendation:
**precompute in the existing Python ETL instead**, because the aggregation
inputs are DuckDB + pandas over multi-GB quarterly CSV/TSV archives — that
toolchain can't run in a Worker, and the repo already has exactly the right
machinery: `pages.yml` (already on a monthly cron) for CI-computable stats,
and workstation refresh scripts for corpus-derived data. Output is a small
committed/deployed static `pulse_stats.json` — same pattern as
`deal_flags.json`, already proven here. The site remains static-first either
way; a Worker cron adds a second compute environment, a KV/R2 storage
dependency, and a Python-in-JS rewrite of ingestion for no user-visible gain.

Where a Worker cron *would* earn its keep later: refreshing Form D counts
between quarterly ADV cycles (Form D files continuously, and its data is
small enough to fetch/serve without pandas). Proposed: Phase 2 ships Form D on
the same static cadence first; a Worker cron freshness upgrade is a separate,
optional follow-on decision.

Per-module cadence (displayed on every module per the brief):
- ADV-derived stats: **quarterly** (SEC's own posting cadence; ~1mo lag).
- Form D: **monthly** initially (matches pages.yml cron), upgradeable.
- Brochure-derived (deal flags): on-demand workstation refresh, dated as such.

## 2. Deliverable 1 — IA / component tree

Routing: extend `router.js`'s single-purpose firm router into a small
path-table router (still no react-router; ~20 lines). New routes:

```
/pulse                         PulsePage
/pulse/advisers                DrilldownAdvisers      (Phase 1)
/pulse/assets                  DrilldownAssets        (Phase 1)
/pulse/fees                    DrilldownFees          (Phase 1.5 — cheap once machinery exists)
/pulse/capital-formation       DrilldownFormD         (Phase 2)
/pulse/disclosures             DrilldownDisclosures   (Phase 3)
/pulse/custody                 DrilldownCustody       (deferred — see Open Questions)
```

Component tree (all reusing existing tokens/patterns, no chart library —
in-house SVG/CSS primitives, consistent with DealPatternsSection):

```
PulsePage
├── PulseDisclaimer          — "not affiliated with SEC/FINRA; derived from public
│                              filings; may lag official sources" (top of page)
├── KpiStrip
│   └── KpiCard ×5           — headline number, QoQ/YoY delta arrow (▲ green /
│                              ▼ red / – neutral via --good/--critical tokens),
│                              one-line definition, AsOfTag
├── CategoryTileGrid
│   └── CategoryTile ×N      — sparkline + one stat + link to drill-down
└── MethodologyFootnote      — shared component; every stat's footnote text
                               lives in a single pulseMeta registry so copy
                               stays consistent between KPI and drill-down

Drilldown* (shared shell: DrilldownPage)
├── AsOfTag + cadence label
├── chart primitives:  TrendLine (SVG polyline, quarterly series)
│                      BandBars (reuse .track/.fill meter pattern)
│                      StateTable (sortable, reuses existing table CSS)
└── MethodologyFootnote

FirmDetail additions (Section 3 of the spec)
├── CompareStrip             — "How does this compare?" — cohort percentile for
│                              AUM, AUM/professional, disclosure count vs cohort
│                              median. Computed CLIENT-side by the existing
│                              benchmarking engine (percentiler/cohorts already
│                              in the bundle — no new data needed; read-only
│                              reuse, no changes inside benchmarking/)
├── FormDList                — linked Form D offerings (Phase 2; lazy JSON)
└── DisclosureBadge          — firm disclosure count vs cohort median (Phase 1,
                               ADV Item 11 data — BrokerCheck NOT required)
```

Data files served (all with `generated_at` + per-module `as_of`):
- `pulse_stats.json` (~tens of KB) — KPI strip + all drill-down series.
- `form_d_index.json` (Phase 2) — per-firm Form D offering lists, lazy-loaded
  by FirmDetail like deal_flags.json/advisor_bios.json.

## 3. Deliverable 2 — schema additions (etl/schema.sql)

```sql
-- Quarterly point-in-time snapshot of headline firm fields, loaded from the
-- SEC's historical quarterly ADV CSVs (2001+) and appended each quarter by
-- the normal refresh. Everything Pulse computes that involves time (deltas,
-- registrations/withdrawals, AUM-band migration) reads from here; `firms`
-- stays what it is today — the latest snapshot only.
CREATE TABLE IF NOT EXISTS firm_snapshots (
    snapshot_quarter  DATE,      -- quarter-end date the CSV represents
    crd               BIGINT,
    aum_total         DOUBLE,
    aum_discretionary DOUBLE,
    employees_advisory BIGINT,
    state             VARCHAR,
    fee_pct_of_aum    BOOLEAN,
    fee_performance_based BOOLEAN,
    fee_commissions   BOOLEAN,
    disciplinary_flag_count INTEGER,
    PRIMARY KEY (snapshot_quarter, crd)
);

-- Form D offerings (SEC quarterly structured data sets; one row per filing).
CREATE TABLE IF NOT EXISTS form_d_offerings (
    accession_no      VARCHAR PRIMARY KEY,
    cik               BIGINT,
    issuer_name       VARCHAR,
    filing_date       DATE,
    is_amendment      BOOLEAN,
    state             VARCHAR,
    industry_group    VARCHAR,   -- Form D's own industry taxonomy incl. "Pooled Investment Fund"
    total_offering    DOUBLE,    -- NULL = "Indefinite"
    total_sold        DOUBLE,
    first_sale_date   DATE
);

-- ADV firm ↔ Form D linkage, with provenance. Primary link path: ADV
-- Schedule D 7.B.(1) (each private fund the adviser manages, with Form D
-- file numbers) from the same quarterly CSV archives. `link_method` records
-- how each link was made so weaker methods (name match) are distinguishable
-- and can be excluded from headline stats.
CREATE TABLE IF NOT EXISTS form_d_links (
    firm_crd          BIGINT,
    cik               BIGINT,
    link_method       VARCHAR,   -- '7b1_file_number' | 'related_person' | 'name_match'
    linked_at         TIMESTAMP
);
```

New ETL modules: `etl/ingest_formd.py` (quarterly TSV → form_d_offerings),
`etl/ingest_adv_history.py` (backfill + quarterly append of firm_snapshots;
also parses Schedule D 7.B.1 for links), `etl/pulse_stats.py` (aggregate →
pulse_stats.json + form_d_index.json, with the export skipping when tables
are empty — the same CI-safety pattern as export_deal_flags()).

## 4. Deliverable 3 — phased rollout

**Phase 1 — ADV-only Pulse (no new external dependencies beyond historical CSVs):**
1. Backfill `firm_snapshots` from SEC quarterly CSVs (propose 12 quarters —
   enough for YoY on every KPI plus a 3-year trend line; backfill depth is an
   open question below).
2. `etl/pulse_stats.py` + `pulse_stats.json`.
3. Router generalization + PulsePage + KpiStrip (metrics: active RIAs tracked;
   aggregate RAUM **with the double-counting caveat as its definition line —
   see Open Questions**; median firm AUM by cohort; % of firms with a
   disclosure event; Form D KPI ships in Phase 2 as "coming" tile or omitted).
4. Two drill-downs: **advisers** (net registrations by quarter, by state) and
   **assets** (aggregate + median trend, AUM-band migration matrix).
5. FirmDetail `CompareStrip` + `DisclosureBadge` (both computable today —
   engine reuse + ADV Item 11).
6. Homepage gets a small "Industry Pulse →" entry tile.

**Phase 2 — Form D capital formation:**
1. `etl/ingest_formd.py` + linkage via Schedule D 7.B.1; validate link
   precision on a hand-checked sample (house rule: sample before shipping).
2. `/pulse/capital-formation`: trailing-12mo raised, offerings count, median
   raise, by state/industry/quarter; restricted headline stats to
   "Pooled Investment Fund" industry group so numbers stay adviser-relevant.
3. FirmDetail `FormDList` from `form_d_index.json`; Form D KPI joins the strip.
4. Optional follow-on decision: Worker cron for sub-quarterly freshness.

**Phase 2b — private funds module (added 2026-07-18 after Ricky pointed at the
SEC Private Fund Statistics page's content, not just its pattern):**

What's replicable from that page splits on a data-access line: its
leverage/exposure/investor-composition/performance tables come from Form PF —
a CONFIDENTIAL filing no one outside the SEC can use — but its fund-census
tables derive from public ADV Schedule D 7.B, which is in the same quarterly
CSVs Phase 1 already ingests. Per fund: fund type (hedge/PE/VC/RE/liquidity),
gross asset value, domicile, and per-fund service providers (auditor, prime
broker, custodian, administrator). Module content, all public-data-derived:
1. `/pulse/private-funds`: fund counts + gross assets by type, quarterly
   trend; advisers ranked by number of funds managed; fund domicile mix.
2. Service-provider concentration league tables (auditors, prime brokers,
   administrators, custodians) — high-value, rarely-surfaced, and a natural
   cross-link INTO firm profiles ("audited by X, prime broker Y").
3. FirmDetail: per-firm private-fund list (type, GAV, providers) — pairs with
   the Phase 2 FormDList since both parse out of the same Schedule D 7.B pass.
Honest-labeling requirement: the module must state it covers what advisers
publicly report on ADV 7.B, and is not comparable to the SEC's Form
PF-derived statistics.

**Shipped 2026-07-27.** Verified against a real cached ADV_Filing_Data
archive before writing any code: `IA_Schedule_D_7B1` (fund
name/type/domicile/GAV/exclusion/master-feeder) plus the named sub-item
tables `IA_Schedule_D_7B1A23/24/25/26/28` (auditor/prime broker/
custodian/administrator/marketer — actual names, not just the main table's
Y/N flags). `etl/private_funds.py` reuses pulse_history's cached archives
directly, no new download. v1 scope is current-known-state per fund (latest
filing per stable `fund_id`, same staleness window as firm_snapshots), not a
quarterly time series — deferred as a fast-follow if wanted, matching this
project's ship-the-core-then-iterate pattern.

Real numbers from the 2026-07-27 pull: 72,206 funds, 5,870 distinct
advisers. Master/feeder GAV overlap is real (~3.7% of total GAV) — feeder
funds are excluded from every GAV sum, and no single cross-type GAV total is
shown, same reasoning as the site's aggregate-RAUM decision. Provider names
needed light normalization (stripping legal suffixes) to stop "KPMG LLP" /
"KPMG, LLP" / "KPMG" from fragmenting the league tables — raw names are kept
in the database, normalization is grouping-only. `firm_private_funds.json`
is capped at 20 funds/firm (by GAV) to match what FirmDetail actually
renders — uncapped it was 30MB raw; capped it's 17.6MB raw / 1.7MB gzip, in
line with advisor_bios.json's existing footprint.

Not built: quarterly trend, and the SEC Form D data source (Phase 2) is
still blocked — `www.sec.gov`/`data.sec.gov` returned 403 (Akamai) from this
environment on 2026-07-27; revisit when that access is available.

**Phase 2 (Form D) unblocked and shipped 2026-07-28.** Ricky downloaded the
quarterly zip by hand after the WAF block was confirmed persistent; the
loader therefore has NO fetch stage by design — it reads whatever quarterly
zips are sitting in `data/raw/formd/`, so adding history is just dropping
more files in and re-running. Schema verified against the real 2026Q2 file
(six TSVs + a self-describing `FormD_metadata.json`).

Two plan assumptions were wrong and were corrected against real data:
- **The per-firm `FormDList` was dropped.** `RECIPIENTS.RECIPIENTCRDNUMBER`
  is a genuine CRD, but only 137 of ~17K tracked advisers appear as
  recipients — recipients are overwhelmingly broker-dealers placing
  offerings, not the RIAs this site covers, so a per-firm card would be
  empty for ~99% of firms. The broker data feeds an aggregate
  placement-agent league table instead.
- **The headline "capital raised" number is a trap.** A D/A amendment
  restates an ongoing offering's CUMULATIVE amount sold rather than
  reporting new capital. Summing all rows gives $2.97T for 2026Q2 vs $186B
  counting new offerings only — 16x inflation, the same family of error as
  aggregate RAUM (PR #19) and master/feeder GAV (PR #49). Every aggregate
  counts new offerings only, and the excluded amendment count is stated on
  the page rather than buried.

Two further real-data bugs caught during the build:
- `IS_PRIMARYISSUER_FLAG` is spelled `YES`/`NO` while the same data set's
  OFFERING booleans use `true`/`false` — matching on "true" silently emptied
  every issuer name/state field until a real-data check caught it.
- ~28% of new offerings report $0 sold (an issuer files when the offering
  opens, before raising anything), which dragged "median raised" to $0 for
  whole categories — 57% of private-equity offerings. Medians now cover
  offerings that have raised something, with the not-yet-raised count shown
  alongside.

Surfaces: `/pulse/capital-formation` (fund types, industries, issuer states,
placement-agent league table) plus the Pulse KPI strip's `form_d` card,
which was a "coming in a future update" placeholder until now.

**Backfilled to six quarters (2025Q1-2026Q2) the same day**, again by hand.
The incremental loader picked up the five new zips and skipped the already
loaded one with no code change, which was the point of the no-fetch-stage
design. Verified before publishing the trend: each quarterly file contains
exactly its own quarter's filings (no bleed across file boundaries), zero
accession numbers appear in more than one file (no double count), and
monthly counts rise smoothly rather than stepping at a file boundary — so
the +36% YoY is real growth, not an artifact. Worth noting when reading it
that 2025Q2 is the trough of the series, which flatters a YoY measured
against it; the drill-down table shows every quarter so that's visible
rather than hidden.

One display bug fell out of having a real series: `fmtCompactUsd` rounded
millions to whole numbers, so medians drifting $1.31M -> $1.60M rendered as
"$1M, $1M, $2M, $1M, $1M, $2M" — reading as violent swings in what is nearly
a flat line. Single-digit millions now keep one decimal, mirroring the rule
the same function already applied to single-digit billions. Nothing else on
the site displays in that band (private-fund medians are all $10M+), so no
other page changed.

**Quarterly trend shipped 2026-07-28.** New `private_fund_snapshots` table
replays the same latest-filing-per-fund reconstruction once per
Pulse-published quarter (gated on the SAME `published_quarters()` list
pulse_stats.py already computes from firm_snapshots — one canonical
completeness gate, not a second one recomputed for funds). No per-quarter
provider join; a trend needs fund counts/types/GAV, not the 282K-row
provider table replayed five times. `etl.private_funds run` picks this up
automatically (new `quarterly` stage alongside `load`/`snapshot`), so
`refresh_deal_flags.sh` needed no changes. Real series (2026-07-28 pull):
63,886 -> 72,206 funds from 2025Q2 to 2026Q2, a visible jump at 2026Q1
consistent with the annual-amendment filing clustering seen elsewhere in
this project. Surfaced as a new "Fund count by quarter" card on
`/pulse/private-funds` (QoQ/YoY deltas) and a trend sparkline on the
homepage Pulse tile.

**Phase 3 — disclosure/complaint benchmarks:**
1. Firm-level benchmarks need no BrokerCheck at all (ADV Item 11 vs cohort) —
   parts of this actually land in Phase 1 (DisclosureBadge).
2. Individual-level red-flag surfacing was **gated on a feasibility spike** —
   ~~no bulk individual feed exists~~ (this earlier conclusion was wrong; see
   below).

**Spike result (2026-07-21): feasible, shipped.** Found
`IA_INDVL_Feed_MM_DD_YYYY.xml.zip` in the compilation manifest (same host as
the ADV archives, not the FOIA index this project checked before) — a
daily-refreshed bulk feed of all ~436K IAPD individuals (a first-pass manual
check via `grep -c` undercounted this badly — BSD grep silently mishandles
this feed's very-long-line files; the real total only surfaced once
double-checked with a second, independent method: Python `read_text()` +
regex, cross-validated against the actual ETL's lxml parse). Each person
carries at most one `<DRP>` element with nine Y/N disclosure-category
booleans (no narrative/date/dollar detail — real detail requires following
the record's `link` to its IAPD summary page); ~13.8% of individuals
(60,038 / 436,088 in the 2026-07-21 pull) have >=1 flagged category.
Confirmed `indvlPK` == CRD by
cross-matching against real advisor-bios data (PR #42). No per-CRD crawling
needed — the whole universe is one file.

Shipped as a narrow slice rather than a new surface: `etl/individual_disclosures.py`
loads flagged individuals (keyed on CRD) into a new `individual_disclosures`
table; `export_advisor_bios()` joins it onto each advisor's existing entry in
`advisor_bios.json` by CRD. `refresh_deal_flags.sh` now also runs
`etl.advisor_bios` (previously missing from the script entirely — the
`advisors` table it populates was never wired into the refresh flow) and
`etl.individual_disclosures`. A badge on the advisor-bio card (PR #45) later
covered per-advisor rendering.

**`/pulse/disclosures` shipped 2026-07-28**, completing the Phase 3 module
from the original component tree. Two halves:
- Firm-level: reuses `pulse_stats.json`'s existing `pct_disclosure` series
  (no new ETL) — a per-quarter table of the share of firms with a Form ADV
  Item 11 disclosure.
- Individual-level: new `etl/individual_disclosures_stats.py`, category
  breakdown (customer complaint, criminal, bankruptcy, etc.) as a share of
  ALL individuals in the bulk feed, not just the flagged subset kept in
  `individual_disclosures` — needed a schema addition
  (`individual_disclosures_meta`) to capture the TRUE total individual
  count at load time (`parse_feed` previously discarded it, keeping only
  flagged rows). Real numbers (2026-07-28 pull): 60,038 / 436,088 = 13.8%
  flagged; customer complaints dominate (66% of flagged individuals, 9.1%
  of everyone), consistent with known industry disclosure patterns.

Found and fixed one real correctness bug while building this: DuckDB
silently reinterprets a timezone-aware Python datetime as the SYSTEM's
local wall-clock time when inserted into a plain `TIMESTAMP` column
(verified: 2026-07-28 00:00 UTC on a UTC-5 machine read back as
2026-07-27 19:00). `individual_disclosures.py`'s `stage_load()` now strips
tzinfo after computing the correct UTC instant, so `individual_disclosures_stats.py`
can safely take `.date()` on the stored value for "as of" — this would
otherwise have been silently wrong by a day depending on server timezone
and time of refresh, and CI (which runs in UTC) would never have caught it.

## 5. Open questions for Ricky (blocking confirmation)

1. **Aggregate RAUM as a KPI**: we deliberately removed aggregate RAUM from
   the homepage (PR #19) as misleading. On a statistics page with methodology
   footnotes (like the SEC's own), presenting it is defensible — proposal:
   include it, with the caveat baked into the card's definition line, not
   hidden in a footnote. Confirm or drop it from the strip.
2. **Worker cron vs existing ETL cron** — plan recommends existing ETL
   (Section 1). Confirm, or say Worker-native matters to you and Phase 2 will
   include it.
3. **Backfill depth** — 12 quarters proposed. Each quarter's CSV set is
   sizeable; 2001-to-present is possible but slows every refresh for trend
   depth the UI won't show initially.
4. **Custody drill-down**: current feed parsing captures no Item 9 custody
   fields; adding them = ADV ingestion changes + a snapshot-schema column
   bump. Proposed: defer custody to its own later slice rather than pad
   Phase 1. Confirm.
5. **/pulse SEO**: presumably index it (sitemap + Dataset JSON-LD extension).
   Assume yes unless said otherwise.
```
