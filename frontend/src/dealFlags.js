import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Deal-structuring flags scanned from Form ADV Part 2A brochures
// (etl/brochures.py) — a single static file for all firms, fetched once and
// shared across every consumer (firm detail cards, the main table's filters
// and column). Not part of firms.json: the brochure corpus that produces it
// lives only on a workstation, see docs/pdf-pipeline-scope.md.
// `label` is the only display form: it is rendered as-is in the dense table's
// row chips, the by-scale pattern bars, and the firm detail card. There used
// to be a parallel set of invented two-letter codes (PF / RS / GP) for the
// tighter surfaces, but they were unreadable without the footnote glossary —
// nobody outside this app knows "PF" means proprietary funds. Real data made
// the density argument for keeping them weak: 87% of scanned firms carry at
// most one flag, so a row almost never stacks more than one chip. GP / LP
// stays abbreviated on purpose — unlike PF and RS it is standard vocabulary
// that appears in the source filings themselves, and `description` glosses it.
export const DEAL_FLAG_DEFS = [
  {
    id: 'pf',
    label: 'Proprietary funds',
    description: 'brochure language about placing clients in affiliated funds',
    evidenceKey: 'proprietary_funds',
  },
  {
    id: 'rs',
    label: 'Revenue sharing / referrals',
    description: 'brochure language about referral or revenue-sharing compensation',
    evidenceKey: 'revenue_sharing',
  },
  {
    id: 'gp',
    label: 'Affiliated GP / LP',
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
