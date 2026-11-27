import { useEffect } from 'react'

// Product analytics: named Google Analytics 4 events for the actions that
// show whether a visitor got value beyond the page they landed on —
// opening a report, following a firm, exporting, comparing, benchmarking.
//
// Privacy rule: send what was done, never what someone typed or owns. No
// notes, no questionnaire answers, no portfolio amounts or fee inputs, no
// search text. Firm CRD numbers are public identifiers and are fine.
//
// gtag only exists in production builds (index.html loads it behind
// import.meta.env.PROD), so local dev and tests send nothing.

const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/

/** Fire one GA4 event. Never throws; a no-op when analytics isn't loaded. */
export function track(name, params = {}) {
  try {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return
    const clean = {}
    for (const [k, v] of Object.entries(params)) {
      if (!PARAM_NAME.test(k) || v == null || v === '') continue
      clean[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 100)
    }
    window.gtag('event', name, clean)
  } catch {
    // Analytics must never break the page.
  }
}

/** Fire once when a component mounts with these values (e.g. a report view). */
export function useTrackView(name, params, enabled = true) {
  const key = JSON.stringify(params)
  useEffect(() => {
    if (enabled) track(name, params)
    // key captures params by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, key, enabled])
}

// "trackFirmCrd" -> "firm_crd"
const snake = (s) => s.replace(/^./, (c) => c.toLowerCase()).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** Params from an element's data-track-* attributes. Pure, for tests. */
export function paramsFromDataset(dataset) {
  const out = {}
  for (const [k, v] of Object.entries(dataset)) {
    if (k.startsWith('track') && k !== 'track') out[snake(k.slice(5))] = v
  }
  return out
}

let installed = false

/**
 * One document-level listener: any click inside an element carrying
 * data-track="event_name" fires that event, with data-track-* attributes as
 * parameters. Keeps tracking out of every onClick handler.
 */
export function installClickTracking() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target?.closest?.('[data-track]')
      if (el) track(el.dataset.track, paramsFromDataset(el.dataset))
    },
    { capture: true },
  )
}

// ---------------------------------------------------------------------------
// Keeping the owner's own visits (and automated browsers) out of the numbers.
//
// `?internal=1` on any URL marks this browser as internal: the flag is kept
// in localStorage, the parameter is stripped from the address bar at once,
// and GA is configured with traffic_type=internal so the property's
// "Internal Traffic" data filter drops those hits. `?internal=0` clears it.
// Works on any network (home, mobile, hotel, VPN) and stores no IP address.
//
// Automated browsers (Playwright, Puppeteer, Selenium, an agent driving a
// browser pane) report navigator.webdriver === true; analytics isn't loaded
// for them at all.

export const INTERNAL_KEY = 'od.internal'
const INTERNAL_PARAM = 'internal'

/** true / false for ?internal=1 / ?internal=0, null when absent or unrecognised. */
export function internalParam(search) {
  const v = new URLSearchParams(search).get(INTERNAL_PARAM)
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return null
}

/** The URL with the internal parameter removed, others kept in order. */
export function stripInternalParam(href) {
  const url = new URL(href)
  if (!url.searchParams.has(INTERNAL_PARAM)) return href
  url.searchParams.delete(INTERNAL_PARAM)
  return url.pathname + url.search + url.hash
}

/** True for WebDriver-controlled browsers. */
export function isAutomated(nav) {
  try {
    return nav?.webdriver === true
  } catch {
    return false
  }
}

/**
 * Apply ?internal=, strip it from the address bar, and return whether this
 * browser is internal. Never throws: storage can be blocked (private mode),
 * in which case the parameter still counts for this page view.
 */
export function resolveInternal(win = window) {
  let stored = false
  try {
    stored = win.localStorage.getItem(INTERNAL_KEY) === '1'
  } catch {
    // storage unavailable
  }
  let param = null
  try {
    param = internalParam(win.location.search)
    if (param !== null) {
      try {
        if (param) win.localStorage.setItem(INTERNAL_KEY, '1')
        else win.localStorage.removeItem(INTERNAL_KEY)
      } catch {
        // storage unavailable
      }
      win.history.replaceState(win.history.state, '', stripInternalParam(win.location.href))
    }
  } catch {
    // malformed URL or history unavailable
  }
  return param ?? stored
}
