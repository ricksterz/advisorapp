import { useEffect, useMemo, useRef, useState } from 'react'

import { iapdIndividualUrl, matchesName, nameTokens, useFirmAdvisors } from '../advisors.js'
import { fmtCount } from '../pulse.js'

const PAGE = 25

/** The ?advisor= CRD a search result links with, if any. */
const linkedAdvisor = () => {
  const v = new URLSearchParams(window.location.search).get('advisor')
  return v && /^\d+$/.test(v) ? Number(v) : null
}

/**
 * The firm's SEC-registered individuals from the SEC's IA_INDVL feed:
 * filterable by name or place, paged, with each person's SEC record a click
 * away. Opened from search, it shows and highlights that person.
 */
export default function AdvisorsCard({ crd }) {
  const roster = useFirmAdvisors(crd)
  const [linked] = useState(linkedAdvisor)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const card = useRef(null)
  const highlight = useRef(null)

  const rows = useMemo(() => {
    if (!roster) return []
    const words = nameTokens(query)
    if (!words.length) return roster
    // A query matches the name, or the city/state ("denver", "co").
    return roster.filter(
      (r) => matchesName(r[1], words) || matchesName(`${r[2] ?? ''} ${r[3] ?? ''}`, words),
    )
  }, [roster, query])

  // From a search result: put the person first and scroll the card to them.
  const ordered = useMemo(() => {
    if (linked == null || query) return rows
    const i = rows.findIndex((r) => r[0] === linked)
    return i > 0 ? [rows[i], ...rows.slice(0, i), ...rows.slice(i + 1)] : rows
  }, [rows, linked, query])

  useEffect(() => {
    if (linked != null && roster && highlight.current) {
      highlight.current.scrollIntoView({ block: 'center' })
    }
  }, [linked, roster])

  if (!roster) return null
  const designated = roster.filter((r) => r[4]).length
  const withDisclosures = roster.filter((r) => r[5]).length

  return (
    <section className="detail-card advisors-card" ref={card} aria-labelledby="advisors-title">
      <div className="advisors-head">
        <h2 id="advisors-title">Advisors at this firm</h2>
        <span className="advisors-count">
          {fmtCount(roster.length)} registered · {fmtCount(designated)} with a CFP, CFA or similar ·{' '}
          {fmtCount(withDisclosures)} with disclosures
        </span>
      </div>
      {roster.length > 8 && (
        <span className="search advisors-filter">
          <span className="glyph" aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Filter by name or city"
            aria-label="Filter this firm's advisors"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setShown(PAGE)
            }}
          />
        </span>
      )}
      <table className="pulse-table stack-mobile advisors-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Location</th>
            <th className="num">In the industry since</th>
            <th className="num">SEC record</th>
          </tr>
        </thead>
        <tbody>
          {ordered.slice(0, shown).map(([pcrd, name, city, state, designations, disclosure, since]) => (
            <tr
              key={pcrd}
              ref={pcrd === linked ? highlight : null}
              className={pcrd === linked ? 'advisor-linked' : ''}
            >
              <td>
                {name}
                {designations &&
                  designations.split(' ').map((d) => (
                    <span key={d} className="fund-tag">
                      {d}
                    </span>
                  ))}
                {disclosure ? <span className="fund-tag warn">disclosures</span> : null}
              </td>
              <td data-label="">{[city, state].filter(Boolean).join(', ') || '—'}</td>
              <td className="num" data-label="Since">
                {since ?? '—'}
              </td>
              <td className="num">
                <a href={iapdIndividualUrl(pcrd)} target="_blank" rel="noreferrer">
                  CRD {pcrd} ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ordered.length === 0 && <p className="detail-empty">No advisor here matches “{query}”.</p>}
      {ordered.length > shown && (
        <button type="button" className="chip advisors-more" onClick={() => setShown((n) => n + PAGE * 4)}>
          Show more ({fmtCount(ordered.length - shown)} left)
        </button>
      )}
      <p className="detail-note">
        People registered through this firm, from the SEC’s public individual adviser feed, which
        may be out of date. “Disclosures” means at least one regulatory, customer, criminal,
        financial or employment matter is on file; it may be pending, dismissed or settled, and it is
        not a finding of wrongdoing. The SEC record has the details. A person registered with
        several firms is listed at each. Not a consumer report: don’t use this for employment,
        credit or insurance decisions.
      </p>
    </section>
  )
}
