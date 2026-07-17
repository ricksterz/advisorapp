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
