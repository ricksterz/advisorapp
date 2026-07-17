// Aggregate view of deal-structuring flag rates by firm scale — a live
// computation over the already-exported static data (firms.json +
// deal_flags.json), not a change to how firms are ranked, scored, or
// filtered anywhere else. Purely additive/display logic.
//
// Bands: the app's canonical AUM banding (benchmarking/cohort.js's
// aumBandOf) only has three buckets — $10B+, $1B–$10B, under $1B — because
// ranking cohorts assume the $100M eligibility floor already used by the
// default preset (benchmarking/presets.js: top.minAum = 1e8). This view
// looks at the whole scanned universe, including sub-$100M firms, so the
// "under $1B" bucket is split at $100M into its own two bands. That's a
// display-only bucketing local to this file — it reuses the same $1B/$10B
// cut points as aumBandOf but does not import or modify it, since a 4-band
// split isn't a variant cohort.js should grow for ranking purposes.
const BANDS = [
  { id: 'lt100m', label: 'Under $100M', min: 0, max: 1e8 },
  { id: '100m-1b', label: '$100M–$1B', min: 1e8, max: 1e9 },
  { id: '1b-10b', label: '$1B–$10B', min: 1e9, max: 1e10 },
  { id: '10b+', label: '$10B+', min: 1e10, max: Infinity },
]

function bandOf(aum) {
  const v = aum ?? 0
  return BANDS.find((b) => v >= b.min && v < b.max) ?? BANDS[BANDS.length - 1]
}

/**
 * Per-band flag rates, computed only over firms actually present in
 * deal_flags.json (i.e. scanned). A firm absent from that file — never
 * scanned, e.g. no brochure on file — is excluded from both the numerator
 * and denominator for its band; it is never counted as "no flags", which
 * would silently dilute the rates.
 *
 * Returns null when there's nothing usable to show: deal_flags.json hasn't
 * loaded (or is unavailable) yet, the firm list is empty, or none of the
 * given firms overlap the scanned set at all (e.g. the 3-firm dev fixture,
 * whose CRDs are never in the real deal_flags.json). Bands with zero
 * scanned firms are dropped individually for the same reason — an empty or
 * zero-filled bar would read as a real (lack of a) pattern.
 */
export function computeDealPatterns(firms, dealFlagsData, flagDefs) {
  if (!firms?.length || !dealFlagsData?.firms) return null

  const rows = new Map(
    BANDS.map((b) => [
      b.id,
      { id: b.id, label: b.label, scanned: 0, counts: Object.fromEntries(flagDefs.map((d) => [d.id, 0])) },
    ]),
  )

  let totalScanned = 0
  for (const f of firms) {
    const flags = dealFlagsData.firms[String(f.crd)]
    if (!flags) continue // never scanned — excluded, not "no flags"
    const row = rows.get(bandOf(f.aum_total).id)
    row.scanned += 1
    totalScanned += 1
    for (const d of flagDefs) if (flags[d.id]) row.counts[d.id] += 1
  }

  if (totalScanned === 0) return null

  const result = BANDS.map((b) => rows.get(b.id))
    .filter((r) => r.scanned > 0)
    .map((r) => ({
      id: r.id,
      label: r.label,
      scanned: r.scanned,
      flags: flagDefs.map((d) => ({
        id: d.id,
        label: d.label,
        short: d.short,
        count: r.counts[d.id],
        pct: (r.counts[d.id] / r.scanned) * 100,
      })),
    }))

  return result.length ? result : null
}
