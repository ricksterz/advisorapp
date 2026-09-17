import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Form 13F holdings (etl/form_13f.py): each registered firm's US-listed
// stock, ETF, option and convertible positions at quarter end, from SEC's
// 13F data sets. Only loaded on a firm page — it's several megabytes.
//
// A firm either files its own 13F or is named as an "included manager" in a
// parent's combined report (BLACKROCK FUND ADVISORS inside BlackRock, Inc.'s).
// The second case shows the parent's filing, labelled as the parent's.
let promise = null
function fetch13f() {
  promise ??= fetch(`${BASE}form_13f.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return promise
}

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
    fetch13f().then((data) => {
      if (alive) setView(holdingsView(data, crd))
    })
    return () => {
      alive = false
    }
  }, [crd])
  return view
}
