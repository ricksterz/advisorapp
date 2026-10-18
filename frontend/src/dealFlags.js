import { useEffect, useState } from 'react'

import { loadIndex, loadShard } from './shards.js'

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

// A single firm's flags: undefined while loading, null once resolved if the
// firm was never scanned (or the file itself is unavailable, e.g. the dev
// sample fixture).
export function useDealFlags(crd) {
  const [flags, setFlags] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('deal_flags', crd).then((data) => {
      if (alive) setFlags(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return flags
}

// Every scanned firm's flags, without the evidence snippets: undefined while
// loading, null if unavailable. For the firm list's filters, column and deal
// patterns. `enabled` false skips the download on pages that don't need it.
export function useAllDealFlags(enabled = true) {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    loadIndex('deal_flags_index').then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return data
}
