import { navigate, pulsePath } from '../router.js'
import {
  PULSE_META,
  concentrationKpi,
  deltaView,
  fmtCompactUsd,
  fmtCount,
  fmtPct,
  fmtQuarter,
  usePulseStats,
} from '../pulse.js'
import { usePrivateFundStats } from '../privateFunds.js'
import { useIndividualDisclosureStats } from '../individualDisclosures.js'
import { fmtFormDQuarter, useFormDStats } from '../formD.js'
import { useServiceProviders } from '../serviceProviders.js'

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

// Private funds is a separate data file — fetched independently so a
// slow/missing file never blocks the rest of the Pulse page from rendering.
function PrivateFundsTile() {
  const stats = usePrivateFundStats()
  if (!stats) return null
  const topType = stats.fund_types[0]
  const qoq = deltaView(stats.fund_count_kpi?.qoq)
  const series = stats.series?.map((s) => s.total_funds)
  return (
    <CategoryTile
      section="private-funds"
      title="Private funds"
      stat={`${fmtCount(stats.total_funds)} funds across ${fmtCount(stats.total_firms)} advisers${qoq ? ` · ${qoq.arrow} ${qoq.text} QoQ` : ''} · most common: ${topType?.type ?? '—'}`}
      series={series}
    />
  )
}

// Individual-level breakdown is a separate industry-wide data file (the
// bulk feed's roster is independent of this site's much smaller advisor-bios
// roster) — fetched independently so a slow/missing file never blocks the
// rest of the Pulse page.
function DisclosuresTile() {
  const stats = useIndividualDisclosureStats()
  if (!stats) return null
  const topCategory = stats.categories[0]
  return (
    <CategoryTile
      section="disclosures"
      title="Disclosures"
      stat={`${fmtPct(stats.flagged_rate)} of ${fmtCount(stats.total_individuals)} individuals flagged · most common: ${topCategory?.label ?? '—'}`}
    />
  )
}

// Form D is filed continuously by issuers and lives on its own quarterly
// cadence, independent of the ADV-derived snapshots — fetched separately so a
// missing/stale file degrades to the previous "coming soon" state rather than
// blocking the KPI strip.
function FormDKpiCard() {
  const stats = useFormDStats()
  const meta = PULSE_META.form_d
  if (!stats) {
    return (
      <div className="kpi-card kpi-coming">
        <div className="label">{meta.label}</div>
        <div className="value">—</div>
        <div className="kpi-definition">{meta.definition}</div>
      </div>
    )
  }
  const kpi = stats.offerings_kpi
  return (
    <div className="kpi-card">
      <div className="label">{meta.label}</div>
      <div className="value">{fmtCount(kpi?.value)}</div>
      <div className="kpi-deltas">
        <Delta delta={kpi?.qoq} label="QoQ" />
        <Delta delta={kpi?.yoy} label="YoY" />
      </div>
      <div className="kpi-definition">{meta.definition}</div>
      <span className="as-of">as of {fmtFormDQuarter(stats.as_of)}</span>
    </div>
  )
}

function CapitalFormationTile() {
  const stats = useFormDStats()
  if (!stats) return null
  const latest = stats.series[stats.series.length - 1]
  const topType = stats.fund_types[0]
  return (
    <CategoryTile
      section="capital-formation"
      title="Capital formation"
      stat={`${fmtCount(latest.offerings)} new offerings · median ${fmtCompactUsd(latest.median_raised)} · most common fund type: ${topType?.type ?? '—'}`}
      series={stats.series.length > 1 ? stats.series.map((s) => s.offerings) : undefined}
    />
  )
}

// Schedule D 7.B.1's named providers — its own data file, fetched
// independently so a slow/missing file never blocks the rest of the page.
function ServiceProvidersTile() {
  const stats = useServiceProviders()
  if (!stats?.roles?.length) return null
  const auditors = stats.roles.find((r) => r.role === 'auditor') ?? stats.roles[0]
  const lead = auditors.providers[0]
  return (
    <CategoryTile
      section="service-providers"
      title="Service providers"
      stat={`${stats.roles.length} roles ranked · most-used ${auditors.label.toLowerCase().replace(/s$/, '')}: ${lead?.name ?? '—'} (${fmtCount(lead?.firms)} advisers)`}
    />
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
        <p>
          <strong>QoQ</strong> = quarter-over-quarter change (vs. the prior published quarter).{' '}
          <strong>YoY</strong> = year-over-year change (vs. four published quarters back).{' '}
          <strong>AUM</strong> = assets under management.
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
  const medianSeries = series.map((s) => s.median_aum)
  const concentration = concentrationKpi(series)

  return (
    <section className="pulse" aria-label="Industry Pulse">
      <div className="page-head">
        <h1>Industry Pulse</h1>
        <p className="page-tagline">The SEC-registered adviser industry, by the numbers.</p>
        <PulseDisclaimer />
      </div>

      <div className="kpi-strip">
        <KpiCard metric="firms" value={kpis.firms.value} kpi={kpis.firms} format={fmtCount} asOf={asOf} />
        <KpiCard metric="concentration" value={concentration.value} kpi={concentration} format={fmtPct} asOf={asOf} />
        <KpiCard metric="median_aum" value={kpis.median_aum.value} kpi={kpis.median_aum} format={fmtCompactUsd} asOf={asOf} />
        <KpiCard
          metric="pct_disclosure"
          value={kpis.pct_disclosure.value}
          kpi={kpis.pct_disclosure}
          format={fmtPct}
          goodWhenDown
          asOf={asOf}
        />
        <FormDKpiCard />
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
          stat={`median ${fmtCompactUsd(latest.median_aum)} · ${fmtPct(concentration.value)} of AUM at $1B+ firms`}
          series={medianSeries}
        />
        <PrivateFundsTile />
        <DisclosuresTile />
        <CapitalFormationTile />
        <ServiceProvidersTile />
      </div>

      <MethodologyFootnote metrics={['firms', 'concentration', 'median_aum', 'pct_disclosure', 'registrations']} />
    </section>
  )
}
