# Directive for Fable 5 — Open Disclosure: customizable benchmarking + firm enrichment

You're working in `ricksterz/advisorapp`. Read `README.md` and `CLAUDE.md` first for
project context. This brief describes two workstreams: (1) turn the benchmarking
logic from hardcoded constants into a transparent, user-controllable engine, and
(2) enrich firm records with website, bio, and outreach info. Do not rebuild the
FastAPI backend or change the "no backend, static JSON" deployment model unless a
task below explicitly says to — that architecture is intentional and correct for
the current scale (~15–40K firms, monthly-refresh data).

## Current state (verified by reading the code, not guessing)

- `frontend/src/App.jsx` — single-file React app. `computeRankings(firms)`
  (lines ~74–122) computes two lists — "Top advisory firms" and "Elevated-risk
  signals" — from **hardcoded** weights and thresholds: eligibility floor
  `aum_total >= 1e8`, weights `0.4/0.25/0.2/0.15`, risk point values
  `15/15/10/15`, risk display threshold `score >= 40`. None of this is
  configurable without editing source.
- **Known bug**: the "20% clean record" weight in the Top score is added as a
  flat `+ 0.2` constant — clean record is already an eligibility gate (firms
  with disclosures are filtered out before scoring), so this term never varies
  and contributes nothing to rank ordering. Fix this as part of the refactor
  (e.g. replace with a graded factor — years since last disclosure, or drop the
  term and redistribute its weight).
- Percentiles are computed **once against a single global pool** (all firms
  ≥$100M AUM) — `percentiler()` in `App.jsx`. The app's own footer copy
  correctly explains that gross regulatory AUM makes cross-scale comparisons
  misleading (fund complexes vs. boutique RIAs), but the ranking engine doesn't
  correct for it. No peer cohorting exists anywhere.
- Data flow: `etl/ingest_adv.py` (Form ADV bulk XML/CSV → DuckDB per
  `etl/schema.sql`) → `etl/export_json.py` (lean export, 14 columns, see
  `EXPORT_COLUMNS`) → `frontend/public/firms.json` → client-side fetch/filter in
  `App.jsx`. `backend/app/main.py` (FastAPI) exists but is **not** used by the
  deployed site — GitHub Pages and the Cloudflare Workers deploy (`wrangler.jsonc`)
  both serve the static build only.
- Schema has **no** `website_url`, `social_media`, `phone`, or bio-type fields.
  The `advisors` table exists in `schema.sql` but is never exported or rendered
  — the UI is firm-only, and there is no per-firm detail view at all, just one
  flat sortable table plus two ranking cards.
- Styling: plain CSS custom properties in `frontend/src/index.css`
  (`--page`, `--surface`, `--ink`, `--accent`, etc., themed per
  `[data-theme="dark"|"light"]`). Reuse these tokens for anything new — don't
  introduce Tailwind, a component library, or a second design system.
- `wrangler.jsonc` already sets `"not_found_handling": "single-page-application"`
  — client-side routing is anticipated but unused. There is currently no router
  at all (no react-router, no hash routes).

## Why this matters competitively

The app already positions itself against Barron's / CNBC FA 100 / Forbes-SHOOK
in its own methodology copy (`SOURCES` array, the `<details>` methodology
block). Those rankings are opaque — survey- and relationship-driven, black-box
weighting. Advisor-matching products like SmartAsset, Zoe Financial, and
Wealthtender compete on curated/claimed profiles, not on regulatory-grade,
reproducible data. This app's actual edge is: **built entirely from what firms
are legally required to disclose, and the methodology is code you can read.**
The two workstreams below are both in service of that edge — a benchmark the
user controls (not just reads about) is more defensible than a black box, and
enrichment makes the tool useful for actually picking an advisor, not just
auditing one.

---

## Workstream 1 — Customizable benchmarking engine (do this first; it's a pure refactor, no new data sources needed)

**Goal**: every number currently hardcoded in `computeRankings()` becomes a
parameter in a `MethodologyConfig`, with a UI to change it, live recomputation,
and a shareable/bookmarkable result.

