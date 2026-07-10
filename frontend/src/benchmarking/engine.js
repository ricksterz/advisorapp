// Pure, config-driven ranking engine. No UI code — independently testable.
// computeRankings(firms, config) keeps the output shape the old in-App
// function had ({ top, atRisk }), with cohort info added per top entry.

import { FACTORS, staffOf } from './factors.js'
import { RISK_PARAM_DEFAULTS, RISK_SIGNALS, TOP_SCREENS } from './screens.js'
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

export function computeRankings(firms, config) {
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
  const ctx = { pLoad }

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
    .sort(bySpecificityThenAum)
    .slice(0, TOP_N)

  return { top, atRisk }
}
