import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Which icon proxy has a real logo for each firm's website (etl/favicons.py).
//
// Both proxies answer a missing icon with a placeholder sent as an HTTP 404
// with a valid image body — DuckDuckGo a gray arrow, Google a gray globe. The
// browser renders that body and never fires onerror, so T. ROWE PRICE showed
// DuckDuckGo's arrow instead of its logo. The status is only visible
// server-side, so each host is checked at refresh time and this file lists the
// exceptions: hosts that need Google, and hosts with no icon anywhere.
export const DUCKDUCKGO = (host) => `https://icons.duckduckgo.com/ip3/${host}.ico`
export const GOOGLE = (host) => `https://www.google.com/s2/favicons?domain=${host}&sz=64`

let faviconsPromise = null
function fetchFavicons() {
  faviconsPromise ??= fetch(`${BASE}favicons.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d ? { google: new Set(d.google ?? []), none: new Set(d.none ?? []) } : null))
    .catch(() => null)
  return faviconsPromise
}

// undefined while loading, null when unavailable (the dev fixture has no file).
export function useFavicons() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchFavicons().then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}

/**
 * The icon URL to show for a website host, or null for no icon.
 *
 * Renders nothing while the list is loading, so a placeholder never flashes
 * before being swapped out. Without the list at all (dev fixture, failed
 * fetch) it falls back to DuckDuckGo, the previous behavior. A host the list
 * doesn't mention was never checked — its site first appeared after the last
 * refresh — and also gets DuckDuckGo, the source that covers most firms.
 */
export function faviconUrl(favicons, host) {
  if (!host || favicons === undefined) return null
  if (favicons === null) return DUCKDUCKGO(host)
  if (favicons.none.has(host)) return null
  if (favicons.google.has(host)) return GOOGLE(host)
  return DUCKDUCKGO(host)
}
