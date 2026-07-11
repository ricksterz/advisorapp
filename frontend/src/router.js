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

function parseFirmCrd() {
  const legacy = window.location.hash.match(/^#\/firm\/(\d+)/)
  if (legacy) {
    window.history.replaceState(null, '', firmPath(legacy[1]) + window.location.search)
    return Number(legacy[1])
  }
  const path = window.location.pathname
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '')
  const m = rel.match(/^firm\/(\d+)/)
  return m ? Number(m[1]) : null
}

export function useFirmRoute() {
  const [firmCrd, setFirmCrd] = useState(parseFirmCrd)
  useEffect(() => {
    const onChange = () => setFirmCrd(parseFirmCrd())
    window.addEventListener('popstate', onChange)
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('hashchange', onChange)
    }
  }, [])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [firmCrd])
  return firmCrd
}
