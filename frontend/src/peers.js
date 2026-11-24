import { staffOf } from './benchmarking/factors.js'
import { bandLabelOf, nonAdvisoryStaff, percentileRank, quantile } from './leverage.js'
import { fmtCompactUsd } from './pulse.js'
import { fmtMultiple } from './trajectory.js'
import { aumShare, firmSegment, hasBrokerDealerTies, SEGMENT_BY_ID } from './segments.js'

// Peer cohorts and the distributions within them, shared by the firm page's
// comparison strip, the intelligence report, Compare and Benchmark My Firm, so
// every surface that says "vs peers" means the same peers.
//
// Peers are firms with the same business model (Form ADV Item 5.D) in the same
// AUM band; when that group is too thin to rank against, the whole band. All
// comparisons use medians and percentiles, never means: a handful of very large
// firms pull every average far from the typical firm.

export const MIN_PEERS = 10

/** { peers, label, band, segment, bySegment } or null when no cohort is big enough. */
export function peerCohort(firm, allFirms, { min = MIN_PEERS, segment: segOverride, band: bandOverride } = {}) {
  if (!firm || !allFirms?.length) return null
  const band = bandOverride === null ? null : (bandOverride ?? bandLabelOf(firm.aum_total ?? 0))
  const inBand = band ? allFirms.filter((f) => bandLabelOf(f.aum_total ?? 0) === band) : allFirms
  const segment = segOverride === null ? null : (segOverride ?? firmSegment(firm))
  const sameSegment = segment ? inBand.filter((f) => firmSegment(f) === segment) : []
  const bySegment = sameSegment.length >= min
  const peers = bySegment ? sameSegment : inBand
  if (peers.length < min) return null
  const who = bySegment ? SEGMENT_BY_ID[segment].plural : 'firms'
  return {
    peers,
    band,
    segment: bySegment ? segment : null,
    bySegment,
    label: band ? `${who} with ${band} in AUM` : `all ${who}`,
  }
}

const ratio = (a, b) => (a != null && b > 0 ? a / b : null)

// higher: what a higher value means for the reader. 'neutral' for anything
// that is a description rather than a judgment — most of them. Only the
// disclosure count is framed, and only as "more to read", never as "worse".
export const PEER_METRICS = [
  { id: 'aum', label: 'Regulatory AUM', kind: 'usd', higher: 'neutral', value: (f) => f.aum_total ?? null },
  { id: 'staff', label: 'Advisory professionals', kind: 'count', higher: 'neutral', value: (f) => staffOf(f) },
  {
    id: 'aum_per_pro',
    label: 'AUM per advisory professional',
    kind: 'usd',
    higher: 'neutral',
    value: (f) => ratio(f.aum_total, staffOf(f)),
  },
  {
    id: 'accounts_per_pro',
    label: 'Accounts per advisory professional',
    kind: 'number',
    higher: 'neutral',
    value: (f) => ratio(f.accounts_total, staffOf(f)),
  },
  {
    id: 'aum_per_account',
    label: 'AUM per account',
    kind: 'usd',
    higher: 'neutral',
    value: (f) => ratio(f.aum_total, f.accounts_total),
  },
  {
    id: 'discretionary',
    label: 'Discretionary share of AUM',
    kind: 'pct',
    higher: 'neutral',
    value: (f) => (f.aum_total > 0 ? Math.max(0, Math.min(1, (f.aum_discretionary ?? 0) / f.aum_total)) * 100 : null),
  },
  {
    id: 'hnw_clients',
    label: 'High-net-worth share of clients',
    kind: 'pct',
    higher: 'neutral',
    value: (f) => f.pct_clients_hnw_individuals ?? null,
  },
  { id: 'wealth_aum', label: 'AUM from individuals & HNW', kind: 'pct', higher: 'neutral', value: (f) => aumShare(f, 'wealth') },
  {
    id: 'aum_per_hnw',
    label: 'AUM per high-net-worth client',
    kind: 'usd',
    higher: 'neutral',
    value: (f) => f.aum_per_hnw_client ?? null,
  },
  {
    id: 'support_ratio',
    label: 'Non-advisory share of employees',
    kind: 'pct',
    higher: 'neutral',
    value: (f) => {
      const s = nonAdvisoryStaff(f)
      return s != null && f.employees_total > 0 ? (s / f.employees_total) * 100 : null
    },
  },
  { id: 'affiliations', label: 'Financial-industry affiliations', kind: 'count', higher: 'neutral', value: (f) => f.affil_count ?? null },
  {
    id: 'disclosures',
    label: 'Item 11 disclosures',
    kind: 'count',
    higher: 'more-to-review',
    value: (f) => f.disciplinary_flag_count ?? null,
  },
]

