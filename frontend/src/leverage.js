import { firmSegment, SEGMENTS } from './segments.js'

// Operational leverage: how much AUM, and how many accounts, each
// non-advisory employee supports. Non-advisory staff is Item 5.A (all
// employees) minus Item 5.B(1) (employees doing advisory work): operations,
// compliance, client service and support.
//
// Peers are firms in the same segment and AUM band. Comparisons use medians
// and percentiles, never averages: a handful of giants pull the mean for
// institutional managers to nearly four times the median.
//
// The trend line is a log-log fit of non-advisory staff on AUM across each
// segment. AUM per employee rises with size, so a firm is judged against
// what's typical at its own size rather than against a band average that
// always flatters the top of the band. It compares firms at one moment; it
// is not a record of how any firm actually grew.

export function nonAdvisoryStaff(firm) {
  const total = firm.employees_total
  const advisory = firm.employees_advisory
  if (total == null || advisory == null || advisory > total) return null
  return total - advisory
}

export const LEVERAGE_BANDS = [
  { label: 'under $250M', max: 2.5e8 },
  { label: '$250M–$1B', max: 1e9 },
  { label: '$1B–$5B', max: 5e9 },
  { label: '$5B–$25B', max: 2.5e10 },
  { label: '$25B+', max: Infinity },
]

export const bandLabelOf = (aum) => LEVERAGE_BANDS.find((b) => aum < b.max).label

// Below this many peers a band's percentiles are noise; compare with the whole segment.
export const MIN_PEERS = 30

export function quantile(sorted, q) {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Share of values below v, counting ties as half. */
export function percentileRank(sorted, v) {
  let below = 0
  let equal = 0
  for (const x of sorted) {
    if (x < v) below += 1
    else if (x === v) equal += 1
  }
  return sorted.length ? (below + equal / 2) / sorted.length : null
}

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    sorted,
    n: sorted.length,
    p5: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
  }
}

/** Least squares on ln(staff) = intercept + slope * ln(aum). */
export function fitLogLog(points) {
  const n = points.length
  if (n < 3) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const [aum, staff] of points) {
    const x = Math.log(aum)
    const y = Math.log(staff)
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  return {
    n,
    slope,
    intercept,
    // Doubling AUM multiplies expected staff by 2^slope.
    doubling: 2 ** slope - 1,
    expectedStaff: (aum) => Math.exp(intercept + slope * Math.log(aum)),
  }
}

const indexCache = new WeakMap()

/** Per-segment fit, zero-staff counts and peer distributions, built once per firm list. */
export function leverageIndex(firms) {
  const cached = indexCache.get(firms)
  if (cached) return cached
  const segments = {}
  for (const s of SEGMENTS) {
    segments[s.id] = { firms: 0, zeroStaff: 0, points: [], bands: {} }
  }
  for (const f of firms) {
    const seg = firmSegment(f)
    const staff = nonAdvisoryStaff(f)
    if (!seg || staff == null || !(f.aum_total > 0)) continue
    const entry = segments[seg]
    entry.firms += 1
    if (staff === 0) {
      entry.zeroStaff += 1
      continue
    }
    entry.points.push([f.aum_total, staff, f.accounts_total])
    ;(entry.bands[bandLabelOf(f.aum_total)] ??= []).push([f.aum_total, staff, f.accounts_total])
  }
  const summarize = (points) => ({
    n: points.length,
    aumPer: distribution(points.map(([aum, staff]) => aum / staff)),
    accountsPer: distribution(points.filter(([, , acc]) => acc > 0).map(([, staff, acc]) => acc / staff)),
  })
  for (const entry of Object.values(segments)) {
    entry.fit = fitLogLog(entry.points)
    entry.all = summarize(entry.points)
    entry.bandStats = Object.fromEntries(
      Object.entries(entry.bands).map(([label, pts]) => [label, summarize(pts)]),
    )
  }
  const index = { segments }
  indexCache.set(firms, index)
  return index
}

