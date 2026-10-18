import { useEffect, useState } from 'react'

import { loadIndex, loadShard } from './shards.js'

// Advisor bios scanned from Form ADV Part 2B "brochure supplement" filings
// (etl/advisor_bios.py). A firm page loads its own firm's shard; the firm
// list loads only a count per firm (see scripts/shard-data.mjs). Not part of
// firms.json: the brochure corpus that produces it lives only on a
// workstation, see docs/pdf-pipeline-scope.md.

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
    loadShard('advisor_bios', crd).then((data) => {
      if (alive) setBios(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return bios
}

// Bios on file per firm, { firms: { crd: count } }: undefined while loading,
// null if unavailable. For the firm list's filter, column and sort. `enabled`
// false skips the download on pages that don't show the list.
export function useAdvisorBioCounts(enabled = true) {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    loadIndex('advisor_bios_index').then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return data
}

export const bioCount = (data, crd) => data?.firms?.[String(crd)] ?? 0
