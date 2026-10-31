import { useEffect, useState } from 'react'

import { BASE } from './router.js'
import { loadIndex, loadShard } from './shards.js'

// Dated disclosure events (etl/firm_disclosures.py): each firm's Form ADV
// Disclosure Reporting Pages filed or updated since the first cached archive.
// Event: { kind: R|C|J, against: F (the firm) | A (affiliates) | B (both),
//   date, by, what, status, resolution, resolved, amount, text, ref,
//   affiliates? } with keys left out when the filing left them blank.

export const KIND_LABELS = { R: 'Regulatory action', C: 'Criminal', J: 'Civil court case' }
export const AGAINST_LABELS = { F: 'This firm', A: 'Affiliate', B: 'Firm and affiliates' }
export const againstFirm = (e) => e.against !== 'A'

const cache = new Map()
const getJson = (url) => {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    )
  }
  return cache.get(url)
}

/** { events, coversFrom, asOf }: undefined while loading, null when the firm has none on file. */
export function useFirmDisclosures(crd) {
  const [view, setView] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('firm_disclosures', crd)
      .then(async (shard) => {
        const entry = shard?.firms?.[String(crd)]
        const events = entry?.own_file ? await getJson(`${BASE}shards/firm_disclosures/firm/${crd}.json`) : entry
        return events?.length ? { events, coversFrom: shard.covers_from, asOf: shard.as_of } : null
      })
      .then((v) => {
        if (alive) setView(v)
      })
    return () => {
      alive = false
    }
  }, [crd])
  return view
}

/** { as_of, since, years, firms: { crd: [recent own, own, affiliate] } } for the outlier list. */
export function useDisclosureIndex(enabled = true) {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    loadIndex('disclosure_index').then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return data
}

/** Counts and the year range for a card's summary line. Pure. */
export function summarize(events, sinceDate) {
  const own = events.filter(againstFirm)
  return {
    own: own.length,
    affiliates: events.length - own.length,
    recentOwn: own.filter((e) => (e.date ?? '') >= sinceDate).length,
    ownAmount: own.reduce((s, e) => s + (e.amount ?? 0), 0),
  }
}
