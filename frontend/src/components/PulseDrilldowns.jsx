import { firmPath, navigate, pulsePath } from '../router.js'
import { MethodologyFootnote, PulseDisclaimer, TrendLine } from './PulsePage.jsx'
import { concentrationSeries, deltaView, fmtCompactUsd, fmtCount, fmtPct, fmtQuarter, usePulseStats } from '../pulse.js'
import { PROVIDER_ROLE_LABELS, usePrivateFundStats } from '../privateFunds.js'
import { useIndividualDisclosureStats } from '../individualDisclosures.js'

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

export function DrilldownPrivateFunds() {
  const stats = usePrivateFundStats()
  if (stats === undefined) return <div className="state">Loading industry data…</div>
  if (stats === null) return <div className="state">Industry statistics are not available in this build.</div>

  const {
    fund_types: fundTypes,
    domicile,
    top_firms: topFirms,
    providers,
    total_funds: totalFunds,
    total_firms: totalFirms,
    quarters,
    series,
    fund_count_kpi: fundCountKpi,
  } = stats
  const maxTypeCount = Math.max(...fundTypes.map((t) => t.count))
  const maxDomicileCount = Math.max(...domicile.map((d) => d.count))
  const qoq = deltaView(fundCountKpi?.qoq)
  const yoy = deltaView(fundCountKpi?.yoy)
  const maxSeriesCount = series?.length ? Math.max(...series.map((s) => s.total_funds)) : 0

  return (
    <section className="pulse" aria-label="Private funds">
      <PulseBackLink />
      <div className="page-head">
        <h1>Private funds</h1>
        <p className="page-tagline">
          {fmtCount(totalFunds)} funds across {fmtCount(totalFirms)} advisers, from Form ADV Schedule
          D 7.B.1. <span className="as-of">as of {stats.as_of}</span>
        </p>
        <PulseDisclaimer />
      </div>

      {series?.length > 1 && (
        <div className="detail-card">
          <h2>
            Fund count by quarter
            {qoq && (
              <span className={`kpi-delta ${qoq.tone}`} title="Fund count change">
                {' '}
                <span aria-hidden="true">{qoq.arrow}</span> {qoq.text} QoQ
              </span>
            )}
            {yoy && (
              <span className={`kpi-delta ${yoy.tone}`} title="Fund count change">
                {' '}
                <span aria-hidden="true">{yoy.arrow}</span> {yoy.text} YoY
              </span>
            )}
          </h2>
          <div className="pulse-bars">
            {series.map((s) => (
              <div key={s.quarter} className="pattern-row">
                <span className="pattern-label wide">{fmtQuarter(s.quarter)}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${(s.total_funds / maxSeriesCount) * 100}%` }} />
                </span>
                <span className="pattern-pct wide">{fmtCount(s.total_funds)}</span>
              </div>
            ))}
          </div>
          <p className="detail-note">
            Published for the same {quarters?.length ?? 0} quarters as the rest of Industry Pulse —
            gated on the same completeness threshold (see the main Pulse page's Methodology), not
            recomputed separately for private funds.
          </p>
        </div>
      )}

      <div className="detail-card">
        <h2>Funds by type</h2>
        <div className="pulse-bars">
          {fundTypes.map((t) => (
            <div key={t.type} className="pattern-row">
              <span className="pattern-label wide">{t.type}</span>
              <span className="track">
                <span className="fill" style={{ width: `${(t.count / maxTypeCount) * 100}%` }} />
              </span>
              <span className="pattern-pct wide">
                {fmtCount(t.count)} · {fmtCompactUsd(t.gav)} median {fmtCompactUsd(t.median_gav)}
              </span>
            </div>
          ))}
        </div>
        <p className="detail-note">
          No total gross asset value is shown across fund types: a fund complex's master fund and its
          feeder funds both report GAV for largely the same underlying capital (~4% of total GAV in a
          real pull), so feeder funds are excluded from every GAV figure here. A fund whose adviser
          discloses it as a subadviser could in theory also appear on another firm's schedule — a
          smaller, unresolved edge case.
        </p>
      </div>

      <div className="detail-card">
        <h2>Fund domicile</h2>
        <div className="pulse-bars">
          {domicile.map((d) => (
            <div key={d.domicile} className="pattern-row">
              <span className="pattern-label wide">{d.domicile}</span>
              <span className="track">
                <span className="fill" style={{ width: `${(d.count / maxDomicileCount) * 100}%` }} />
              </span>
              <span className="pattern-pct wide">{fmtCount(d.count)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-card">
        <h2>Advisers by number of funds</h2>
        <table className="pulse-table">
          <thead>
            <tr><th>Adviser</th><th className="num">Funds</th><th className="num">GAV</th></tr>
          </thead>
          <tbody>
            {topFirms.map((f) => (
              <tr key={f.crd}>
                <td>
                  {f.name ? (
                    <a href={firmPath(f.crd)} onClick={(e) => navigate(e, firmPath(f.crd))}>
                      {f.name}
                    </a>
                  ) : (
                    `CRD ${f.crd}`
                  )}
                </td>
                <td className="num">{fmtCount(f.fund_count)}</td>
                <td className="num">{fmtCompactUsd(f.gav)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="detail-card">
        <h2>Service-provider concentration</h2>
        <div className="provider-leagues">
          {Object.entries(providers).map(([role, list]) => (
            <div key={role} className="provider-league">
              <h3>{PROVIDER_ROLE_LABELS[role] ?? role}</h3>
              <ol>
                {list.map((p) => (
                  <li key={p.name}>
                    <span>{p.name}</span>
                    <span className="pattern-pct">{fmtCount(p.fund_count)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <p className="detail-note">
          Ranked by number of funds naming that provider (not assets serviced). Provider names are
          normalized to collapse legal-suffix variants of the same firm (“KPMG LLP” / “KPMG, LLP” /
          “KPMG”) for grouping only — the underlying data keeps each filing’s exact wording.
        </p>
      </div>

      <p className="pulse-disclaimer">
        Fund counts and GAV reflect each adviser’s most recent Schedule D 7.B.1 filing on file,
        not a live feed — see the Methodology note on the main Industry Pulse page for how ADV
        filings are reconstructed into a point-in-time view.
      </p>
    </section>
  )
}

export function DrilldownDisclosures() {
  const pulseStats = usePulseStats()
  const indvlStats = useIndividualDisclosureStats()
  if (pulseStats === undefined || indvlStats === undefined) return <div className="state">Loading industry data…</div>
  if (pulseStats === null) return <div className="state">Industry statistics are not available in this build.</div>

  const { series, as_of: asOf } = pulseStats
  const maxCategoryShare = indvlStats
    ? Math.max(...indvlStats.categories.map((c) => c.pct_of_individuals ?? 0))
    : 0

  return (
    <section className="pulse" aria-label="Disclosures">
      <PulseBackLink />
      <div className="page-head">
        <h1>Disclosures</h1>
        <p className="page-tagline">
          Firm-level trends from Form ADV Item 11, and individual-level category breakdown from
          the SEC’s bulk adviser feed. <span className="as-of">as of {fmtQuarter(asOf)}</span>
        </p>
        <PulseDisclaimer />
      </div>

      <div className="detail-card">
        <h2>Firms with a disclosure event, by quarter</h2>
        <table className="pulse-table">
          <thead>
            <tr><th>Quarter</th><th className="num">Share of firms</th><th className="num">Firms</th></tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.quarter}>
                <td>{fmtQuarter(s.quarter)}</td>
                <td className="num">{fmtPct(s.pct_disclosure)}</td>
                <td className="num">{fmtCount(s.firms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="detail-note">
          “Disclosures” counts affirmative answers to Form ADV Item 11 — criminal, regulatory, and
          civil-judicial events, including matters that were settled, dismissed, or involve
          affiliates rather than the firm itself. A disclosure is a reason to read the underlying
          record, not a finding of wrongdoing.
        </p>
      </div>

      {indvlStats && (
        <div className="detail-card">
          <h2>Individual-level disclosure categories</h2>
          <p className="detail-note">
            {fmtPct(indvlStats.flagged_rate)} of {fmtCount(indvlStats.total_individuals)} individuals in
            the SEC’s bulk adviser feed have at least one flagged category, as of {indvlStats.as_of}.
          </p>
          <div className="pulse-bars">
            {indvlStats.categories.map((c) => (
              <div key={c.key} className="pattern-row">
                <span className="pattern-label wide">{c.label}</span>
                <span className="track">
                  <span
                    className="fill"
                    style={{ width: `${((c.pct_of_individuals ?? 0) / maxCategoryShare) * 100}%` }}
                  />
                </span>
                <span className="pattern-pct wide">
                  {fmtCount(c.count)} · {fmtPct(c.pct_of_individuals)}
                </span>
              </div>
            ))}
          </div>
          <p className="detail-note">
            From the SEC’s bulk individual-adviser feed: Y/N category flags only, no narrative,
            date, or dollar detail, and not a count of distinct events — a person flagged for
            “Customer complaint” may have one or many. Each category is a share of every
            individual in the feed, not just the flagged ones. Real detail lives on each
            individual’s IAPD summary page, linked from the disclosure badge on their firm’s
            Advisor bios card.
          </p>
        </div>
      )}
    </section>
  )
}
