import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Private funds (etl/private_funds.py + etl/private_fund_stats.py) — Form
// ADV Schedule D 7.B.1, reconstructed to current-known-state per fund
// (not a quarterly series like pulse_stats.json — see the ETL module's
// docstring). Two files, same fetch-once pattern as pulse_stats.json /
// advisor_bios.json: aggregate stats, and a per-firm fund list lazy-loaded
// by the firm detail view.
let statsPromise = null
function fetchStats() {
  statsPromise ??= fetch(`${BASE}private_funds.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return statsPromise
}

export function usePrivateFundStats() {
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

let firmFundsPromise = null
function fetchFirmFunds() {
  firmFundsPromise ??= fetch(`${BASE}firm_private_funds.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return firmFundsPromise
}

// A single firm's private funds: undefined while loading, null once
// resolved if the firm has none (or the file itself is unavailable).
export function useFirmPrivateFunds(crd) {
  const [funds, setFunds] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchFirmFunds().then((data) => {
      if (alive) setFunds(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return funds
}

export const PROVIDER_ROLE_LABELS = {
  auditor: 'Auditor',
  prime_broker: 'Prime broker',
  custodian: 'Custodian',
  administrator: 'Administrator',
  marketer: 'Marketer',
}
