import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Deal-structuring flags scanned from Form ADV Part 2A brochures
// (etl/brochures.py) — a single static file for all firms, fetched once and
// shared across every consumer (firm detail cards, the main table's filters
// and column). Not part of firms.json: the brochure corpus that produces it
// lives only on a workstation, see docs/pdf-pipeline-scope.md.
export const DEAL_FLAG_DEFS = [
  {
    id: 'pf',
    label: 'Proprietary funds',
    short: 'PF',
    description: 'brochure language about placing clients in affiliated funds',
    evidenceKey: 'proprietary_funds',
  },
  {
    id: 'rs',
    label: 'Revenue sharing / referrals',
    short: 'RS',
    description: 'brochure language about referral or revenue-sharing compensation',
    evidenceKey: 'revenue_sharing',
  },
  {
    id: 'gp',
    label: 'Affiliated GP / LP (General Partner / Limited Partner)',
    short: 'GP',
    description:
      'brochure language about affiliates serving as fund general partners (the entity that manages the fund) or limited partners (passive investors in it)',
    evidenceKey: 'affiliated_gp_lp',
  },
]

let dealFlagsPromise = null
function fetchDealFlags() {
  dealFlagsPromise ??= fetch(`${BASE}deal_flags.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return dealFlagsPromise
}

// A single firm's flags: undefined while loading, null once resolved if the
// firm was never scanned (or the file itself is unavailable, e.g. the dev
// sample fixture).
export function useDealFlags(crd) {
  const [flags, setFlags] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchDealFlags().then((data) => {
      if (alive) setFlags(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return flags
}

// The whole file: undefined while loading, null if unavailable. Used where a
// caller needs to look up many firms at once (the main table's filters).
export function useAllDealFlags() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchDealFlags().then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}
