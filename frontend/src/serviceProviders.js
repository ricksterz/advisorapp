import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Service-provider league tables (etl/provider_stats.py) — Form ADV
// Schedule D 7.B.1's named auditors, custodians, prime brokers,
// administrators and marketers, ranked by how many distinct advisers use
// each. Same fetch-once-and-share pattern as pulse_stats.json.
//
// This supersedes the smaller league table private_funds.json used to carry:
// that one ranked by fund count under a looser name key that split the same
// firm across spellings, so the two would have disagreed about how many funds
// Ernst & Young audits.
let statsPromise = null
function fetchStats() {
  statsPromise ??= fetch(`${BASE}service_providers.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return statsPromise
}

export function useServiceProviders() {
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
