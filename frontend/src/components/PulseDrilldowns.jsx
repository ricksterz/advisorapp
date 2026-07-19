import { navigate, pulsePath } from '../router.js'
import { MethodologyFootnote, PulseDisclaimer, TrendLine } from './PulsePage.jsx'
import { concentrationSeries, fmtCompactUsd, fmtCount, fmtPct, fmtQuarter, usePulseStats } from '../pulse.js'

function PulseBackLink() {
  const path = pulsePath()
  return (
    <a className="back-link" href={path} onClick={(e) => navigate(e, path)}>
      ← Industry Pulse
    </a>
  )
}

function DrilldownShell({ title, tagline, methodology, children }) {
  const stats = usePulseStats()
  if (stats === undefined) return <div className="state">Loading industry data…</div>
  if (stats === null) return <div className="state">Industry statistics are not available in this build.</div>
  return (
    <section className="pulse" aria-label={title}>
      <PulseBackLink />
      <div className="page-head">
        <h1>{title}</h1>
        <p className="page-tagline">
          {tagline} <span className="as-of">as of {fmtQuarter(stats.as_of)} · quarterly</span>
        </p>
        <PulseDisclaimer />
      </div>
      {children(stats)}
      <MethodologyFootnote metrics={methodology} />
    </section>
  )
}

const qLabel = (s) => fmtQuarter(s.quarter)

export function DrilldownAdvisers() {
  return (
    <DrilldownShell
      title="Adviser counts & growth"
      tagline="Registrations, withdrawals, and where advisers are based."
      methodology={['firms', 'registrations']}
    >
      {(stats) => {
        const { series, states } = stats
        const maxFirms = Math.max(...series.map((s) => s.firms))
        const maxState = Math.max(...states.map((s) => s.firms))
        return (
          <>
            <div className="detail-card">
              <h2>Active advisers by quarter</h2>
              <div className="pulse-bars">
                {series.map((s) => (
                  <div key={s.quarter} className="pattern-row">
                    <span className="pattern-label wide">{qLabel(s)}</span>
                    <span className="track">
                      <span className="fill" style={{ width: `${(s.firms / maxFirms) * 100}%` }} />
                    </span>
                    <span className="pattern-pct wide">{fmtCount(s.firms)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="detail-card">
              <h2>Appearances vs withdrawals</h2>
              <table className="pulse-table">
                <thead>
                  <tr><th>Quarter</th><th className="num">Appeared</th><th className="num">Disappeared</th><th className="num">ADV-W filings</th></tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.quarter}>
                      <td>{qLabel(s)}</td>
                      <td className="num">{fmtCount(s.appeared)}</td>
                      <td className="num">{fmtCount(s.disappeared)}</td>
                      <td className="num">{fmtCount(s.withdrawals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="detail-note">
                “Appeared”/“disappeared” compare consecutive quarter snapshots; ADV-W counts actual
                withdrawal filings. The measures come from different filings and need not agree.
              </p>
            </div>

            <div className="detail-card">
              <h2>Top states by adviser count</h2>
              <div className="pulse-bars">
                {states.map((st) => (
                  <div key={st.state} className="pattern-row">
                    <span className="pattern-label">{st.state}</span>
                    <span className="track">
                      <span className="fill" style={{ width: `${(st.firms / maxState) * 100}%` }} />
                    </span>
                    <span className="pattern-pct wide">{fmtCount(st.firms)}</span>
                    <TrendLine values={st.series} width={70} height={20} />
                  </div>
                ))}
              </div>
            </div>
          </>
        )
      }}
    </DrilldownShell>
  )
}

const BAND_ORDER = ['lt100m', '100m-1b', '1b-10b', '10b+']

export function DrilldownAssets() {
  return (
    <DrilldownShell
      title="Assets & AUM bands"
      tagline="The middle of the market, concentration at the top, and movement between size bands."
      methodology={['concentration', 'median_aum']}
    >
      {(stats) => {
        const { series, band_migration: migration } = stats
        const latest = series[series.length - 1]
        const shares = concentrationSeries(series)
        return (
          <>
            <div className="detail-card">
              <h2>Median firm AUM & concentration</h2>
              <table className="pulse-table">
                <thead>
                  <tr><th>Quarter</th><th className="num">Median firm AUM</th><th className="num">AUM share at $1B+ firms</th><th className="num">Firms</th></tr>
                </thead>
                <tbody>
                  {series.map((s, i) => (
                    <tr key={s.quarter}>
                      <td>{qLabel(s)}</td>
                      <td className="num">{fmtCompactUsd(s.median_aum)}</td>
                      <td className="num">{fmtPct(shares[i])}</td>
                      <td className="num">{fmtCount(s.firms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="detail-note">
                No gross AUM total is shown: summed regulatory AUM double-counts fund complexes
                and sub-advised assets, so a concentration ratio and the median are the honest
                scale measures here.
              </p>
            </div>

            <div className="detail-card">
              <h2>Firms by AUM band ({qLabel(latest)})</h2>
              <div className="pulse-bars">
                {latest.bands.map((b) => (
                  <div key={b.id} className="pattern-row">
                    <span className="pattern-label wide">{b.label}</span>
                    <span className="track">
                      <span
                        className="fill"
                        style={{ width: `${(b.firms / Math.max(...latest.bands.map((x) => x.firms))) * 100}%` }}
                      />
                    </span>
                    <span className="pattern-pct wide">{fmtCount(b.firms)}</span>
                  </div>
                ))}
              </div>
            </div>

            {migration && (
              <div className="detail-card">
                <h2>
                  Band migration, {fmtQuarter(migration.from_quarter)} → {fmtQuarter(migration.to_quarter)}
                </h2>
                <table className="pulse-table">
                  <thead>
                    <tr>
                      <th>From \ To</th>
                      {BAND_ORDER.map((b) => (
                        <th key={b} className="num">{latest.bands.find((x) => x.id === b)?.label ?? b}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {BAND_ORDER.map((from) => (
                      <tr key={from}>
                        <td>{latest.bands.find((x) => x.id === from)?.label ?? from}</td>
                        {BAND_ORDER.map((to) => {
                          const n = migration.matrix[from]?.[to] ?? 0
                          return (
                            <td key={to} className={`num ${from !== to && n > 0 ? 'migrated' : ''}`}>
                              {n ? fmtCount(n) : '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="detail-note">
                  Same firm observed in both quarters; off-diagonal cells are firms that changed
                  size band over the period.
                </p>
              </div>
            )}
          </>
        )
      }}
    </DrilldownShell>
  )
}