/**
 * Where one firm stands, or null when it can't be placed (no segment, no
 * headcount, no AUM). `noSupportStaff` marks firms whose every employee is
 * advisory; they can't be put on a per-employee scale and are left out of
 * the distributions rather than dropped silently.
 */
export function leverageProfile(firm, firms) {
  const segment = firmSegment(firm)
  const staff = nonAdvisoryStaff(firm)
  if (!segment || staff == null || !(firm.aum_total > 0) || !firms?.length) return null
  const entry = leverageIndex(firms).segments[segment]
  const band = bandLabelOf(firm.aum_total)
  const base = { segment, band, staff, segmentFirms: entry.firms, zeroStaffInSegment: entry.zeroStaff }
  if (staff === 0) return { ...base, noSupportStaff: true }

  const bandStats = entry.bandStats[band]
  const useBand = bandStats && bandStats.n >= MIN_PEERS
  const peers = useBand ? bandStats : entry.all
  const aumPer = firm.aum_total / staff
  const accountsPer = firm.accounts_total > 0 ? firm.accounts_total / staff : null
  const expected = entry.fit?.expectedStaff(firm.aum_total)
  return {
    ...base,
    peerBand: useBand ? band : null,
    peerCount: peers.n,
    aumPer: { value: aumPer, ...peers.aumPer, rank: percentileRank(peers.aumPer.sorted, aumPer) },
    accountsPer:
      accountsPer != null && peers.accountsPer.n >= MIN_PEERS
        ? { value: accountsPer, ...peers.accountsPer, rank: percentileRank(peers.accountsPer.sorted, accountsPer) }
        : null,
    trend: entry.fit
      ? { expected, vsExpected: staff / expected - 1, doubling: entry.fit.doubling, fitted: entry.fit.n }
      : null,
  }
}

/** One plain-English sentence for the top of a firm page. */
export function leverageHeadline(profile, aumTotal, fmtUsd) {
  const seg = SEGMENTS.find((s) => s.id === profile.segment)
  const lead =
    profile.segment === 'mixed'
      ? `A firm with a mixed client base and ${fmtUsd(aumTotal)} in AUM`
      : `A ${seg.label.toLowerCase()} with ${fmtUsd(aumTotal)} in AUM`
  if (profile.noSupportStaff) {
    return `${lead}. Every employee does advisory work; it reports no separate operations or support staff.`
  }
  const who =
    profile.staff === 1
      ? 'its one non-advisory employee supports'
      : `each of its ${profile.staff.toLocaleString()} non-advisory employees supports`
  const peers = profile.peerBand ? `${seg.plural} with ${profile.peerBand}` : `all ${seg.plural}`
  const { value, median } = profile.aumPer
  const position =
    Math.abs(value / median - 1) < 0.05 ? 'close to' : value > median ? 'above' : 'below'
  const compare = `${position} the ${fmtUsd(median)} median for ${peers}`
  return `${lead}: ${who} ${fmtUsd(value)}, ${compare}.`
}

// Chart bins: half-decades of AUM ($10M, $31.6M, $100M...), each drawn at its
// geometric midpoint with the median non-advisory headcount of its firms.
export const MIN_BIN_FIRMS = 15

/** Per segment: [{ aum, staff, n }] for bins with enough firms, smallest first. */
export function scalingCurves(firms) {
  const { segments } = leverageIndex(firms)
  const curves = {}
  for (const [id, entry] of Object.entries(segments)) {
    const bins = new Map()
    for (const [aum, staff] of entry.points) {
      const k = Math.floor(Math.log10(aum) * 2)
      if (!bins.has(k)) bins.set(k, [])
      bins.get(k).push(staff)
    }
    curves[id] = [...bins.entries()]
      .filter(([, staff]) => staff.length >= MIN_BIN_FIRMS)
      .sort(([a], [b]) => a - b)
      .map(([k, staff]) => ({
        aum: 10 ** ((k + 0.5) / 2),
        staff: distribution(staff).median,
        n: staff.length,
      }))
  }
  return curves
}
