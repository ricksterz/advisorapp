import { useMemo, useState } from 'react'

import { AGAINST_LABELS, againstFirm, KIND_LABELS, summarize, useFirmDisclosures } from '../disclosures.js'
import { fmtCompactUsd, fmtCount } from '../pulse.js'
import DataNote from './DataNote.jsx'

const PAGE = 15
const iapdFirmUrl = (crd) => `https://adviserinfo.sec.gov/firm/summary/${crd}`

const fmtDate = (iso) => {
  if (!iso) return 'Date not given'
  const [y, m, d] = iso.split('-')
  if (!m) return y
  const month = new Date(Date.UTC(2000, Number(m) - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return d ? `${month} ${Number(d)}, ${y}` : `${month} ${y}`
}

// Regulator and court names arrive in capitals; soften them, keeping
// acronyms ("FINRA", "CME", "(IEX)") as written.
const ACRONYMS = new Set([
  'SEC', 'FINRA', 'NASAA', 'CFTC', 'NFA', 'NYSE', 'CME', 'CBOE', 'IEX', 'LLC', 'LP', 'LLP',
  'US', 'USA', 'FCA', 'MSRB', 'OCC', 'FDIC', 'DOJ', 'NY', 'II', 'III',
])
export const titleCase = (s) =>
  s && s === s.toUpperCase()
    ? s.replace(/[A-Z][A-Z'.]*/g, (w, i) =>
        ACRONYMS.has(w.replace(/\./g, '')) || s[i - 1] === '(' ? w : w[0] + w.slice(1).toLowerCase(),
      )
    : s

function Event({ e }) {
  const [open, setOpen] = useState(false)
  const outcome = [e.resolution, e.status && e.status !== e.resolution ? e.status : null].filter(Boolean).join(' · ')
  return (
    <li className="disclosure-event">
      <div className="disclosure-line">
        <span className="disclosure-date">{fmtDate(e.date)}</span>
        <span className="disclosure-what">
          <strong>{KIND_LABELS[e.kind]}</strong>
          {e.by && <> · {titleCase(e.by)}</>}
        </span>
        {e.amount ? <span className="disclosure-amount">{fmtCompactUsd(e.amount)}</span> : null}
      </div>
      <div className="disclosure-meta">
        <span className={`fund-tag${e.against === 'A' ? '' : ' warn'}`}>{AGAINST_LABELS[e.against]}</span>
        {e.what && <span>{e.what}</span>}
        {outcome && <span>{outcome}{e.resolved ? `, ${fmtDate(e.resolved)}` : ''}</span>}
      </div>
      {e.affiliates?.length > 0 && (
        <div className="disclosure-meta">Concerns: {e.affiliates.map(titleCase).join(', ')}</div>
      )}
      {e.text && (
        <button type="button" className="disclosure-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide details' : 'Details'}
        </button>
      )}
      {open && <p className="disclosure-text">{e.text}</p>}
    </li>
  )
}

/**
 * The firm's dated disclosure events from its Form ADV disclosure pages,
 * events against the firm itself first. Affiliates' events, often most of a
 * large firm's total, are one click away rather than mixed in.
 */
export default function DisclosuresCard({ crd, firmName }) {
  const view = useFirmDisclosures(crd)
  const [scope, setScope] = useState('F')
  const [shown, setShown] = useState(PAGE)

  const events = useMemo(() => {
    if (!view) return []
    return view.events.filter((e) => (scope === 'all' ? true : scope === 'A' ? !againstFirm(e) : againstFirm(e)))
  }, [view, scope])

  if (!view) return null
  const year = Number(view.asOf.slice(0, 4)) - 5
  const s = summarize(view.events, `${year}${view.asOf.slice(4)}`)
  const effectiveScope = scope === 'F' && s.own === 0 ? 'A' : scope
  const list = effectiveScope === scope ? events : view.events.filter((e) => !againstFirm(e))

  return (
    <section className="detail-card disclosures-card" aria-labelledby="disclosures-title">
      <h2 id="disclosures-title">Disclosure events</h2>
      <p className="disclosures-summary">
        <strong>{fmtCount(s.own)}</strong> against {firmName} itself
        {s.own > 0 && <> ({fmtCount(s.recentOwn)} since {year}{s.ownAmount ? `, ${fmtCompactUsd(s.ownAmount)} in monetary sanctions` : ''})</>}
        {' · '}
        <strong>{fmtCount(s.affiliates)}</strong> against affiliates
      </p>
      <div className="segmented disclosures-scope" role="radiogroup" aria-label="Which events">
        {[
          ['F', `This firm (${fmtCount(s.own)})`],
          ['A', `Affiliates (${fmtCount(s.affiliates)})`],
          ['all', 'All'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="chip"
            role="radio"
            aria-checked={effectiveScope === id}
            aria-pressed={effectiveScope === id}
            onClick={() => {
              setScope(id)
              setShown(PAGE)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="disclosure-list">
        {list.slice(0, shown).map((e) => (
          <Event key={e.ref} e={e} />
        ))}
      </ul>
      {list.length > shown && (
        <button type="button" className="chip advisors-more" onClick={() => setShown((n) => n + PAGE * 3)}>
          Show more ({fmtCount(list.length - shown)} left)
        </button>
      )}
      <p className="detail-note">
        As reported by the firm on its Form ADV disclosure pages. A disclosure is not necessarily a
        finding of wrongdoing: it can be an allegation, a matter still pending, a settlement without
        admission, or a matter later dismissed or overturned.{' '}
        <a href={iapdFirmUrl(crd)} target="_blank" rel="noreferrer">
          Read the official record on adviserinfo.sec.gov ↗
        </a>
      </p>
      <DataNote>
        Events filed or updated from {fmtDate(view.coversFrom)} to {fmtDate(view.asOf)}, the period
        of Form ADV filing archives this site holds. A firm only re-files a disclosure page when it
        adds or changes one, so an older event the firm hasn’t updated since may be missing here; the
        SEC’s record is complete. Form ADV Item 11 covers the firm and every advisory affiliate, so
        large groups report their affiliates’ matters too: that is why events against this firm are
        shown first. Dates are when the action began or was filed. Monetary amounts are as filed and
        may not separate this firm’s share from others named in the same action. Long descriptions
        are shortened.
      </DataNote>
    </section>
  )
}
