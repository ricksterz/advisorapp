import { useMemo, useState } from 'react'

import { usePageMeta } from '../pageMeta.js'
import { benchmark, DEFAULT_COHORT, HNW_FOCUS, MIN_COHORT, selectCohort, takeaways } from '../benchmarkFirm.js'
import { downloadCsv } from '../csv.js'
import { useGrowthData } from '../growth.js'
import { describeRank, fmtMetric, prevalence } from '../peers.js'
import { ordinal } from '../pulse.js'
import { benchmarkPath, firmPath, go, navigate, reportPath } from '../router.js'
import { SEGMENT_BY_ID } from '../segments.js'
import CopyLinkButton from './CopyLinkButton.jsx'
import FirmSearch from './FirmSearch.jsx'
import { PercentileBar } from './IntelligenceReport.jsx'
import { track, useTrackView } from '../analytics.js'

const SITE_URL = 'https://open-disclosure.com'
const nameOf = (f) => f.business_name || f.legal_name

const CLIENT_FIELDS = [
  ['pct_clients_individuals', 'Individuals'],
  ['pct_clients_hnw_individuals', 'High-net-worth individuals'],
  ['pct_clients_pooled_vehicles', 'Pooled vehicles'],
  ['pct_clients_pension_plans', 'Pension & profit-sharing plans'],
  ['pct_clients_corporations', 'Corporations'],
  ['pct_clients_other', 'Other'],
]

