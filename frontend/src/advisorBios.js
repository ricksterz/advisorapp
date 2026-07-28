import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Advisor bios scanned from Form ADV Part 2B "brochure supplement" filings
// (etl/advisor_bios.py) — a single static file for all firms, fetched once
// and shared across every consumer, same pattern as deal_flags.json /
// dealFlags.js. Not part of firms.json: the brochure corpus that produces it
// lives only on a workstation, see docs/pdf-pipeline-scope.md.
let advisorBiosPromise = null
function fetchAdvisorBios() {
  advisorBiosPromise ??= fetch(`${BASE}advisor_bios.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return advisorBiosPromise
}

// Disclosure category flags (etl/individual_disclosures.py), keyed the same
// as each bio's optional `disclosures.flags` object. The bulk feed reports
// only these nine Y/N booleans per person — no narrative, date, or dollar
// detail — so labels stay short; real detail lives behind `iapd_link`.
export const DISCLOSURE_FLAG_DEFS = [
  { key: 'has_customer_complaint', label: 'Customer complaint' },
  { key: 'has_reg_action', label: 'Regulatory action' },
  { key: 'has_criminal', label: 'Criminal' },
  { key: 'has_civil_judicial', label: 'Civil judicial' },
  { key: 'has_investigation', label: 'Investigation' },
  { key: 'has_termination', label: 'Termination' },
  { key: 'has_judgment', label: 'Judgment' },
  { key: 'has_bond', label: 'Bond' },
  { key: 'has_bankruptcy', label: 'Bankruptcy' },
]

// A single firm's advisor bios: undefined while loading, null once resolved
// if the firm has none (or the file itself is unavailable, e.g. the dev
// sample fixture) — callers should treat both the same way (hide the card).
export function useAdvisorBios(crd) {
  const [bios, setBios] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchAdvisorBios().then((data) => {
      if (alive) setBios(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return bios
}

// The whole file: undefined while loading, null if unavailable. Used where a
// caller needs to look up many firms at once (the main table's filter/column).
export function useAllAdvisorBios() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchAdvisorBios().then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}
