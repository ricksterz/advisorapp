import { useEffect, useState } from 'react'

import { loadShard } from './shards.js'

// Form 13F holdings (etl/form_13f.py): each registered firm's US-listed
// stock, ETF, option and convertible positions at quarter end, from SEC's
// 13F data sets, loaded from the firm's shard (see shards.js).
//
// A firm either files its own 13F or is named as an "included manager" in a
// parent's combined report (BLACKROCK FUND ADVISORS inside BlackRock, Inc.'s).
// The second case shows the parent's filing, labelled as the parent's.

/**
 * What a firm page shows, or null when the firm has no 13F coverage.
 * Pure, so the own / parent / unreliable-values cases are testable.
 */
export function holdingsView(data, crd) {
  const entry = data?.firms?.[String(crd)]
  const filer = entry && data.filers?.[entry.cik]
  if (!filer) return null
  return {
    period: data.period,
    own: entry.own,
    filer,
    filingUrl: edgarFilingUrl(filer.cik, filer.accession),
  }
}

export function edgarFilingUrl(cik, accession) {
  if (!cik || !accession) return null
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`
}

// undefined while loading, null when the firm has no 13F (or the file is unavailable).
export function useForm13f(crd) {
  const [view, setView] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('form_13f', crd).then((data) => {
      if (alive) setView(holdingsView(data, crd))
    })
    return () => {
      alive = false
    }
  }, [crd])
  return view
}
