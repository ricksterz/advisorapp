import { useEffect, useState } from 'react'

import { BASE } from './router.js'
import { loadShard } from './shards.js'
import { firmSegment } from './segments.js'

// AUM and headcount growth over the last 3, 5 and 10 years (etl/adviser_history.py,
// growth_table). Each firm: { a5: AUM multiple, e5: employee multiple,
// r5: percentile rank among firms with the same business model that started
// above rank_floor, jump: year of a one-year AUM step of 2x or more }, keys
// left out when they don't apply.
let promise = null
function fetchGrowth() {
  promise ??= fetch(`${BASE}firm_growth.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return promise
}

/** The whole file, for the leaderboard. undefined while loading, null if unavailable. */
export function useGrowthData() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchGrowth().then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}

/** One firm's slice, for its page: { entry, medians, endYear, rankFloor } or null. */
export function useFirmGrowth(crd) {
  const [view, setView] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('firm_growth', crd).then((d) => {
      if (!alive) return
      const entry = d?.firms?.[String(crd)]
      setView(entry ? { entry, medians: d.segment_medians, endYear: d.end_year, rankFloor: d.rank_floor } : null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return view
}

/** Annual growth rate from a multiple over `years`. */
export const annualized = (multiple, years) => multiple ** (1 / years) - 1

export const SIZE_FILTERS = [
  { id: 'all', label: 'Any size today', min: 0 },
  { id: '1b', label: '$1B+ today', min: 1e9 },
  { id: '10b', label: '$10B+ today', min: 1e10 },
]

/**
 * Ranked rows for the leaderboard: firms with a rank for the period (so they
 * started above the floor), filtered by business model and today's size,
 * optionally without firms whose growth came in a single step.
 */
export function leaders(growth, firms, { period, segment, size = 'all', steadyOnly = false, limit = 50 }) {
  if (!growth?.firms || !firms?.length) return []
  const min = SIZE_FILTERS.find((s) => s.id === size)?.min ?? 0
  const start = growth.end_year - period
  const rows = []
  for (const f of firms) {
    const g = growth.firms[String(f.crd)]
    if (!g || g[`r${period}`] == null) continue
    const seg = firmSegment(f)
    if (segment && seg !== segment) continue
    if ((f.aum_total ?? 0) < min) continue
    if (steadyOnly && g.jump != null && g.jump > start) continue
    rows.push({
      firm: f,
      segment: seg,
      aum: g[`a${period}`],
      employees: g[`e${period}`] ?? null,
      rank: g[`r${period}`],
      jump: g.jump != null && g.jump > start ? g.jump : null,
    })
  }
  rows.sort((a, b) => b.aum - a.aum)
  return rows.slice(0, limit)
}
