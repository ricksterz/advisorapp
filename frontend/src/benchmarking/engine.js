// Pure, config-driven ranking engine. No UI code — independently testable.
// computeRankings(firms, config) keeps the output shape the old in-App
// function had ({ top, atRisk }), with cohort info added per top entry.

import { FACTORS, staffOf } from './factors.js'
import {
  RISK_PARAM_DEFAULTS,
  RISK_SIGNALS,
  RISK_SIZE_BANDS,
  TOP_SCREENS,
  advisorCountsOf,
  riskSizeBand,
} from './screens.js'
import { MIN_COHORT_SIZE, assignCohorts } from './cohort.js'

export const TOP_N = 10

// Rank-based percentile function over a numeric sample.
export function percentiler(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  return (v) => {
    if (!Number.isFinite(v) || s.length < 2) return 0
    let lo = 0
    let hi = s.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (s[mid] <= v) lo = mid + 1
      else hi = mid
    }
    return lo / s.length
  }
}

// Share of the *other* firms in the sample strictly below v, for a v that is
// itself in the sample: ties don't count as beaten, so a value most of the
// sample shares (zero disclosures) scores low, and the single highest value
// scores 1.
export function shareBelow(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  return (v) => {
    if (!Number.isFinite(v) || s.length < 2) return 0
    let lo = 0
    let hi = s.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (s[mid] < v) lo = mid + 1
      else hi = mid
    }
    return Math.min(1, lo / (s.length - 1))
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))

// Weights are normalized to sum to 1 at compute time, so removing a factor
// redistributes its share instead of leaving a dead constant in every score
// (the old flat "+0.2 clean record" bug).
export function normalizedWeights(weights) {
  const active = FACTORS.filter((f) => (weights[f.id] ?? 0) > 0)
  const sum = active.reduce((s, f) => s + weights[f.id], 0)
  if (!sum) return {}
  return Object.fromEntries(active.map((f) => [f.id, weights[f.id] / sum]))
}

const bySpecificityThenAum = (a, b) =>
  b.score - a.score || (b.firm.aum_total ?? 0) - (a.firm.aum_total ?? 0)

function fallbackNote(pool, dims) {
  if (!pool.fellBack) return null
  if (pool.level === 0) return 'cohort too small — ranked against all eligible firms'
  const used = dims.slice(0, pool.level).map((d) => d.label)
  return `cohort too small — showing ${used.join(' × ')} only`
}

// Risk list: score, then name. Never size: breaking ties by AUM put the
// largest firms first whenever scores bunched up.
const byScoreThenName = (a, b) =>
  b.score - a.score || (a.firm.legal_name ?? '').localeCompare(b.firm.legal_name ?? '')

/**
 * extra.advisorCounts: { crd: [advisors, advisors with disclosures] } from
 * the advisor index. extra.disclosureIndex: { since, firms: { crd: [recent
 * events against the firm, all against the firm, against affiliates] } }.
 * Without them the signals that read them can't trip.
 */
export function computeRankings(firms, config, extra = {}) {
  // --- Top list -----------------------------------------------------------
  // Percentile pools span every firm above the AUM floor (flagged firms
  // included), matching the original behavior; the remaining screens then
  // gate who is actually scored and listed.
  const topUniverse = firms.filter((f) => (f.aum_total ?? 0) >= config.top.minAum)
  const eligible = topUniverse.filter((f) =>
    TOP_SCREENS.every((s) => s.predicate(f, config.top[s.id] ?? s.defaultParam)),
  )

  const enabledDims = Object.keys(config.cohorts).filter((k) => config.cohorts[k])
  const cohorts = assignCohorts(topUniverse, enabledDims, config.minCohort ?? MIN_COHORT_SIZE)

  const weights = normalizedWeights(config.weights)
  const activeFactors = FACTORS.filter((f) => weights[f.id])

  // One percentiler per (pool × percentile factor), built lazily.
  const poolRankers = new Map()
  const rankersFor = (key) => {
    let rankers = poolRankers.get(key)
    if (!rankers) {
      const members = cohorts.members(key)
      rankers = {}
      for (const factor of activeFactors) {
        if (factor.normalize === 'percentile') {
          rankers[factor.id] = percentiler(members.map(factor.accessor))
        }
      }
      poolRankers.set(key, rankers)
    }
    return rankers
  }

  const top = eligible
    .map((f) => {
      const pool = cohorts.poolOf(f)
      const rankers = rankersFor(pool.key)
      let score = 0
      for (const factor of activeFactors) {
        let v =
          factor.normalize === 'percentile'
            ? rankers[factor.id](factor.accessor(f))
            : clamp01(factor.accessor(f) ?? 0)
        if (factor.direction === -1) v = 1 - v
        score += weights[factor.id] * v
      }
      return {
        firm: f,
        score: 100 * score,
        cohort: { label: pool.label, note: fallbackNote(pool, cohorts.dims) },
      }
    })
    .sort(bySpecificityThenAum)
    .slice(0, TOP_N)

  // --- Risk list ------------------------------------------------------------
  const riskUniverse = firms.filter((f) => (f.aum_total ?? 0) >= config.risk.minAum)
  const pLoad = percentiler(
    riskUniverse.map((f) => (staffOf(f) > 0 ? (f.accounts_total ?? NaN) / staffOf(f) : NaN)),
  )
  const params = { ...RISK_PARAM_DEFAULTS, ...config.risk.params }
  const advisorCounts = extra.advisorCounts ?? null
  const rates = advisorCounts
    ? riskUniverse
        .map((f) => advisorCountsOf(f, { advisorCounts }))
        .filter((c) => c && c[0] >= params.minAdvisors)
        .map((c) => c[1] / c[0])
    : []
  const disclosureIndex = extra.disclosureIndex ?? null
  const bandShares = (value) =>
    Array.from({ length: RISK_SIZE_BANDS.length + 1 }, (_, band) =>
      shareBelow(riskUniverse.filter((f) => riskSizeBand(f.aum_total) === band).map(value)),
    )
  const ctx = {
    pLoad,
    advisorCounts,
    disclosureIndex,
    recentShareBelow: disclosureIndex
      ? bandShares((f) => disclosureIndex.firms?.[String(f.crd)]?.[0] ?? 0)
      : null,
    advisorShareBelow: rates.length ? shareBelow(rates) : null,
    disclosureShareBelow: bandShares((f) => f.disciplinary_flag_count ?? 0),
  }

  const atRisk = riskUniverse
    .map((f) => {
      const signals = []
      let score = 0
      for (const signal of RISK_SIGNALS) {
        const points = config.risk.points[signal.id] ?? signal.defaultPoints
        if (points <= 0) continue
        const hit = signal.evaluate(f, points, params, ctx)
        if (hit) {
          score += hit.points
          signals.push(hit.label)
        }
      }
      return { firm: f, score, signals }
    })
    .filter((r) => r.score >= config.risk.threshold)
    .sort(byScoreThenName)
    .slice(0, TOP_N)

  return { top, atRisk }
}
