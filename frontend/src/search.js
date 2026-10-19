import { firmSegment, SEGMENT_BY_ID } from './segments.js'

// Firm search for the header box, the homepage and the compare page.
// Matching ignores case, punctuation and legal suffixes, and needs every
// word typed: "jackson grant" finds "JACKSON, GRANT INVESTMENT ADVISERS,
// INC.", "edward jones" finds "EDWARD JONES" before "EDWARD JONES TRUST
// COMPANY". Digits match a CRD from its start.

const SUFFIXES = /\b(inc|llc|l\s?l\s?c|lp|l\s?p|llp|ltd|corp|corporation|co|company|the)\b/g

export function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const strip = (text) => normalize(text).replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim()

const index = new WeakMap()

function entries(firms) {
  let list = index.get(firms)
  if (!list) {
    list = firms.map((firm) => {
      const names = [...new Set([firm.business_name, firm.legal_name].filter(Boolean).map(normalize))]
      return { firm, names, stripped: names.map((n) => strip(n) || n), crd: String(firm.crd) }
    })
    index.set(firms, list)
  }
  return list
}

/** Best matches first: exact name, then name starting with the query, then
 * every word present, larger firms ahead within each tier. */
export function searchFirms(firms, query, limit = 8) {
  const q = normalize(query)
  if (!firms?.length || !q) return []
  if (/^\d+$/.test(q)) {
    return entries(firms)
      .filter((e) => e.crd.startsWith(q))
      .sort((a, b) => (a.crd === q ? -1 : b.crd === q ? 1 : 0))
      .slice(0, limit)
      .map((e) => e.firm)
  }
  if (q.length < 2) return []
  const qs = strip(q) || q
  const words = qs.split(' ')
  const scored = []
  for (const e of entries(firms)) {
    let tier = null
    for (const name of e.stripped) {
      let t = null
      if (name === qs) t = 0
      else if (name.startsWith(qs)) t = 1
      else if (words.every((w) => name.split(' ').some((nw) => nw.startsWith(w)))) t = 2
      else if (words.every((w) => name.includes(w))) t = 3
      if (t != null && (tier == null || t < tier)) tier = t
    }
    if (tier != null) scored.push([tier, e.firm])
  }
  scored.sort((a, b) => a[0] - b[0] || (b[1].aum_total ?? 0) - (a[1].aum_total ?? 0))
  return scored.slice(0, limit).map(([, firm]) => firm)
}

/** "Wealth manager · NY" style line under a result. */
export function resultDetail(firm) {
  const seg = firmSegment(firm)
  return [seg ? SEGMENT_BY_ID[seg].label : null, firm.state || firm.country, `CRD ${firm.crd}`]
    .filter(Boolean)
    .join(' · ')
}
