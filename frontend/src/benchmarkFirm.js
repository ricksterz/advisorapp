import { regionOf } from './benchmarking/cohort.js'
import { bandLabelOf } from './leverage.js'
import { ordinal } from './pulse.js'
import { describeRank, metricStats, PEER_METRIC_BY_ID } from './peers.js'
import { firmSegment, SEGMENT_BY_ID } from './segments.js'

// "Benchmark My Firm": one firm against a peer cohort the user shapes —
// same business model, same AUM band, same region, high-net-worth focus —
// on growth, staffing, productivity, client composition and business model.
// Pure functions; the page only renders them.

export const MIN_COHORT = 10
export const HNW_FOCUS = 50 // % of clients who are high-net-worth individuals

export const DEFAULT_COHORT = { segment: true, band: true, region: false, hnw: false }

/** { peers, label, tooSmall, ... } — the firm itself is excluded. */
export function selectCohort(firm, allFirms, opts = DEFAULT_COHORT) {
  const parts = []
  let noun = 'SEC-registered advisers'
  const seg = firmSegment(firm)
  const band = bandLabelOf(firm.aum_total ?? 0)
  const region = regionOf(firm)
  let peers = (allFirms ?? []).filter((f) => f.crd !== firm.crd)
  if (opts.segment && seg) {
    peers = peers.filter((f) => firmSegment(f) === seg)
    noun = SEGMENT_BY_ID[seg].plural
  }
  if (opts.band) {
    peers = peers.filter((f) => bandLabelOf(f.aum_total ?? 0) === band)
    parts.push(`with ${band} in AUM`)
  }
  if (opts.region && region) {
    peers = peers.filter((f) => regionOf(f) === region)
    parts.push(`in the ${region}`)
  }
  if (opts.hnw) {
    peers = peers.filter((f) => (f.pct_clients_hnw_individuals ?? 0) >= HNW_FOCUS)
    parts.push(`with ${HNW_FOCUS}%+ high-net-worth clients`)
  }
  return { peers, label: [noun, ...parts].join(' '), tooSmall: peers.length < MIN_COHORT, region, segment: seg, band }
}

export const SECTIONS = [
  { id: 'scale', label: 'Scale', metrics: ['aum', 'staff', 'aum_per_account'] },
  { id: 'productivity', label: 'Staffing & productivity', metrics: ['aum_per_pro', 'accounts_per_pro', 'support_ratio'] },
  { id: 'clients', label: 'Client composition', metrics: ['wealth_aum', 'hnw_clients', 'aum_per_hnw', 'discretionary'] },
  { id: 'model', label: 'Business model & record', metrics: ['affiliations', 'disclosures'] },
]

export const GROWTH_METRICS = [
  { id: 'g3', label: '3-year AUM change', key: 'a3' },
  { id: 'g5', label: '5-year AUM change', key: 'a5' },
  { id: 'g10', label: '10-year AUM change', key: 'a10' },
  { id: 'e5', label: '5-year headcount change', key: 'e5' },
]

/** Stats for every metric in SECTIONS, plus growth when the growth file is loaded. */
export function benchmark(firm, peers, growth) {
  const sections = SECTIONS.map((s) => ({
    ...s,
    stats: s.metrics.map((id) => metricStats(PEER_METRIC_BY_ID[id], firm, peers)),
  }))
  if (growth?.firms) {
    const val = (key) => (f) => growth.firms[String(f.crd)]?.[key] ?? null
    sections.splice(1, 0, {
      id: 'growth',
      label: 'Growth (assets and staff, not investment returns)',
      stats: GROWTH_METRICS.map((m) => ({
        ...metricStats({ id: m.id, label: m.label, kind: 'multiple', higher: 'neutral', value: val(m.key) }, firm, peers),
      })),
    })
  }
  return sections
}

/**
 * Plain-English takeaways: where the firm sits in the outer quartiles. Neutral
 * wording — a top-quartile staffing ratio is a description, not praise.
 */
export function takeaways(sections) {
  const out = []
  for (const s of sections) {
    for (const m of s.stats) {
      const r = describeRank(m.rank)
      if (!r || m.n < MIN_COHORT) continue
      if (m.rank >= 0.75) out.push({ id: m.id, text: `${m.label}: top quartile (${ordinal(r.pct)} percentile).` })
      else if (m.rank < 0.25) out.push({ id: m.id, text: `${m.label}: bottom quartile (${ordinal(r.pct)} percentile).` })
    }
  }
  return out
}
