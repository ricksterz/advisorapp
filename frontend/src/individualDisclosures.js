import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Individual-level disclosure category breakdown (etl/individual_disclosures.py
// + etl/individual_disclosures_stats.py) — industry-wide only, no per-firm
// variant: the bulk feed's individual roster is independent of this site's
// (much smaller) advisor-bios roster, so there's no firm to attach counts to
// beyond what the per-advisor badge on FirmDetail already shows. Same
// fetch-once pattern as pulse_stats.json / private_funds.json.
let statsPromise = null
function fetchStats() {
  statsPromise ??= fetch(`${BASE}individual_disclosures.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return statsPromise
}

export function useIndividualDisclosureStats() {
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
