import { useEffect, useMemo, useState } from 'react'

import { usePageMeta } from '../pageMeta.js'
import { staffOf } from '../benchmarking/factors.js'
import { downloadCsv } from '../csv.js'
import { fmtCompactUsd, fmtQuarter } from '../pulse.js'
import { comparePath, diligencePath, firmPath, go, MAX_COMPARE, navigate, reportPath } from '../router.js'
import { firmSegment, SEGMENT_BY_ID } from '../segments.js'
import { loadShard } from '../shards.js'
import { iapdUrl } from '../sources.js'
import {
  detectChanges,
  follow,
  MAX_NOTE,
  recentQuarterChanges,
  resetBaseline,
  setNote,
  unfollow,
  useWatchlist,
} from '../watchlist.js'
import FirmSearch from './FirmSearch.jsx'

const nameOf = (f) => f.business_name || f.legal_name

/** { [crd]: history | null } for the followed firms' quarterly series. */
function useHistories(crds) {
  const [map, setMap] = useState({})
  const key = crds.join(',')
  useEffect(() => {
    let alive = true
    Promise.all(
      crds.map((crd) =>
        loadShard('firm_history', crd).then((d) => {
          const e = d?.firms?.[String(crd)]
          return [crd, e ? { quarters: d.quarters, ...e } : null]
        }),
      ),
    ).then((entries) => {
      if (alive) setMap(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return map
}

function NoteField({ crd, note }) {
  const [value, setValue] = useState(note)
  useEffect(() => setValue(note), [note])
  return (
    <label className="watch-note">
      <span className="sr-only">Private note</span>
      <textarea
        rows={2}
        maxLength={MAX_NOTE}
        value={value}
        placeholder="Private note (saved in this browser only)"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== note && setNote(crd, value)}
      />
    </label>
  )
}

export default function WatchlistPage({ allFirms, snapshot }) {
  const list = useWatchlist()
  const [selected, setSelected] = useState([])
  const entries = Object.values(list.firms)
  const byCrd = useMemo(() => new Map((allFirms ?? []).map((f) => [f.crd, f])), [allFirms])
  const crds = entries.map((e) => e.crd).sort((a, b) => a - b)
  const histories = useHistories(crds)

  usePageMeta({ title: 'Watchlist · Open Disclosure', path: 'watchlist' })

  const rows = entries
    .map((e) => {
      const firm = byCrd.get(e.crd) ?? null
      return {
        entry: e,
        firm,
        changes: allFirms ? detectChanges(e.baseline, firm) : [],
        recent: recentQuarterChanges(histories[e.crd]),
      }
    })
    .sort((a, b) => b.changes.length - a.changes.length || (a.entry.name || '').localeCompare(b.entry.name || ''))

  const toggle = (crd) =>
    setSelected((s) => (s.includes(crd) ? s.filter((c) => c !== crd) : s.length < MAX_COMPARE ? [...s, crd] : s))

  const exportCsv = () => {
    const out = [
      ['Firm', 'CRD', 'Business model', 'Regulatory AUM', 'Advisory staff', 'Item 11 disclosures', 'Following since', 'Baseline snapshot', 'Changes since following', 'Recent quarter changes', 'Note', 'IAPD'],
    ]
    for (const r of rows) {
      const f = r.firm
      out.push([
        f ? nameOf(f) : r.entry.name,
        r.entry.crd,
        f && firmSegment(f) ? SEGMENT_BY_ID[firmSegment(f)].label : '',
        f?.aum_total ?? null,
        f ? staffOf(f) : null,
        f?.disciplinary_flag_count ?? null,
        r.entry.addedAt?.slice(0, 10) ?? '',
        r.entry.baseline?.date ?? '',
        r.changes.map((c) => c.text).join(' | '),
        r.recent.map((c) => `${fmtQuarter(c.quarter)}: ${c.text}`).join(' | '),
        r.entry.note,
        iapdUrl(r.entry.crd),
      ])
    }
    downloadCsv(out, 'Open Disclosure watchlist')
  }

  const changed = rows.filter((r) => r.changes.length).length

  return (
    <section className="watchlist-page" aria-label="Watchlist">
      <div className="page-head">
        <h1>Watchlist</h1>
        <p className="page-tagline">
          Firms you follow, what has changed in their filings since you started, and your private notes. Saved in this browser
          only: there is no account, and nothing is sent to a server.
        </p>
      </div>

      <div className="watch-toolbar">
        {allFirms && (
          <FirmSearch
            firms={allFirms}
            exclude={crds}
            onSelect={(f) => follow(f, snapshot)}
            placeholder="Follow a firm by name or CRD"
            label="Follow a firm"
            className="compare-add"
          />
        )}
        <span className="spacer" />
        <button
          type="button"
          className="chip share-link"
          disabled={selected.length < 2}
          onClick={() => go(comparePath(selected))}
          title={`Pick 2–${MAX_COMPARE} firms with the checkboxes`}
        >
          Compare selected ({selected.length})
        </button>
        <button type="button" className="chip share-link" disabled={!rows.length} onClick={exportCsv}>
          Export CSV
        </button>
      </div>

      {!allFirms && <div className="state">Loading firm data…</div>}

      {allFirms && rows.length === 0 && (
        <div className="empty-panel">
          <h2>No firms yet</h2>
          <p>
            Use <strong>☆ Follow</strong> on any firm’s profile, report or comparison, or the star in the firm table, or search above.
            Each firm’s figures are recorded when you follow it, so later visits can show what changed.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <p className="detail-note">
            {rows.length} firm{rows.length === 1 ? '' : 's'} followed
            {changed ? ` · ${changed} with material changes since you started following` : ' · no material changes since you started following'}.
            Current data: SEC Form ADV snapshot {snapshot ?? '—'}.
          </p>
          <ul className="watch-list">
            {rows.map(({ entry, firm, changes, recent }) => (
              <li key={entry.crd} className={`watch-item${changes.length ? ' has-changes' : ''}`}>
                <div className="watch-main">
                  <label className="watch-select">
                    <input
                      type="checkbox"
                      checked={selected.includes(entry.crd)}
                      disabled={!firm || (!selected.includes(entry.crd) && selected.length >= MAX_COMPARE)}
                      onChange={() => toggle(entry.crd)}
                    />
                    <span className="sr-only">Select {firm ? nameOf(firm) : entry.name} to compare</span>
                  </label>
                  <div className="watch-id">
                    {firm ? (
                      <a className="firm-link" href={firmPath(entry.crd)} onClick={(e) => navigate(e, firmPath(entry.crd))}>
                        {nameOf(firm)}
                      </a>
                    ) : (
                      <span className="firm-link">{entry.name || `CRD ${entry.crd}`}</span>
                    )}
                    <div className="firm-sub">
                      CRD {entry.crd}
                      {firm && firmSegment(firm) && <> · {SEGMENT_BY_ID[firmSegment(firm)].label}</>}
                      {entry.addedAt && <> · following since {entry.addedAt.slice(0, 10)}</>}
                    </div>
                  </div>
                  {firm && (
                    <dl className="watch-figures">
                      <div><dt>AUM</dt><dd>{fmtCompactUsd(firm.aum_total)}</dd></div>
                      <div><dt>Advisory staff</dt><dd>{staffOf(firm)?.toLocaleString() ?? 'Not reported'}</dd></div>
                      <div><dt>Disclosures</dt><dd>{firm.disciplinary_flag_count ?? 0}</dd></div>
                    </dl>
                  )}
                </div>

                {changes.length > 0 ? (
                  <div className="watch-changes" role="status">
                    <strong>Since you started following{entry.baseline?.date ? ` (snapshot ${entry.baseline.date})` : ''}:</strong>
                    <ul>
                      {changes.map((c) => (
                        <li key={c.id} className={`change-kind-${c.kind}`}>{c.text}</li>
                      ))}
                    </ul>
                    {firm && (
                      <button type="button" className="link-btn" onClick={() => resetBaseline(entry.crd, firm, snapshot)}>
                        Mark as reviewed
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="watch-nochange">No material changes since you started following.</p>
                )}
                {recent.length > 0 && (
                  <p className="watch-recent">
                    Latest published quarter{recent[0].quarter ? ` (${fmtQuarter(recent[0].quarter)})` : ''}: {recent.map((c) => c.text).join(' ')}
                  </p>
                )}

                <NoteField crd={entry.crd} note={entry.note} />

                <div className="watch-actions">
                  {firm && (
                    <>
                      <a href={reportPath(entry.crd)} onClick={(e) => navigate(e, reportPath(entry.crd))}>Intelligence report</a>
                      <a href={diligencePath(entry.crd)} onClick={(e) => navigate(e, diligencePath(entry.crd))}>Questionnaire</a>
                    </>
                  )}
                  <a href={iapdUrl(entry.crd)} target="_blank" rel="noreferrer">IAPD ↗</a>
                  <button type="button" className="link-btn" onClick={() => unfollow(entry.crd)}>
                    Unfollow
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="pulse-disclaimer">
            “Material change” compares the firm’s current filing data with the figures recorded when you followed it: AUM moves of
            10% or more, advisory headcount moves of 15% or more, any change in Item 11 disclosures, fee types, affiliations or
            broker-dealer status. Filings can lag events by months; check IAPD for the official record. The watchlist lives in this
            browser’s storage, so clearing site data removes it — export a CSV to keep a copy.
          </p>
        </>
      )}
    </section>
  )
}
