import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Form D exempt-offering aggregates (etl/form_d.py + etl/form_d_stats.py).
// Aggregate only — no per-firm variant: Form D "recipients" are placement
// agents, overwhelmingly broker-dealers rather than the RIAs this site
// covers (a real-data check matched only 137 of ~17K tracked advisers), so a
// per-firm card would be empty for essentially every firm. Same
// fetch-once-and-share pattern as pulse_stats.json / private_funds.json.
let statsPromise = null
function fetchStats() {
  statsPromise ??= fetch(`${BASE}form_d.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return statsPromise
}

export function useFormDStats() {
  const [stats, setStats] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchStats().then((d) => {
      if (alive) setStats(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [])
  return stats
}

// Form D quarters are already labelled "2026Q2" in the source data, unlike
// the ADV pipelines' quarter-end dates that fmtQuarter() parses.
export const fmtFormDQuarter = (q) => (q ? q.replace(/^(\d{4})Q([1-4])$/, 'Q$2 $1') : '')
