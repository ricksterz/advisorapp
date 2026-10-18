import { useEffect, useState } from 'react'

import { loadShard } from './shards.js'

// Per-firm quarterly trajectory (etl/firm_history.py) — the same
// firm_snapshots rows pulse_stats.py already aggregates into industry-wide
// medians, exported unaggregated and keyed by CRD so a firm's own detail
// page can show its AUM/headcount/disciplinary trend rather than only the
// current-quarter snapshot. Loaded from the firm's shard (see shards.js).

// A single firm's series: undefined while loading, null once resolved if the
// firm has no history (never appeared in a published quarter) or the file
// itself is unavailable. { quarters, aum_total, aum_discretionary,
// employees_advisory, disciplinary_flag_count } — all arrays parallel to
// quarters, with null at any index the firm was absent that quarter.
export function useFirmHistory(crd) {
  const [history, setHistory] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('firm_history', crd).then((data) => {
      if (!alive) return
      const entry = data?.firms?.[String(crd)]
      setHistory(entry ? { quarters: data.quarters, ...entry } : null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return history
}
