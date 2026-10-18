import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Long-run firm history (etl/adviser_history.py): AUM and headcount from the
// SEC's January registered-adviser report of each year since 2013. Each firm
// is [aum $M, employees, non-advisory employees, accounts], one value per
// year in `years`, null where the firm wasn't registered or didn't report.
//
// segment_growth holds, per business model, a fit across firms of how their
// own non-advisory staff changed as their AUM changed over span_years:
// ln(staff ratio) = intercept + slope * ln(AUM ratio).
let promise = null
function fetchTrajectory() {
  promise ??= fetch(`${BASE}firm_trajectory.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return promise
}

export function useTrajectoryData() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchTrajectory().then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}

/** A firm's yearly points, oldest first, or null with fewer than two years. */
export function firmTrajectory(data, crd) {
  const entry = data?.firms?.[String(crd)]
  if (!entry) return null
  const [aum, employees, support, accounts] = entry
  const points = data.years
    .map((year, i) => ({
      year,
      aum: aum[i] == null ? null : aum[i] * 1e6,
      employees: employees[i],
      support: support[i],
      accounts: accounts[i],
    }))
    .filter((p) => p.aum != null)
  return points.length >= 2 ? points : null
}

/**
 * How the firm grew between its earliest and latest year with AUM and
 * non-advisory staff both above zero, and what the firm's business model
 * would typically have done with the same AUM growth over the same span.
 * Null when there aren't two such years at least two years apart.
 */
export function growthSummary(points, fit, spanYears) {
  const usable = (points ?? []).filter((p) => p.aum > 0 && p.support > 0)
  if (usable.length < 2) return null
  const first = usable[0]
  const last = usable[usable.length - 1]
  const years = last.year - first.year
  if (years < 2) return null
  const aumMultiple = last.aum / first.aum
  const supportMultiple = last.support / first.support
  let expectedSupport = null
  if (fit && spanYears) {
    // The fit is over spanYears; the intercept (staff change at flat AUM) is
    // scaled to this firm's span, the slope applies to its own AUM change.
    const logRatio = fit.intercept * (years / spanYears) + fit.slope * Math.log(aumMultiple)
    expectedSupport = first.support * Math.exp(logRatio)
  }
  return { first, last, years, aumMultiple, supportMultiple, expectedSupport }
}

/** "3.2×", "+40%", "−25%": multiples read better as percentages below 2. */
export function fmtMultiple(m) {
  if (m >= 2) return `${m >= 10 ? Math.round(m) : m.toFixed(1)}×`
  const pct = Math.round((m - 1) * 100)
  return pct === 0 ? 'unchanged' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`
}
