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
  go(path)
}

/** Programmatic SPA navigation. */
export function go(path, { replace = false } = {}) {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export const pulsePath = (section = '') => `${BASE}pulse${section ? `/${section}` : ''}`

export const legalPath = () => `${BASE}legal`

// Firm sub-views live on the firm's own URL as ?view=, so the served HTML —
// and the canonical it carries — is the firm page's: a report is a view of
// the firm, not a second page competing with it in search results.
export const FIRM_VIEWS = ['report', 'diligence']
export const reportPath = (crd) => `${firmPath(crd)}?view=report`
export const diligencePath = (crd) => `${firmPath(crd)}?view=diligence`

export const watchlistPath = () => `${BASE}watchlist`
export const feesPath = () => `${BASE}fees`
export const benchmarkPath = (crd) => `${BASE}benchmark${crd ? `?firm=${crd}` : ''}`

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

// Route shape: { firmCrd, firmView, pulse, compare, legal, page } — firmCrd
// is the CRD on /firm/:crd and firmView its ?view= ('report', 'diligence' or
// null); pulse is '' for /pulse itself, or the drill-down segment
// ('advisers', 'assets', ...); compare is the CRDs on /compare; legal is true
// on /legal; page names the other top-level tools ('watchlist', 'fees',
// 'benchmark').
const EMPTY_ROUTE = { firmCrd: null, firmView: null, pulse: null, compare: null, legal: false, page: null, benchmarkCrd: null }

const digits = (v) => (v && /^\d{1,9}$/.test(v) ? Number(v) : null)

function parseRoute() {
  const legacy = window.location.hash.match(/^#\/firm\/(\d+)/)
  if (legacy) {
    window.history.replaceState(null, '', firmPath(legacy[1]) + window.location.search)
    return { ...EMPTY_ROUTE, firmCrd: Number(legacy[1]) }
  }
  const path = window.location.pathname
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '')
  const params = new URLSearchParams(window.location.search)
  const firm = rel.match(/^firm\/(\d+)/)
  if (firm) {
    const view = params.get('view')
    return { ...EMPTY_ROUTE, firmCrd: Number(firm[1]), firmView: FIRM_VIEWS.includes(view) ? view : null }
  }
  const pulse = rel.match(/^pulse(?:\/([a-z-]+))?\/?$/)
  if (pulse) return { ...EMPTY_ROUTE, pulse: pulse[1] ?? '' }
  if (/^compare\/?$/.test(rel)) return { ...EMPTY_ROUTE, compare: parseCompareFirms(window.location.search) }
  if (/^legal\/?$/.test(rel)) return { ...EMPTY_ROUTE, legal: true }
  if (/^watchlist\/?$/.test(rel)) return { ...EMPTY_ROUTE, page: 'watchlist' }
  if (/^fees\/?$/.test(rel)) return { ...EMPTY_ROUTE, page: 'fees' }
  if (/^benchmark\/?$/.test(rel)) return { ...EMPTY_ROUTE, page: 'benchmark', benchmarkCrd: digits(params.get('firm')) }
  return EMPTY_ROUTE
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
  }, [route.firmCrd, route.firmView, route.pulse, route.compare == null, route.legal, route.page])
  return route
}

// Back-compat alias for existing callers that only care about the firm route.
export function useFirmRoute() {
  return useRoute().firmCrd
}