function median(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export default function BenchmarkPage({ allFirms, crd }) {
  const growth = useGrowthData()
  const [opts, setOpts] = useState(DEFAULT_COHORT)
  const firm = crd && allFirms ? allFirms.find((f) => f.crd === crd) : null

  usePageMeta({
    title: firm ? `Benchmark ${nameOf(firm)} against peers · Open Disclosure` : 'Benchmark my firm · Open Disclosure',
    path: 'benchmark',
  })

  useTrackView('benchmark_firm', { firm_crd: firm?.crd }, !!firm)
  const cohort = useMemo(() => (firm ? selectCohort(firm, allFirms, opts) : null), [firm, allFirms, opts])
  const sections = useMemo(
    () => (firm && cohort && !cohort.tooSmall ? benchmark(firm, cohort.peers, growth) : null),
    [firm, cohort, growth],
  )
  const notes = sections ? takeaways(sections) : []
  const prev = firm && cohort && !cohort.tooSmall ? prevalence(firm, cohort.peers) : null

  const exportCsv = () => {
    const rows = [['Section', 'Measure', nameOf(firm), 'Peer 25th', 'Peer median', 'Peer 75th', 'Percentile', 'Peers with data']]
    for (const s of sections) {
      for (const m of s.stats) {
        rows.push([s.label, m.label, m.value, m.p25, m.median, m.p75, m.rank != null ? Math.round(m.rank * 100) : null, m.n])
      }
    }
    for (const p of prev) rows.push(['Arrangements', p.label, p.firm, null, p.share != null ? Math.round(p.share * 100) : null, null, null, cohort.peers.length])
    rows.push([])
    rows.push(['Peer group', cohort.label, `${cohort.peers.length} firms`])
    downloadCsv(rows, `${nameOf(firm)} benchmark`, 'benchmark')
  }

  const toggle = (k) => {
    track('change_benchmark_peers', { dimension: k, enabled: !opts[k] })
    setOpts((o) => ({ ...o, [k]: !o[k] }))
  }
  const query = new URLSearchParams()
  if (firm) query.set('firm', firm.crd)

  return (
    <section className="benchmark-page" aria-label="Benchmark my firm">
      <div className="page-head">
        <h1>Benchmark my firm</h1>
        <p className="page-tagline">
          For RIA principals and their advisers: how a firm’s growth, staffing, productivity, client composition and business
          model compare with a peer group you define — from every firm’s public Form ADV.
        </p>
      </div>

      {allFirms ? (
        <FirmSearch
          firms={allFirms}
          onSelect={(f) => go(benchmarkPath(f.crd))}
          placeholder={firm ? 'Benchmark a different firm' : 'Find your firm by name or CRD'}
          label="Firm to benchmark"
          className="compare-add"
        />
      ) : (
        <div className="state">Loading firm data…</div>
      )}

      {crd && allFirms && !firm && <p className="detail-note">No firm with CRD {crd} in this snapshot.</p>}

      {!firm && allFirms && (
        <div className="empty-panel">
          <h2>Pick a firm to begin</h2>
          <p>
            Search for any SEC-registered adviser. You’ll see its percentile on each measure within a peer group of the same
            business model and size, and can narrow the group by region or high-net-worth focus. Nothing you search is stored or
            sent anywhere.
          </p>
        </div>
      )}

      {firm && cohort && (
        <>
          <div className="bench-head detail-card">
            <div>
              <h2>
                <a href={firmPath(firm.crd)} onClick={(e) => navigate(e, firmPath(firm.crd))}>{nameOf(firm)}</a>
              </h2>
              <p className="detail-sub">
                CRD {firm.crd}
                {cohort.segment && <> · {SEGMENT_BY_ID[cohort.segment].label}</>} · {cohort.band} in AUM
                {cohort.region && <> · {cohort.region}</>}
              </p>
            </div>
            <fieldset className="cohort-controls">
              <legend>Peer group</legend>
              <label><input type="checkbox" checked={opts.segment} disabled={!cohort.segment} onChange={() => toggle('segment')} /> Same business model</label>
              <label><input type="checkbox" checked={opts.band} onChange={() => toggle('band')} /> Same AUM band</label>
              <label><input type="checkbox" checked={opts.region} disabled={!cohort.region} onChange={() => toggle('region')} /> Same region</label>
              <label><input type="checkbox" checked={opts.hnw} onChange={() => toggle('hnw')} /> {HNW_FOCUS}%+ HNW clients</label>
            </fieldset>
            <p className="bench-cohort" aria-live="polite">
              Compared with <strong>{cohort.peers.length.toLocaleString()}</strong> {cohort.label}.
            </p>
            <div className="fee-actions">
              <CopyLinkButton url={`${SITE_URL}/benchmark?${query}`} label="Copy link" className="chip share-link" trackAs="benchmark" />
              <button type="button" className="chip share-link" disabled={!sections} onClick={exportCsv}>Export CSV</button>
              <a className="chip share-link" href={reportPath(firm.crd)} onClick={(e) => navigate(e, reportPath(firm.crd))}>Intelligence report</a>
            </div>
          </div>

          {cohort.tooSmall ? (
            <p className="detail-empty">
              Only {cohort.peers.length} firm{cohort.peers.length === 1 ? '' : 's'} match this peer group; at least {MIN_COHORT} are
              needed for percentiles to mean anything. Loosen a filter above.
            </p>
          ) : (
            <>
              {notes.length > 0 && (
                <div className="detail-card">
                  <h2>Where the firm stands out from its peers</h2>
                  <ul className="limit-list">
                    {notes.map((n) => <li key={n.id}>{n.text}</li>)}
                  </ul>
                  <p className="detail-note">
                    Outer quartiles only. A position is a description, not a grade: a high AUM per professional can reflect
                    institutional mandates as easily as efficiency, and a low one a high-touch service model.
                  </p>
                </div>
              )}

              {sections.map((s) => (
                <div key={s.id} className="detail-card">
                  <h2>{s.label}</h2>
                  <div className="table-scroll">
                    <table className="pulse-table bench-table">
                      <thead>
                        <tr>
                          <th>Measure</th>
                          <th className="num">{nameOf(firm)}</th>
                          <th className="num">25th</th>
                          <th className="num">Median</th>
                          <th className="num">75th</th>
                          <th className="num">Percentile</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.stats.map((m) => {
                          const r = describeRank(m.rank)
                          return (
                            <tr key={m.id}>
                              <td>
                                {m.label}
                                <span className="bench-n"> · {m.n.toLocaleString()} peers with data</span>
                              </td>
                              <td className="num"><strong>{fmtMetric(m.kind, m.value)}</strong></td>
                              <td className="num">{m.n ? fmtMetric(m.kind, m.p25) : '—'}</td>
                              <td className="num">{m.n ? fmtMetric(m.kind, m.median) : '—'}</td>
                              <td className="num">{m.n ? fmtMetric(m.kind, m.p75) : '—'}</td>
                              <td className="num">{r ? <PercentileBar rank={m.rank} label={ordinal(r.pct)} /> : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {s.id === 'growth' && (
                    <p className="detail-note">
                      Change in regulatory AUM and employees from the SEC’s annual adviser reports. It includes markets,
                      acquisitions and new clients, and is not investment performance.
                    </p>
                  )}
                </div>
              ))}
              {growth === undefined && <p className="detail-note">Loading growth history…</p>}

              <div className="detail-grid">
                <div className="detail-card">
                  <h2>Client mix vs peer median</h2>
                  <table className="pulse-table">
                    <thead>
                      <tr>
                        <th>Share of clients</th>
                        <th className="num">This firm</th>
                        <th className="num">Peer median</th>
                      </tr>
                    </thead>
                    <tbody>
                      {CLIENT_FIELDS.map(([field, label]) => (
                        <tr key={field}>
                          <td>{label}</td>
                          <td className="num">{fmtMetric('pct', firm[field])}</td>
                          <td className="num">{fmtMetric('pct', median(cohort.peers.map((f) => f[field])))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="detail-card">
                  <h2>Fee structure & business model</h2>
                  <table className="pulse-table">
                    <thead>
                      <tr>
                        <th>Arrangement</th>
                        <th>This firm</th>
                        <th className="num">Share of peers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prev.map((p) => (
                        <tr key={p.id}>
                          <td>{p.label}</td>
                          <td>{p.firm ? 'Yes' : 'Not reported'}</td>
                          <td className="num">{p.share != null ? `${Math.round(p.share * 100)}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="pulse-disclaimer">
                Every figure is self-reported on Form ADV and can lag a firm’s current business by up to a year. Peer medians and
                percentiles are computed in your browser from the current snapshot. Informational only; not a rating of any firm.
              </p>
            </>
          )}
        </>
      )}
    </section>
  )
}