1. Extract a `frontend/src/benchmarking/` module:
   - `factors.js` — registry of scoring factors: `{ id, label, accessor(firm),
     normalize: 'percentile' | 'boolean' | 'ratio', direction, defaultWeight }`.
     Port scale, productivity, fee-alignment as-is; replace the flat
     clean-record term per the bug fix above.
   - `screens.js` — eligibility predicates as data:
     `{ id, label, predicate(firm, params), defaultParams }` (min AUM, min
     advisory staff, max disciplinary flags, etc.), separately for the Top
     list and the Risk list — don't force them to share one screen.
   - `cohort.js` — peer grouping, three dimensions, all in scope for this pass
     (not deferred):
     - **AUM band** — e.g. $100M–$1B / $1B–$10B / $10B+ — so percentiles are
       computed within a firm's own scale bracket, not the full universe.
     - **Client-mix profile** — bucket firms by dominant client type from the
       existing `pct_clients_*` fields (e.g. individual/HNW-focused vs.
       institutional/pooled-vehicle-focused vs. pension/corporate-focused).
       Pick a simple rule (dominant category by highest percentage, or a small
       fixed set of mix "shapes") rather than a fuzzy clustering model — this
       needs to stay explainable in the methodology copy, not be a black box
       itself.
     - **State / region** — Form ADV Item 1.F (principal office address)
       gives state; add `state` to the schema/ETL/export if not already
       captured, and cohort by state or a small set of census-style regions
       (state alone will over-fragment for low-density states — decide a
       reasonable regional grouping rather than 50+ single-state cohorts with
       tiny sample sizes).
     Support **combining** dimensions (e.g. AUM band × client-mix) but guard
     against empty or tiny cohorts — if a cohort has fewer than ~10 firms,
     percentile ranking is meaningless; fall back to the next-broadest cohort
     and say so in the UI ("cohort too small — showing AUM-band only").
   - `engine.js` — pure function `computeRankings(firms, config)` with the same
     output shape as today, but entirely config-driven. No UI code in here —
     must be independently testable.
   - `presets.js` — 3–4 named configs: `"Default (current methodology)"`,
     `"Boutique / HNW-focused"` (lower AUM floor, weight client concentration),
     `"Institutional scale"` (higher AUM floor, weight productivity harder),
     `"Clean-record only"` (zero-tolerance risk screen, ignore scale entirely).
     Ship these as real, sensible presets — not filler.
2. Build a `MethodologyPanel` component: sliders/number inputs bound to the
   active config, cohort controls (AUM band toggle, client-mix toggle,
   region toggle — independently combinable per above), a preset dropdown,
   and a "Custom" state that activates the moment any control is touched.
   Recompute must be instant (it already is — this is client-side
   sort/percentile over data already in memory).
3. **State-in-URL**: encode the active `MethodologyConfig` as a compact
   base64 JSON query param (e.g. `?m=eyJ3...`). This makes a specific ranking
   view a shareable, reproducible link — "here's how *I* rank advisors, and
   here's exactly why" — which is a real differentiator against black-box
   competitor rankings. Add a "Copy link to this view" button next to the
   methodology panel.
4. Keep the existing `<details>` methodology writeup, but make it dynamic —
   render the actual active weights/thresholds into the prose instead of the
   current static text, so the explanation always matches what's on screen.

**Acceptance criteria**
- [ ] Changing any weight or threshold in the UI recomputes both ranking
      lists with no page reload, in well under 200ms for the current firm count.
- [ ] The clean-record scoring bug is fixed and verifiable (two firms with
      identical scale/productivity/fees but different disclosure recency
      produce different scores).
- [ ] AUM-band, client-mix, and region cohorting are all implemented and
      independently selectable, and can be combined; switching cohort scope
      visibly changes who appears in the Top list.
- [ ] Cohorts below the minimum sample-size threshold fall back gracefully
      and the UI explains why (never silently show a percentile computed on
      3 firms).
- [ ] A methodology URL, when opened fresh (no prior client state), reproduces
      the exact same ranking output.
- [ ] All four presets exist, are meaningfully different from each other, and
      are documented in the methodology copy.

---

## Workstream 2 — Website, bio, and outreach enrichment

**Goal**: every firm row can link out to its real website, and (where the data
exists) show a fuller profile — without inventing data that isn't public.

### 2a. Website + social (P0) — bulk ingestion, decided

Go with bulk ingestion for `website_url`, same pattern as every other field:

- Form ADV **Item 1.I** (Schedule D, Section 1.I) is the legitimate public
  source for a firm's website and social media addresses. Pull one real
  `IA_FIRM_SEC_Feed` XML sample and check whether Schedule D item 1.I ships in
  the same feed file `read_firm_feed()` already parses, or in a separate
  schedule-data file — the bulk compilation CSV vintage may differ too. Follow
  the existing pattern exactly: add candidate headers to `FIRM_COLUMNS`, log
  "not found in this vintage" rather than failing hard if a given
  compilation drops it (same as every other field in `ingest_adv.py` already
  does). If Item 1.I genuinely isn't present in the feed/compilation you're
  using, that's a real blocker to raise back to Ricky, not something to
  silently work around with scraping.
