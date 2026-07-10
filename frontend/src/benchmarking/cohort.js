// Peer cohorting: three dimensions (AUM band, client-mix profile, region),
// independently toggleable and combinable. Percentile factors are ranked
// within a firm's cohort instead of the full universe.
//
// Small-cohort fallback: percentiles over a handful of firms are meaningless,
// so when a firm's full cohort has fewer than `minSize` members, dimensions
// are dropped from the end of DIMENSION_ORDER (region first, then client mix,
// then AUM band) until the pool is big enough — level 0 is the whole universe.

export const MIN_COHORT_SIZE = 10

// Fixed cut points; the lowest band absorbs whatever the eligibility floor is.
export function aumBandOf(f) {
  const v = f.aum_total ?? 0
  if (v >= 1e10) return '$10B+'
  if (v >= 1e9) return '$1B–$10B'
  return 'under $1B'
}

// Dominant client profile from Item 5.D shares. Deliberately a plain
// highest-sum rule over three named groups — explainable, not a clustering model.
const MIX_GROUPS = [
  { id: 'Individual / HNW', fields: ['pct_clients_individuals', 'pct_clients_hnw_individuals'] },
  { id: 'Institutional / pooled', fields: ['pct_clients_pooled_vehicles'] },
  { id: 'Pension / corporate', fields: ['pct_clients_pension_plans', 'pct_clients_corporations'] },
]

export function clientMixOf(f) {
  let best = null
  let bestShare = 0
  let reported = false
  for (const g of MIX_GROUPS) {
    let share = 0
    for (const field of g.fields) {
      if (f[field] != null) reported = true
      share += f[field] ?? 0
    }
    if (share > bestShare) {
      bestShare = share
      best = g.id
    }
  }
  return reported && best ? best : null
}

// Census-style regions; single-state cohorts would over-fragment.
const REGIONS = {
  Northeast: ['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA'],
  Midwest: ['IL', 'IN', 'MI', 'OH', 'WI', 'IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  South: ['DE', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'DC', 'WV', 'AL', 'KY', 'MS', 'TN', 'AR', 'LA', 'OK', 'TX'],
  West: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY', 'AK', 'CA', 'HI', 'OR', 'WA'],
}

const STATE_TO_REGION = Object.fromEntries(
  Object.entries(REGIONS).flatMap(([region, states]) => states.map((s) => [s, region])),
)

export function regionOf(f) {
  const state = (f.state || '').trim().toUpperCase()
  return STATE_TO_REGION[state] ?? null // territories / non-US / missing → no region cohort
}

// Fallback drops from the end: region is the most fragmenting, band the least.
export const DIMENSION_ORDER = [
  { id: 'aumBand', label: 'AUM band', bucket: aumBandOf },
  { id: 'clientMix', label: 'Client mix', bucket: clientMixOf },
  { id: 'region', label: 'Region', bucket: regionOf },
]

const KEY_SEP = ' · '

/**
 * Assign every firm in `universe` to its percentile pool.
 *
 * Returns {
 *   dims,                        // enabled dimensions, canonical order
 *   poolOf(firm) -> {            // memoized per-firm assignment
 *     key,                       // pool id, '' = whole universe
 *     label,                     // human-readable cohort description
 *     level,                     // how many dimensions survived
 *     fellBack,                  // true if level < enabled dimension count
 *   },
 *   members(key) -> firm[],      // pool membership (for percentilers)
 * }
 *
 * A firm whose bucket is unknown for an enabled dimension (e.g. no state in
 * the snapshot) falls back exactly like a too-small cohort would.
 */
export function assignCohorts(universe, enabledIds, minSize = MIN_COHORT_SIZE) {
  const dims = DIMENSION_ORDER.filter((d) => enabledIds.includes(d.id))

  // Bucket values per firm, computed once.
  const buckets = new Map(universe.map((f) => [f, dims.map((d) => d.bucket(f))]))

  // Group membership at every level (level = number of leading dims used).
  // Level 0 is the whole universe under the '' key.
  const levels = []
  for (let level = 0; level <= dims.length; level++) {
    const groups = new Map()
    for (const f of universe) {
      const parts = buckets.get(f).slice(0, level)
      if (parts.some((p) => p == null)) continue
      const key = parts.join(KEY_SEP)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(f)
    }
    levels.push(groups)
  }

  const assignments = new Map()
  const poolOf = (f) => {
    let cached = assignments.get(f)
    if (cached) return cached
    for (let level = dims.length; level >= 0; level--) {
      const parts = buckets.get(f).slice(0, level)
      if (parts.some((p) => p == null)) continue
      const key = parts.join(KEY_SEP)
      if (level > 0 && levels[level].get(key).length < minSize) continue
      cached = {
        key,
        level,
        fellBack: level < dims.length,
        label: level === 0 ? 'all eligible firms' : key,
      }
      assignments.set(f, cached)
      return cached
    }
  }

  return { dims, poolOf, members: (key) => levels[key === '' ? 0 : key.split(KEY_SEP).length].get(key) }
}
