import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Where a firm's filed website URL actually resolves today
// (etl/website_check.py). Firms file a website once and rarely amend it, so
// the link rots when they rebrand or get acquired — PATHSTONE FAMILY OFFICE
// still files hallcapital.com, which now redirects to pathstone.com.
//
// Only cross-domain redirects that returned 2xx are in this file. Broken
// links are deliberately absent: a timeout is not proof a site is dead, and
// several large firms behind bot protection time out while being perfectly
// reachable in a browser.
let overridesPromise = null
function fetchOverrides() {
  overridesPromise ??= fetch(`${BASE}website_overrides.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return overridesPromise
}

export function useWebsiteOverrides() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchOverrides().then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}

/**
 * The URL to actually link to, plus whether it differs from what was filed.
 *
 * Falls back to the filed URL whenever there is no override — including
 * while the file is still loading — so a link is never missing or broken
 * while waiting on a fetch.
 */
export function resolveWebsite(overrides, crd, filedUrl) {
  const hit = overrides?.firms?.[String(crd)]
  if (!hit?.resolved || !filedUrl) return { url: filedUrl, redirected: false }
  return { url: hit.resolved, redirected: true, filed: filedUrl }
}