- Add `website_url` (and capture `state` here too, from Item 1.F, since it's
  needed for Workstream 1's region cohorting anyway — same ingestion pass)
  to `schema.sql`, `FIRM_COLUMNS` / `read_firm_feed()` in `ingest_adv.py`, and
  `EXPORT_COLUMNS` in `export_json.py`. Minor payload growth from two extra
  short fields across ~15–40K firms is negligible.
- **Brochure and Form CRS links are different** — those aren't part of the
  Item 1.I bulk data at all, and don't have a bulk equivalent. For those,
  still use the on-demand path: IAPD's public firm-summary pages
  (`https://adviserinfo.sec.gov/firm/summary/{crd}`) are backed by a public
  JSON API at `api.adviserinfo.sec.gov` — confirmed to return brochure URLs
  and Form CRS URLs per CRD, no key required. Inspect the network request
  that page makes to get the exact shape, then lazy-fetch this only when a
  user opens a firm's detail view (Workstream 2b) — no reason to bulk-ingest
  PDF URLs into `firms.json` when they're only needed one-at-a-time.

### 2b. Firm detail view (P0 — new UI surface, not just a field)
- There is currently no per-firm page or panel. Add one — a drawer/modal is
  fine for v1, but given `wrangler.jsonc` already anticipates SPA routing,
  prefer a real route (`#/firm/:crd` via a minimal hash router, or
  `react-router` if you want history-API URLs) so firm profiles are
  **shareable and indexable** — a genuine SEO/growth lever competitor
  directories rely on.
- Detail view shows: website link (favicon + domain), IAPD profile link
  (existing), Form ADV brochure link(s) and Form CRS link (from the
  on-demand API above), full client-mix breakdown, fee structure, and
  affiliation flags already in the dataset but not currently surfaced per-firm
  beyond the table row.

### 2c. Advisor bios (P1 — do not build in this pass without validating scope)
- No structured public source exists. The closest legitimate data is the
  "Educational Background and Business Experience" section of Form ADV
  **Part 2B** brochure supplements — PDF only, one per supervised person,
  no bulk feed. This requires a PDF-text extraction pipeline (the same class
  of problem `CLAUDE.md` already flags as "messy, iterate after core works"
  for the deal-structuring layer). Scope as a separate follow-on project, not
  part of this pass — flag it to Ricky as its own effort rather than silently
  shipping a half-working PDF scraper.

### 2d. Outreach / scheduling — ship v1 only, flag v2 as a decision, not a default
- **v1 (build now, no opt-in required)**: "Visit website" outbound link,
  IAPD profile link, brochure/CRS links. This is fully supportable from
  public data with no compliance surface.
- **v2 (do NOT build without an explicit decision from Ricky)**: a "claimed
  profile" model where a firm verifies control of a CRD (e.g. confirm the
  Item 1.J filing-contact email on record) and adds a scheduling link
  (Calendly/Cal.com URL) plus a monitored contact address, with a simple
  "Request an introduction" form that emails the firm rather than the app
  building scheduling infrastructure itself. This turns the product into a
  directory/lead-gen tool (closer to SmartAsset/Zoe/Wealthtender) and raises
  real questions — Advisers Act marketing-rule implications if any referral
  fee is involved, verification/anti-impersonation process, and a real
  monetization decision (free listing / paid claimed tier). Write this up as
  an open question for Ricky, don't default into it.

**Acceptance criteria**
- [ ] Firm rows and the new detail view show a working outbound website link
      wherever Item 1.I data (or the on-demand API) has one, and show nothing
      (not a broken link) where it doesn't.
- [ ] Detail view is reachable via a shareable URL and renders correctly on a
      cold load of that URL (no client-side-only state required).
- [ ] No bio data is fabricated or inferred — if Part 2B parsing isn't built
      this pass, the UI simply omits a bio section rather than showing a stub.
- [ ] No scheduling/claimed-profile UI ships in this pass unless Ricky has
      explicitly signed off on the v2 scope above.

---

## Non-goals for this pass
- No new backend deployment (FastAPI stays dormant/optional).
- No brochure PDF parsing / advisor bios (2c is scoped out, not built).
- No claimed-profile or scheduling infrastructure (2d v2) without explicit sign-off.
- No design-system change — reuse existing CSS custom properties.

## Suggested sequencing
1. Workstream 1, full scope including all three cohort dimensions
   (AUM band, client-mix, region) — self-contained, no new data sources,
   highest-visibility differentiation. Note the `state` field this needs is
   pulled in during the same ETL pass as website data (step 2), so land the
   ETL change first even though it's listed under Workstream 2.
2. `state` + `website_url` bulk ingestion (ETL/schema/export changes) —
   unblocks both region cohorting in Workstream 1 and website links in
   Workstream 2.
3. Workstream 2b (firm detail route) + on-demand brochure/CRS API call +
   2d-v1 static outbound links — ships together, all live on the new detail view.
4. Everything else (2c bios, 2d-v2 claimed profiles / lead-gen) is explicitly
   deferred — not this pass, no scaffolding for it now either.

## Decisions (resolved — do not re-litigate these)
- Cohorting: build all three dimensions (AUM band, client-mix, region) now,
  combinable, with small-cohort fallback. Not deferred to a later version.
- Claimed-profile / lead-gen (2d v2): deferred. Do not build the claim flow,
  scheduling links, or "request an introduction" form in this pass — v1
  static outbound links only (2d-v1).
- Website data: bulk ingestion via Item 1.I, not on-demand. On-demand is
  reserved specifically for brochure/CRS PDF links, which have no bulk
  equivalent.
