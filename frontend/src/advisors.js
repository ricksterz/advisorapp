import { useEffect, useState } from 'react'

import { BASE } from './router.js'
import { loadIndex, loadShard } from './shards.js'

// Individual advisors (etl/advisor_index.py -> scripts/shard-data.mjs):
// SEC-registered firms' people from the SEC's IA_INDVL feed. Name search
// reads alphabetical buckets under shards/advisor_search/; a firm's roster
// is in its firm_advisors shard, or its own file when it has 1,000+ people.
//
// Search entries: [crd, name, [firm CRDs], city, state, designations, disclosure]
// Roster rows:    [crd, name, city, state, designations, disclosure, first year]

const cache = new Map()
function getJson(url) {
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

export const nameTokens = (text) =>
  (text || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)

/**
 * Indexes of the buckets that can hold names starting with `prefix`, given
 * the first name filed in each bucket (sorted). Pure.
 */
export function bucketRange(starts, prefix) {
  if (!starts?.length || !prefix) return []
  const end = `${prefix}{` // "{" sorts after "z"
  // Strictly before the prefix: a bucket starting exactly at "smith" can
  // follow one that already holds the first Smiths, when 4,000-name chunks
  // split a common name.
  let first = 0
  for (let i = 0; i < starts.length; i += 1) if (starts[i] < prefix) first = i
  const out = []
  for (let i = first; i < starts.length && starts[i] < end; i += 1) out.push(i)
  return out.length ? out : [first]
}

// More buckets than this for every word typed means the query is too broad
// to answer from a few small files ("ma"); ask for another letter or word.
export const MAX_BUCKETS = 3

/** Does every query word start some word of the name? Pure. */
export const matchesName = (name, queryTokens) => {
  const tokens = nameTokens(name)
  return queryTokens.every((q) => tokens.some((t) => t.startsWith(q)))
}

/**
 * Advisors whose name matches every word of `query`. Resolves to
 * { results, tooBroad }. Uses the word whose buckets are fewest, so
 * "michael smith" reads the "smith" buckets rather than every Michael.
 */
export async function searchAdvisors(query, limit = 8) {
  const words = nameTokens(query).filter((w) => w.length >= 2)
  if (!words.length) return { results: [], tooBroad: false }
  const meta = await getJson(`${BASE}shards/advisor_search/meta.json`)
  if (!meta) return { results: [], tooBroad: false }
  const ranges = words.map((w) => bucketRange(meta.starts, w)).sort((a, b) => a.length - b.length)
  const range = ranges[0]
  if (range.length > MAX_BUCKETS) return { results: [], tooBroad: true }
  const buckets = await Promise.all(range.map((i) => getJson(`${BASE}shards/advisor_search/${i}.json`)))
  const seen = new Set()
  const results = []
  const exactLast = (name) => nameTokens(name).at(-1) === words.at(-1)
  for (const entries of buckets) {
    for (const e of entries ?? []) {
      if (seen.has(e[0]) || !matchesName(e[1], words)) continue
      seen.add(e[0])
      results.push(e)
    }
  }
  results.sort((a, b) => Number(exactLast(b[1])) - Number(exactLast(a[1])) || a[1].localeCompare(b[1]))
  return { results: results.slice(0, limit), total: results.length, tooBroad: false }
}

/** A firm's advisors: undefined while loading, null when none are on file. */
export function useFirmAdvisors(crd) {
  const [roster, setRoster] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('firm_advisors', crd)
      .then((shard) => {
        const entry = shard?.firms?.[String(crd)]
        if (entry?.own_file) return getJson(`${BASE}shards/firm_advisors/firm/${crd}.json`)
        return entry ?? null
      })
      .then((rows) => {
        if (alive) setRoster(rows?.length ? rows : null)
      })
    return () => {
      alive = false
    }
  }, [crd])
  return roster
}

/**
 * { firms: { crd: [advisors, with disclosures] } } for every firm, for the
 * outlier list: undefined while loading, null if unavailable. `enabled`
 * false skips the download on pages that don't show the list.
 */
export function useAdvisorCounts(enabled = true) {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    loadIndex('advisor_counts').then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return data
}

export const iapdIndividualUrl = (crd) => `https://adviserinfo.sec.gov/individual/summary/${crd}`