export const PEER_METRIC_BY_ID = Object.fromEntries(PEER_METRICS.map((m) => [m.id, m]))

/**
 * One metric's distribution among peers and the firm's place in it:
 * { id, label, kind, value, n, p25, median, p75, rank } — rank is the share of
 * peers below the firm (0-1), null when the firm didn't report the figure.
 * `extraValue` lets a caller supply a value from another dataset (growth).
 */
export function metricStats(metric, firm, peers, extraValue) {
  const valueOf = extraValue ?? metric.value
  const values = peers.map(valueOf).filter((v) => v != null && Number.isFinite(v))
  const sorted = values.sort((a, b) => a - b)
  const value = valueOf(firm)
  const have = value != null && Number.isFinite(value)
  return {
    id: metric.id,
    label: metric.label,
    kind: metric.kind,
    higher: metric.higher,
    value: have ? value : null,
    n: sorted.length,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    rank: have && sorted.length ? percentileRank(sorted, value) : null,
  }
}

export function peerStats(firm, peers, ids = PEER_METRICS.map((m) => m.id)) {
  return ids.map((id) => metricStats(PEER_METRIC_BY_ID[id], firm, peers))
}

// Yes/no arrangements: how common each is among peers, so "charges
// performance fees" can be read against "as do 41% of comparable firms".
export const PREVALENCE = [
  { id: 'fee_pct_of_aum', label: 'Percentage-of-AUM fees', test: (f) => f.fee_pct_of_aum === true },
  { id: 'fee_performance_based', label: 'Performance-based fees', test: (f) => f.fee_performance_based === true },
  { id: 'fee_commissions', label: 'Commissions', test: (f) => f.fee_commissions === true },
  { id: 'broker_dealer', label: 'Broker-dealer ties', test: hasBrokerDealerTies },
  { id: 'affiliated', label: 'Any financial-industry affiliation', test: (f) => (f.affil_count ?? 0) > 0 },
  { id: 'disclosure', label: 'Any Item 11 disclosure', test: (f) => (f.disciplinary_flag_count ?? 0) > 0 },
]

/** [{ id, label, firm: boolean, share: 0-1 }] among peers. */
export function prevalence(firm, peers) {
  return PREVALENCE.map((p) => ({
    id: p.id,
    label: p.label,
    firm: p.test(firm),
    share: peers.length ? peers.filter(p.test).length / peers.length : null,
  }))
}

/** Plain-English position: "above the median (72nd percentile)". */
export function describeRank(rank) {
  if (rank == null) return null
  const pct = Math.max(1, Math.min(99, Math.round(rank * 100)))
  const where = rank >= 0.75 ? 'top quartile' : rank >= 0.5 ? 'above the median' : rank >= 0.25 ? 'below the median' : 'bottom quartile'
  return { pct, where }
}

/** Format a metric value for display; '—' never stands in for zero. */
export function fmtMetric(kind, v) {
  if (v == null || !Number.isFinite(v)) return 'Not reported'
  if (kind === 'usd') return fmtCompactUsd(v)
  if (kind === 'pct') return `${Math.round(v)}%`
  if (kind === 'count') return Math.round(v).toLocaleString()
  if (kind === 'multiple') return fmtMultiple(v)
  return v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)
}
