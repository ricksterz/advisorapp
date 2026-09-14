# Scope: brochure PDF pipeline (deal-structuring flags + advisor bios)

Written 2026-07-10. Two deferred features need the same machinery — build it once:

- **Deal-structuring flag layer** (CLAUDE.md build-order item 4): populate the
  existing `deal_structuring` table (`proprietary_funds`, `revenue_sharing`,
  `affiliated_gp_lp`) from Form ADV **Part 2A** firm brochures.
- **Advisor bios (2c)**: "Educational Background and Business Experience" from
  **Part 2B** supplements. Strictly phase 2 — see below.

## What this session already established (de-risks the pipeline)

- `api.adviserinfo.sec.gov/search/firm/{crd}` returns each firm's brochure list
  (`brochures.brochuredetails[]` with `brochureVersionID`, `brochureName`,
  `dateSubmitted`) — public, CORS `*`, no key.
- Brochure PDFs download from
  `files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID={id}`
  (verified: returns `application/pdf`).
- `dateSubmitted` + `brochureVersionID` give a natural **incremental key**:
  monthly refresh only re-fetches changed brochures, not all ~17K.

## Phase 1 — Part 2A deal-structuring flags (P0)

1. **Enumerate**: walk CRDs from the firms table, hit the API, store the
   brochure inventory (new `brochures` table: crd, version_id, name,
   date_submitted, fetched_at). Polite crawl — ~17K requests, throttle ~2/s,
   resumable, cache responses.
2. **Fetch**: download PDFs to a local/CI cache dir (not the repo). Est.
   17K × ~0.5–2MB ≈ 10–30GB worst case; fetch lazily per phase-1 needs, keep
   only extracted text long-term if storage matters.
3. **Extract text**: `pypdf`/`pdfminer.six`; most Part 2A brochures are digital
   text. OCR fallback (tesseract) only if sampling shows scanned PDFs matter —
   measure first, don't build it speculatively.
4. **Flag extraction**: start with *explainable* section-anchored heuristics,
   consistent with the app's methodology-as-code positioning:
   - Part 2A Item 10 (Other Financial Industry Activities and Affiliations) →
     `affiliated_gp_lp`
   - Item 11 (Code of Ethics, Participation in Client Transactions) →
     `proprietary_funds`
   - Item 14 (Client Referrals and Other Compensation) → `revenue_sharing`
   Keyword/pattern rules per section, each flag recording the matched snippet
   (`source_document` column already exists) so every flag is auditable in the
   UI. An LLM-extraction pass is a possible accuracy upgrade later, but it
   trades away the "methodology is code you can read" edge — decide separately.
5. **Validate**: hand-label a ~100-firm sample (mix of fund sponsors and plain
   RIAs), report precision/recall per flag before surfacing anything. Ship the
   flags to the detail view (and optionally as a risk-signal option) only after
   the numbers are known.

## Phase 2 — Part 2B advisor bios (P1, separate go/no-go)

Harder for structural reasons: one supplement per supervised person, frequently
bundled unpredictably into the same PDF as Part 2A or filed separately; the
`advisors` table isn't populated yet (needs the IAPD individual feed first);
name-matching supervised persons to advisor CRDs is fuzzy. Do not start until
phase 1's extraction accuracy is proven and the advisors table exists.

## Open questions

- Where does the crawl run — locally on demand, or a scheduled GitHub Action
  with the PDF cache in artifacts/R2? (Monthly cadence matches the data.)
- Storage budget for cached PDFs vs. text-only retention.
- Does the deal-structuring layer feed the risk signals (as an optional
  configurable signal) or stay display-only in v1? Recommend display-only
  first — signals should wait for the precision numbers.
