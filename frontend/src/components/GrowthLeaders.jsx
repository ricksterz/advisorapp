import { useMemo, useState } from 'react'

import { annualized, leaders, SIZE_FILTERS, useGrowthData } from '../growth.js'
import { fmtCompactUsd } from '../pulse.js'
import { firmPath, navigate } from '../router.js'
import { SEGMENT_BY_ID, SEGMENTS } from '../segments.js'
import { fmtMultiple } from '../trajectory.js'
import { resolveWebsite, useWebsiteOverrides } from '../websiteOverrides.js'
import FirmFavicon from './FirmFavicon.jsx'
import { websiteHost } from './FirmDetail.jsx'
import { PulseBackLink } from './PulseDrilldowns.jsx'
import { PulseDisclaimer } from './PulsePage.jsx'

// "3.2×" from a doubling up, "63%" below it.
const grewBy = (m) => (m >= 2 ? fmtMultiple(m) : `${Math.round((m - 1) * 100)}%`)

const fmtRate = (r) => `${r >= 0 ? '+' : '−'}${Math.abs(Math.round(r * 100))}%`

function FirmName({ firm, overrides }) {
  const site = resolveWebsite(overrides, firm.crd, firm.website_url)
  const host = site.url ? websiteHost(site.url) : null
  const path = firmPath(firm.crd)
  return (
    <span className="rank-firm-name">
      <FirmFavicon host={host} className="rank-favicon" />
      <a className="firm-link" href={path} onClick={(e) => navigate(e, path)}>
        {firm.business_name || firm.legal_name}
      </a>
    </span>
  )
}

/** Pulse drill-down: the fastest-growing advisers by AUM over 3, 5 or 10 years. */
export default function GrowthLeaders({ firms }) {
  const growth = useGrowthData()
  const overrides = useWebsiteOverrides()
  const [period, setPeriod] = useState(5)
  const [segment, setSegment] = useState('wealth')
  const [size, setSize] = useState('all')
  // Most of the top of an unfiltered list is acquisitions and mergers, so the
  // default shows firms that grew without a one-year step.
  const [steadyOnly, setSteadyOnly] = useState(true)

  const rows = useMemo(
    () => leaders(growth, firms, { period, segment, size, steadyOnly }),
    [growth, firms, period, segment, size, steadyOnly],
  )

  if (growth === undefined || !firms) return <div className="state">Loading growth data…</div>
  if (growth === null) return <div className="state">Growth data is not available in this build.</div>

  const start = growth.end_year - period
  const median = segment ? growth.segment_medians?.[segment]?.[String(period)] : null
  const seg = segment ? SEGMENT_BY_ID[segment] : null

  return (
    <section className="pulse growth-leaders" aria-label="Fastest-growing advisers">
      <PulseBackLink />
      <div className="page-head">
        <h1>Fastest-growing advisers</h1>
        <p className="page-tagline">
          AUM growth from January {start} to January {growth.end_year}, from the SEC’s annual
          registered-adviser reports.
        </p>
        <PulseDisclaimer />
      </div>

      <div className="controls growth-controls" role="group" aria-label="Leaderboard filters">
        <div className="segmented" role="radiogroup" aria-label="Period">
          {growth.periods.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              role="radio"
              aria-checked={period === p}
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
            >
              {p} years
            </button>
          ))}
        </div>
        <select value={segment} onChange={(e) => setSegment(e.target.value)} aria-label="Business model">
          {SEGMENTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}s
            </option>
          ))}
          <option value="">All business models</option>
        </select>
        <select value={size} onChange={(e) => setSize(e.target.value)} aria-label="Size today">
          {SIZE_FILTERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="chip"
          aria-pressed={!steadyOnly}
          title={`Include firms whose AUM at least doubled in a single year since ${start}, which is usually an acquisition or merger`}
          onClick={() => setSteadyOnly(!steadyOnly)}
        >
          Include acquisitions & one-year jumps
        </button>
      </div>

      {median && (
        <p className="growth-median">
          The median {seg.label.toLowerCase()} that started above{' '}
          {`$${Math.round(growth.rank_floor / 1e6)}M`} grew its AUM {grewBy(median.median)} (
          {fmtRate(annualized(median.median, period))} a year), across {median.firms.toLocaleString()} firms.
          Markets lift every firm’s AUM, so how far a firm beats the median says more about the firm
          than about the market.
        </p>
      )}

      <div className="detail-card scaling-table-wrap">
        {rows.length ? (
          <table className="pulse-table growth-table-leaders">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Firm</th>
                {!segment && <th>Business model</th>}
                <th className="num">AUM today</th>
                <th className="num">AUM growth</th>
                <th className="num">A year</th>
                {median && <th className="num">vs median</th>}
                <th className="num">Employees</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.firm.crd}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <FirmName firm={r.firm} overrides={overrides} />
                    {r.jump && (
                      <span
                        className="segment-tag growth-jump"
                        title="AUM at least doubled in a single year, usually an acquisition or merger"
                      >
                        jump {r.jump}
                      </span>
                    )}
                  </td>
                  {!segment && <td>{r.segment ? SEGMENT_BY_ID[r.segment].label : '—'}</td>}
                  <td className="num">{fmtCompactUsd(r.firm.aum_total)}</td>
                  <td className="num">{fmtMultiple(r.aum)}</td>
                  <td className="num">{fmtRate(annualized(r.aum, period))}</td>
                  {median && <td className="num">{(r.aum / median.median).toFixed(1)}×</td>}
                  <td className="num">{r.employees != null ? fmtMultiple(r.employees) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="detail-empty">No firms match these filters.</p>
        )}
      </div>

      <p className="detail-note">
        Growth is regulatory AUM in the SEC’s January report of each year, which reflects each
        firm’s latest Form ADV, usually filed the spring before. It includes market gains, new
        clients and acquisitions alike; “vs median” compares with firms of the same business model
        over the same years, which takes out most of the market’s effect. Only firms above $
        {Math.round(growth.rank_floor / 1e6)}M at the start are ranked, since a small base makes
        multiples meaningless. Business model and size are as of today. “Employees” is the change in
        total headcount over the same period.
      </p>
    </section>
  )
}
