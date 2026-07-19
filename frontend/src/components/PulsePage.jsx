import { navigate, pulsePath } from '../router.js'
import {
  PULSE_META,
  deltaView,
  fmtCompactUsd,
  fmtCount,
  fmtPct,
  fmtQuarter,
  usePulseStats,
} from '../pulse.js'

function AsOfTag({ asOf }) {
  return <span className="as-of">as of {fmtQuarter(asOf)}</span>
}

function Delta({ delta, label, goodWhenDown }) {
  const v = deltaView(delta, { goodWhenDown })
  if (!v) return null
  return (
    <span className={`kpi-delta ${v.tone}`} title={`${label} change`}>
      <span aria-hidden="true">{v.arrow}</span> {v.text} {label}
    </span>
  )
}

function KpiCard({ metric, value, kpi, format, goodWhenDown, asOf }) {
  const meta = PULSE_META[metric]
  return (
    <div className="kpi-card">
      <div className="label">{meta.label}</div>
      <div className="value">{format(value)}</div>
      <div className="kpi-deltas">
        <Delta delta={kpi?.qoq} label="QoQ" goodWhenDown={goodWhenDown} />
        <Delta delta={kpi?.yoy} label="YoY" goodWhenDown={goodWhenDown} />
      </div>
      <div className="kpi-definition">{meta.definition}</div>
      <AsOfTag asOf={asOf} />
    </div>
  )
}

// Minimal SVG sparkline — quarterly series, no chart library by design.
export function TrendLine({ values, width = 120, height = 32 }) {
  const pts = values.filter((v) => v != null)
  if (pts.length < 2) return null
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const points = values
    .map((v, i) => (v == null ? null : `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ')
  return (
    <svg className="trend-line" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function CategoryTile({ section, title, stat, series }) {
  const path = pulsePath(section)
  return (
    <a className="pulse-tile" href={path} onClick={(e) => navigate(e, path)}>
      <div className="pulse-tile-head">
        <h3>{title}</h3>
        {series && <TrendLine values={series} />}
      </div>
      <p>{stat}</p>
    </a>
  )
}

export function PulseDisclaimer() {
  return (
    <p className="pulse-disclaimer">
      Open Disclosure is not affiliated with the SEC or FINRA. All statistics are derived from
      public regulatory filings, reconstructed on the cadence noted per module, and may lag
      official sources.
    </p>
  )
}

export function MethodologyFootnote({ metrics }) {
  return (
    <details className="methodology">
      <summary>Methodology</summary>
      <div className="method-body">
        {metrics.map((m) => (
          <p key={m}>
            <strong>{PULSE_META[m].label}.</strong> {PULSE_META[m].methodology}
          </p>
        ))}
        <p>
          Quarterly snapshots are published only when a quarter’s reconstructed universe reaches
          at least 93% of the newest quarter’s — earlier quarters in the archive window are
          structurally under-observed and would fabricate growth that is actually just improving
          coverage.
        </p>
      </div>
    </details>
  )
}

export default function PulsePage() {
  const stats = usePulseStats()
  if (stats === undefined) return <div className="state">Loading industry data…</div>
  if (stats === null) return <div className="state">Industry statistics are not available in this build.</div>

  const { kpis, series, as_of: asOf } = stats
  const latest = series[series.length - 1]
  const firmSeries = series.map((s) => s.firms)
  const raumSeries = series.map((s) => s.raum)

  return (
    <section className="pulse" aria-label="Industry Pulse">
      <div className="page-head">
        <h1>Industry Pulse</h1>
        <p className="page-tagline">The SEC-registered adviser industry, by the numbers.</p>
        <PulseDisclaimer />
      </div>

      <div className="kpi-strip">
        <KpiCard metric="firms" value={kpis.firms.value} kpi={kpis.firms} format={fmtCount} asOf={asOf} />
        <KpiCard metric="raum" value={kpis.raum.value} kpi={kpis.raum} format={fmtCompactUsd} asOf={asOf} />
        <KpiCard metric="median_aum" value={kpis.median_aum.value} kpi={kpis.median_aum} format={fmtCompactUsd} asOf={asOf} />
        <KpiCard
          metric="pct_disclosure"
          value={kpis.pct_disclosure.value}
          kpi={kpis.pct_disclosure}
          format={fmtPct}
          goodWhenDown
          asOf={asOf}
        />
        <div className="kpi-card kpi-coming">
          <div className="label">{PULSE_META.form_d.label}</div>
          <div className="value">—</div>
          <div className="kpi-definition">{PULSE_META.form_d.definition}</div>
        </div>
      </div>

      <div className="pulse-tiles">
        <CategoryTile
          section="advisers"
          title="Adviser counts & growth"
          stat={`${fmtCount(latest.appeared)} appeared, ${fmtCount(latest.withdrawals)} withdrew last quarter`}
          series={firmSeries}
        />
        <CategoryTile
          section="assets"
          title="Assets & AUM bands"
          stat={`${fmtCompactUsd(latest.raum)} aggregate · median ${fmtCompactUsd(latest.median_aum)}`}
          series={raumSeries}
        />
      </div>

      <MethodologyFootnote metrics={['firms', 'raum', 'median_aum', 'pct_disclosure', 'registrations']} />
    </section>
  )
}
