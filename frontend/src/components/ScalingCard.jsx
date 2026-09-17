import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { leverageIndex, MIN_BIN_FIRMS, scalingCurves } from '../leverage.js'
import { fmtCompactUsd, fmtCount } from '../pulse.js'
import { SEGMENT_BY_ID, SEGMENTS } from '../segments.js'

// Four segments on the chart, in the palette's fixed order. "Mixed" is only
// ~200 firms, too few to draw a curve across sizes; it stays in the table.
const CHARTED = ['wealth', 'private_funds', 'institutional', 'registered_funds']

function useWidth(ref) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return undefined
    // Measure now: ResizeObserver's first callback waits for the next frame,
    // which a backgrounded tab may not paint for a long time.
    setWidth(Math.floor(ref.current.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref])
  return width
}

const X_TICKS = [1e7, 1e8, 1e9, 1e10, 1e11, 1e12]
const Y_TICKS = [1, 10, 100, 1000, 10000]
const fmtTickUsd = (v) => (v >= 1e12 ? `$${v / 1e12}T` : v >= 1e9 ? `$${v / 1e9}B` : `$${v / 1e6}M`)
const fmtStaff = (v) => (v >= 10 ? fmtCount(v) : v.toFixed(1).replace(/\.0$/, ''))

function Chart({ curves }) {
  const wrap = useRef(null)
  const width = useWidth(wrap)
  const [hover, setHover] = useState(null)

  const series = CHARTED.map((id, i) => ({ id, slot: i + 1, points: curves[id] ?? [] })).filter(
    (s) => s.points.length > 1,
  )
  const all = series.flatMap((s) => s.points)
  const height = 300
  const labels = width >= 560
  const m = { top: 16, right: labels ? 170 : 16, bottom: 34, left: 52 }
  if (!all.length) return null

  const xMin = Math.min(...all.map((p) => p.aum)) / 1.4
  const xMax = Math.max(...all.map((p) => p.aum)) * 1.4
  const yMin = Math.max(0.5, Math.min(...all.map((p) => p.staff)) / 1.5)
  const yMax = Math.max(...all.map((p) => p.staff)) * 1.5
  const log = Math.log10
  const x = (v) => m.left + ((log(v) - log(xMin)) / (log(xMax) - log(xMin))) * (width - m.left - m.right)
  const y = (v) => m.top + (1 - (log(v) - log(yMin)) / (log(yMax) - log(yMin))) * (height - m.top - m.bottom)

  // Direct labels in one column right of the longest line, level with each
  // line's end and nudged apart vertically so they never overlap.
  const labelX = Math.max(...series.map((s) => x(s.points[s.points.length - 1].aum))) + 12
  const ends = series
    .map((s) => ({ ...s, ly: y(s.points[s.points.length - 1].staff) }))
    .sort((a, b) => a.ly - b.ly)
  for (let i = 1; i < ends.length; i += 1) {
    ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + 15)
  }

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    let best = null
    for (const s of series) {
      for (const p of s.points) {
        const d = Math.hypot(x(p.aum) - px, y(p.staff) - py)
        if (d < 22 && (!best || d < best.d)) best = { d, s, p }
      }
    }
    setHover(best)
  }

  return (
    <div className="scaling-chart" ref={wrap}>
      <div className="scaling-legend">
        {series.map((s) => (
          <span key={s.id} className="scaling-legend-item">
            <span className={`scaling-swatch series-${s.slot}`} />
            {SEGMENT_BY_ID[s.id].label}s
          </span>
        ))}
      </div>
      <p className="scaling-y-note">↑ Median non-advisory employees (log scale)</p>
      {width > 0 && (
        <div className="scaling-plot">
          <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
            aria-label="Median non-advisory staff by AUM for each business model, log scales. Values are listed in the table below.">
            {X_TICKS.filter((t) => t >= xMin && t <= xMax).map((t) => (
              <g key={`x${t}`}>
                <line className="scaling-grid" x1={x(t)} x2={x(t)} y1={m.top} y2={height - m.bottom} />
                <text className="scaling-tick" x={x(t)} y={height - m.bottom + 18} textAnchor="middle">
                  {fmtTickUsd(t)}
                </text>
              </g>
            ))}
            {Y_TICKS.filter((t) => t >= yMin && t <= yMax).map((t) => (
              <g key={`y${t}`}>
                <line className="scaling-grid" x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
                <text className="scaling-tick" x={m.left - 8} y={y(t) + 4} textAnchor="end">
                  {fmtCount(t)}
                </text>
              </g>
            ))}
            <text className="scaling-axis" x={width - m.right} y={height - 2} textAnchor="end">
              AUM (log scale) →
            </text>
            {series.map((s) => (
              <g key={s.id} className={`series-${s.slot}`}>
                <polyline
                  className="scaling-line"
                  points={s.points.map((p) => `${x(p.aum)},${y(p.staff)}`).join(' ')}
                />
                {s.points.map((p) => (
                  <circle key={p.aum} className="scaling-point" cx={x(p.aum)} cy={y(p.staff)} r={hover?.p === p ? 5.5 : 4} />
                ))}
              </g>
            ))}
            {labels &&
              ends.map((s) => (
                <text key={s.id} className="scaling-label" x={labelX} y={s.ly + 4}>
                  {SEGMENT_BY_ID[s.id].label}s
                </text>
              ))}
          </svg>
          {hover && (
            <div
              className="scaling-tooltip"
              style={{
                left: Math.min(x(hover.p.aum) + 12, width - 220),
                top: Math.max(0, y(hover.p.staff) - 64),
              }}
            >
              <strong>{SEGMENT_BY_ID[hover.s.id].label}s</strong>
              <br />
              {fmtCompactUsd(hover.p.aum / 10 ** 0.25)}–{fmtCompactUsd(hover.p.aum * 10 ** 0.25)} AUM
              <br />
              median {fmtStaff(hover.p.staff)} non-advisory staff · {fmtCount(hover.p.n)} firms
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ScalingCard({ firms }) {
  const view = useMemo(() => {
    if (!firms?.length) return null
    return { index: leverageIndex(firms), curves: scalingCurves(firms) }
  }, [firms])
  if (!view) return null
  const { segments } = view.index

  return (
    <section className="detail-card scaling-card" aria-labelledby="scaling-title">
      <h2 id="scaling-title">Operational leverage by business model</h2>
      <p className="detail-note scaling-intro">
        How support headcount grows with assets. Non-advisory employees handle operations,
        compliance, client service and support. Larger firms run leaner per dollar, but the rate
        differs by business model.
      </p>
      <Chart curves={view.curves} />
      <div className="scaling-table-wrap">
        <table className="pulse-table">
          <thead>
            <tr>
              <th>Business model</th>
              <th className="num">Firms</th>
              <th className="num">Twice the AUM</th>
              <th className="num">Median AUM per non-advisory employee</th>
              <th className="num">Middle half</th>
              <th className="num">No non-advisory staff</th>
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((seg) => {
              const e = segments[seg.id]
              if (!e.firms) return null
              const d = e.all.aumPer
              return (
                <tr key={seg.id}>
                  <td title={seg.description}>{seg.label}</td>
                  <td className="num">{fmtCount(e.firms)}</td>
                  <td className="num">{e.fit ? `+${Math.round(e.fit.doubling * 100)}% staff` : '—'}</td>
                  <td className="num">{fmtCompactUsd(d.median)}</td>
                  <td className="num">
                    {fmtCompactUsd(d.p25)}–{fmtCompactUsd(d.p75)}
                  </td>
                  <td className="num">{Math.round((e.zeroStaff / e.firms) * 100)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="detail-note">
        Business model comes from where each firm says its AUM comes from (Form ADV Item 5.D).
        “Twice the AUM” is a log-log trend fitted across each model’s firms: how many more
        non-advisory staff a firm twice the size typically has. It compares firms of different
        sizes at one point in time, not how any firm grew. Firms with no non-advisory staff can’t
        be placed on a log scale, so they are counted in the last column and left out of the chart,
        the trend and the medians. Chart points are the median across firms in each half-decade of
        AUM, where at least {MIN_BIN_FIRMS} firms report. Each firm’s own comparison is on its
        profile page.
      </p>
    </section>
  )
}
