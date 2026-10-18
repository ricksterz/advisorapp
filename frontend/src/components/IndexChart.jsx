import { useRef, useState } from 'react'

import { useWidth } from './useWidth.js'

// Series indexed to 1× in `baseYear`, on one log axis: growth read as a
// multiple of where each series started, never against two y-scales. Used
// for a firm's AUM and staff (GrowthCard) and for several firms' AUM
// (ComparePage). rows: [{ year, [series.key]: value }]; series: [{ key,
// label, slot (categorical palette slot, 1-4), fmt }].
export default function IndexChart({ rows: points, series: defs, baseYear, describe }) {
  const wrap = useRef(null)
  const width = useWidth(wrap)
  const [hover, setHover] = useState(null)
  const shown = points.filter((p) => p.year >= baseYear)
  const base = shown[0]
  const series = defs.map((s) => ({
    ...s,
    values: shown.map((p) => (p[s.key] > 0 && base[s.key] > 0 ? p[s.key] / base[s.key] : null)),
  })).filter((s) => s.values.filter((v) => v != null).length > 1)
  const all = series.flatMap((s) => s.values.filter((v) => v != null))
  if (!all.length) return null

  const height = 220
  const labels = width >= 560
  // End labels read "Name 3.2×"; leave room for the longest, ~7.2px a character at 12px.
  const shortLabel = (label) => (label.length > 24 ? `${label.slice(0, 23)}…` : label)
  const labelRoom = Math.min(240, Math.max(...defs.map((d) => shortLabel(d.label).length + 6)) * 7.2 + 12)
  const m = { top: 12, right: labels ? labelRoom : 12, bottom: 28, left: 44 }
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
            aria-label={describe ?? `Values as multiples of their ${baseYear} level. They are listed in the table below.`}
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
                  {shortLabel(s.label)} {s.value.toFixed(s.value >= 10 ? 0 : 1)}×
                </text>
              ))}
          </svg>
          {hover != null && (
            <div
              className="scaling-tooltip"
              style={{ left: Math.min(x(years[hover]) + 12, width - 220), top: 4 }}
            >
              <strong>{years[hover]}</strong>
              {defs.map((s) =>
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
