import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Where a firm's filed website URL actually resolves today
// (etl/website_check.py). Firms file a website once and rarely amend it, so
// the link rots when they rebrand or get acquired — PATHSTONE FAMILY OFFICE
// still files hallcapital.com, which now redirects to pathstone.com.
//
// Two kinds of entry. `via: 'redirect'` means the filed URL 2xx-redirects
// somewhere else. `via: 'research'` means the firm filed a social or content
// platform -- VANGUARD GROUP files a Reddit user profile, BRIDGEWATER a
// SoundCloud page -- and the real site was researched and checked in.
//
// Broken links are deliberately absent: a timeout is not proof a site is dead,
// and several large firms behind bot protection time out while being perfectly
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
 * The URL to actually link to, plus whether and why it differs from what
 * was filed.
 *
 * Falls back to the filed URL whenever there is no override — including
 * while the file is still loading — so a link is never missing or broken
 * while waiting on a fetch.
 */
export function resolveWebsite(overrides, crd, filedUrl) {
  const hit = overrides?.firms?.[String(crd)]
  const via = hit?.via ?? 'redirect'
  if (!hit?.resolved) return { url: filedUrl, redirected: false }

  // A researched site is a fact about the firm, so it holds even when the firm
  // has no usable filed address at all — MARY & PIP files only a Substack.
  if (via === 'research') {
    return { url: hit.resolved, redirected: true, via, filed: filedUrl ?? null }
  }

  // A redirect is a fact about one specific URL. firms.json is rebuilt on every
  // deploy but this file only on a data refresh, so the firm's chosen address
  // can change underneath it (BLACKROCK FUND ADVISORS moved from a WeChat link
  // to blackrock.com); applying the old redirect then would override a correct
  // link with a stale one.
  const sameUrl = !hit.filed || (filedUrl ?? '').trim() === hit.filed.trim()
  if (!filedUrl || !sameUrl) return { url: filedUrl, redirected: false }
  return { url: hit.resolved, redirected: true, via, filed: filedUrl }
}

/** What to show under a website link that no longer matches the filed one. */
export function websiteNote(site) {
  if (!site.redirected) return 'firm website'
  if (site.via !== 'research') return 'firm website · redirected'
  // Researched sites used to all be firms that filed only a social profile, so
  // this read "filed a social link". Once ingest learned to pick the firm's own
  // domain from everything it filed, most of those firms turned out to have
  // filed their real site too — and a few researched entries exist for other
  // reasons (GOLDMAN SACHS ASSET MANAGEMENT listed petershillpartners.com first).
  // Only say anything when the link actually differs from what was filed.
  const host = (u) => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return null
    }
  }
  return site.filed && host(site.filed) === host(site.url) ? 'firm website' : 'firm website · researched'
}
