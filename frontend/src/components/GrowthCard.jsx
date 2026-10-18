import { useRef, useState } from 'react'

import { fmtCompactUsd, fmtCount } from '../pulse.js'
import { SEGMENT_BY_ID } from '../segments.js'
import { firmTrajectory, fmtMultiple, growthSummary, useTrajectoryData } from '../trajectory.js'
import { useWidth } from './useWidth.js'

// Three series indexed to 1× in the first year both AUM and support staff are
// above zero, on one log axis: growth in assets and in each kind of staff is
// read as a multiple of where the firm started, never against two y-scales.
const SERIES = [
  { key: 'aum', label: 'AUM', slot: 1, fmt: fmtCompactUsd },
  { key: 'advisory', label: 'Advisory staff', slot: 2, fmt: fmtCount },
  { key: 'support', label: 'Non-advisory staff', slot: 3, fmt: fmtCount },
]

function withAdvisory(points) {
  return points.map((p) => ({
    ...p,
    advisory: p.employees != null && p.support != null ? p.employees - p.support : null,
  }))
}

function IndexChart({ points, baseYear }) {
  const wrap = useRef(null)
  const width = useWidth(wrap)
  const [hover, setHover] = useState(null)
  const shown = points.filter((p) => p.year >= baseYear)
  const base = shown[0]
  const series = SERIES.map((s) => ({
    ...s,
    values: shown.map((p) => (p[s.key] > 0 && base[s.key] > 0 ? p[s.key] / base[s.key] : null)),
  })).filter((s) => s.values.filter((v) => v != null).length > 1)
  const all = series.flatMap((s) => s.values.filter((v) => v != null))
  if (!all.length) return null

  const height = 220
  const labels = width >= 520
  const m = { top: 12, right: labels ? 132 : 12, bottom: 28, left: 44 }
  const yMin = Math.min(1, ...all) / 1.15
  const yMax = Math.max(1, ...all) * 1.15
  const years = shown.map((p) => p.year)
  const x = (yr) =>
    m.left + ((yr - years[0]) / Math.max(1, years[years.length - 1] - years[0])) * (width - m.left - m.right)
  const y = (v) =>
    m.top + (1 - (Math.log(v) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin))) * (height - m.top - m.bottom)
  const ticks = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128].filter((t) => t >= yMin && t <= yMax)
  // First and last year always; every year or every other between, never
  // crowding an end label.
  const first = years[0]
  const last = years[years.length - 1]
  const step = years.length <= 7 ? 1 : 2
  const yearTicks = years.filter(
    (yr) => yr === first || yr === last || (yr % step === 0 && yr - first > 1 && last - yr > 1),
  )

  // End labels, nudged apart vertically so they never overlap.
  const ends = series
    .map((s) => {
      const i = s.values.findLastIndex((v) => v != null)
      return { ...s, ly: y(s.values[i]), value: s.values[i] }
    })
    .sort((a, b) => a.ly - b.ly)
  for (let i = 1; i < ends.length; i += 1) ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + 15)

  const onMove = (e) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left
    let best = 0
    years.forEach((yr, i) => {
      if (Math.abs(x(yr) - px) < Math.abs(x(years[best]) - px)) best = i
    })
    setHover(best)
  }

  return (
    <div className="growth-chart" ref={wrap}>
      <div className="scaling-legend">
        {series.map((s) => (
          <span key={s.key} className="scaling-legend-item">
            <span className={`scaling-swatch series-${s.slot}`} />
            {s.label}
          </span>
        ))}
      </div>
      {width > 0 && (
        <div className="scaling-plot">
          <svg
            width={width}
            height={height}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`AUM and staff as multiples of their ${baseYear} level. Values are listed in the table below.`}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className={t === 1 ? 'growth-baseline' : 'scaling-grid'} x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
                <text className="scaling-tick" x={m.left - 8} y={y(t) + 4} textAnchor="end">
                  {t}×
                </text>
              </g>
            ))}
            {yearTicks.map((yr) => (
              <text key={yr} className="scaling-tick" x={x(yr)} y={height - 8} textAnchor="middle">
                {yr}
              </text>
            ))}
            {hover != null && (
              <line className="growth-crosshair" x1={x(years[hover])} x2={x(years[hover])} y1={m.top} y2={height - m.bottom} />
            )}
            {series.map((s) => {
              const segs = []
              let cur = []
              s.values.forEach((v, i) => {
                if (v == null) {
                  if (cur.length) segs.push(cur)
                  cur = []
                } else cur.push(`${x(years[i])},${y(v)}`)
              })
              if (cur.length) segs.push(cur)
              return (
                <g key={s.key} className={`series-${s.slot}`}>
                  {segs.map((pts, i) => (
                    <polyline key={i} className="scaling-line" points={pts.join(' ')} />
                  ))}
                  {hover != null && s.values[hover] != null && (
                    <circle className="scaling-point" cx={x(years[hover])} cy={y(s.values[hover])} r={4.5} />
                  )}
                </g>
              )
            })}
            {labels &&
              ends.map((s) => (
                <text key={s.key} className="scaling-label" x={width - m.right + 10} y={s.ly + 4}>
                  {s.label} {s.value.toFixed(s.value >= 10 ? 0 : 1)}×
                </text>
              ))}
          </svg>
          {hover != null && (
            <div
              className="scaling-tooltip"
              style={{ left: Math.min(x(years[hover]) + 12, width - 220), top: 4 }}
            >
              <strong>{years[hover]}</strong>
              {SERIES.map((s) =>
                shown[hover][s.key] != null ? (
                  <div key={s.key}>
                    {s.label}: {s.fmt(shown[hover][s.key])}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function summarySentence(g, segment) {
  const aum = `AUM grew ${fmtMultiple(g.aumMultiple)}`.replace('grew −', 'fell ').replace('grew unchanged', 'was unchanged')
  const support = `non-advisory staff went from ${fmtCount(g.first.support)} to ${fmtCount(g.last.support)}`
  let out = `From ${g.first.year} to ${g.last.year}, ${aum} and ${support}.`
  if (g.expectedSupport != null && segment) {
    const seg = SEGMENT_BY_ID[segment]
    const expected = g.expectedSupport >= 10 ? Math.round(g.expectedSupport) : g.expectedSupport.toFixed(1)
    const ratio = g.last.support / g.expectedSupport
    const verdict =
      Math.abs(ratio - 1) < 0.15
        ? 'about the typical number'
        : ratio < 1
          ? `${Math.round((1 - ratio) * 100)}% fewer than typical`
          : ratio >= 2
            ? `${ratio.toFixed(1)} times the typical number`
            : `${Math.round((ratio - 1) * 100)}% more than typical`
    const who = segment === 'mixed' ? 'A firm with a mixed client base' : `A typical ${seg.label.toLowerCase()}`
    out += ` ${who} whose AUM changed that much over ${g.years} years would have about ${expected}, so this firm has ${verdict}.`
  }
  return out
}

export default function GrowthCard({ crd, segment }) {
  const data = useTrajectoryData(crd)
  const raw = firmTrajectory(data, crd)
  if (!raw) return null
  const points = withAdvisory(raw)
  const fit = segment ? data.segment_growth?.[segment] : null
  const g = growthSummary(points, fit, data.span_years)
  const baseYear = g ? g.first.year : points[0].year

  return (
    <section className="detail-card growth-card">
      <h2>Growth since {points[0].year}</h2>
      {g ? (
        <p className="leverage-trend growth-summary">{summarySentence(g, segment)}</p>
      ) : (
        <p className="detail-note">
          The firm reports no non-advisory staff in enough years to compare its growth.
        </p>
      )}
      <IndexChart points={points} baseYear={baseYear} />
      <details className="growth-table">
        <summary>Year by year</summary>
        <div className="scaling-table-wrap">
          <table className="pulse-table">
            <thead>
              <tr>
                <th>January</th>
                <th className="num">AUM</th>
                <th className="num">Employees</th>
                <th className="num">Non-advisory</th>
                <th className="num">Accounts</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.year}>
                  <td>{p.year}</td>
                  <td className="num">{fmtCompactUsd(p.aum)}</td>
                  <td className="num">{fmtCount(p.employees)}</td>
                  <td className="num">{fmtCount(p.support)}</td>
                  <td className="num">{fmtCount(p.accounts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="detail-note">
        From the SEC’s registered-adviser report published each January, which shows each firm’s
        latest Form ADV, usually filed the spring before. A firm that didn’t amend repeats its
        figures, and a missing year means it wasn’t SEC-registered that January. AUM moves with
        markets as well as new clients. The comparison is fitted on how firms with the same
        business model changed their own non-advisory staff over five-year spans as their AUM
        changed.
      </p>
    </section>
  )
}
