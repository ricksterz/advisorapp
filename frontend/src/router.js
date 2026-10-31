// Minimal history-API router. Firm profiles live at real paths
// (BASE_URL + 'firm/:crd') so crawlers can index them — hash routes never
// appear in search results. Legacy '#/firm/:crd' links redirect permanently.
//
// Both static hosts serve index.html for unknown paths: Cloudflare via
// wrangler's single-page-application handling, GitHub Pages via the 404.html
// copy made in the deploy workflow.

import { useEffect, useState } from 'react'

export const BASE = import.meta.env.BASE_URL

export const firmPath = (crd) => `${BASE}firm/${crd}`

// onClick handler for internal <a> links: SPA navigation on plain left
// clicks, browser-default behavior for modified clicks and middle clicks.
export function navigate(e, path) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  e.preventDefault()
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export const pulsePath = (section = '') => `${BASE}pulse${section ? `/${section}` : ''}`

export const legalPath = () => `${BASE}legal`

// Up to this many firms side by side; more columns stop fitting a laptop.
export const MAX_COMPARE = 4

export const comparePath = (crds = []) =>
  `${BASE}compare${crds.length ? `?firms=${crds.join(',')}` : ''}`

/** CRDs from a ?firms= value: digits only, de-duplicated, at most MAX_COMPARE. */
export function parseCompareFirms(search) {
  const raw = new URLSearchParams(search).get('firms') ?? ''
  const out = []
  for (const part of raw.split(',')) {
    if (/^\d{1,9}$/.test(part.trim())) {
      const crd = Number(part.trim())
      if (!out.includes(crd)) out.push(crd)
    }
  }
  return out.slice(0, MAX_COMPARE)
}

// Route shape: { firmCrd: number|null, pulse: string|null, compare:
// number[]|null } — pulse is '' for /pulse itself, or the drill-down segment
// ('advisers', 'assets', ...); compare is the CRDs on /compare; legal is true
// on /legal, the disclaimer and terms of use.
function parseRoute() {
  const legacy = window.location.hash.match(/^#\/firm\/(\d+)/)
  if (legacy) {
    window.history.replaceState(null, '', firmPath(legacy[1]) + window.location.search)
    return { firmCrd: Number(legacy[1]), pulse: null, compare: null, legal: false }
  }
  const path = window.location.pathname
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '')
  const firm = rel.match(/^firm\/(\d+)/)
  if (firm) return { firmCrd: Number(firm[1]), pulse: null, compare: null, legal: false }
  const pulse = rel.match(/^pulse(?:\/([a-z-]+))?\/?$/)
  if (pulse) return { firmCrd: null, pulse: pulse[1] ?? '', compare: null, legal: false }
  if (/^compare\/?$/.test(rel)) {
    return { firmCrd: null, pulse: null, compare: parseCompareFirms(window.location.search), legal: false }
  }
  if (/^legal\/?$/.test(rel)) return { firmCrd: null, pulse: null, compare: null, legal: true }
  return { firmCrd: null, pulse: null, compare: null, legal: false }
}

export function useRoute() {
  const [route, setRoute] = useState(parseRoute)
  useEffect(() => {
    const onChange = () => setRoute(parseRoute())
    window.addEventListener('popstate', onChange)
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('hashchange', onChange)
    }
  }, [])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route.firmCrd, route.pulse, route.compare == null, route.legal])
  return route
}

// Back-compat alias for existing callers that only care about the firm route.
export function useFirmRoute() {
  return useRoute().firmCrd
}
