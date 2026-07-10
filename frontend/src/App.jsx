import { useEffect, useMemo, useState } from 'react'

const compactUsd = (v) => {
  if (v == null || Number.isNaN(v)) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(v >= 1e13 ? 0 : 1)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  return `$${Math.round(v).toLocaleString()}`
}

const compactCount = (v) =>
  v == null ? '—' : v >= 10000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString()

const iapdUrl = (crd) => `https://adviserinfo.sec.gov/firm/summary/${crd}`

const AUM_PRESETS = [
  { label: 'Any AUM', min: 0 },
  { label: '≥ $100M', min: 1e8 },
  { label: '≥ $1B', min: 1e9 },
  { label: '≥ $10B', min: 1e10 },
  { label: '≥ $100B', min: 1e11 },
]

const SORTS = {
  firm: (a, b) => (a.business_name || a.legal_name).localeCompare(b.business_name || b.legal_name),
  aum: (a, b) => (b.aum_total ?? -1) - (a.aum_total ?? -1),
  staff: (a, b) => (b.employees_advisory ?? -1) - (a.employees_advisory ?? -1),
  flags: (a, b) => (b.disciplinary_flag_count ?? 0) - (a.disciplinary_flag_count ?? 0),
}

const PAGE = 25

// Third-party rankings and research the methodology is benchmarked against.
const SOURCES = [
  { name: 'Barron’s Top Advisors', url: 'https://www.barrons.com/report/top-financial-advisors' },
  { name: 'CNBC FA 100', url: 'https://www.cnbc.com/fa-100/' },
  { name: 'Forbes / SHOOK Top Wealth Advisors', url: 'https://www.forbes.com/top-wealth-advisors/' },
  { name: 'UBS Global Family Office Report', url: 'https://www.ubs.com/global/en/family-office-uhnw.html' },
  { name: 'Visual Capitalist — wealth management', url: 'https://www.visualcapitalist.com/' },
]

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])
  return [theme, setTheme]
}

// Rank-based percentile function over a numeric sample.
function percentiler(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  return (v) => {
    if (!Number.isFinite(v) || s.length < 2) return 0
    let lo = 0
    let hi = s.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (s[mid] <= v) lo = mid + 1
      else hi = mid
    }
    return lo / s.length
  }
}

const staffOf = (f) => f.employees_advisory ?? f.employees_total ?? null

/**
 * Composite standing/risk scores from Form ADV fields, modeled on how the
 * major third-party rankings screen firms (see the on-page methodology).
 */
function computeRankings(firms) {
  const universe = firms.filter((f) => (f.aum_total ?? 0) >= 1e8)
  const pAum = percentiler(universe.map((f) => f.aum_total))
  const pProd = percentiler(
    universe.map((f) => (staffOf(f) > 0 ? f.aum_total / staffOf(f) : NaN)),
  )
  const loads = universe.map((f) => (staffOf(f) > 0 ? (f.accounts_total ?? NaN) / staffOf(f) : NaN))
  const pLoad = percentiler(loads)

  const top = universe
    .filter((f) => f.disciplinary_flag_count === 0 && staffOf(f) >= 3)
    .map((f) => {
      const feeAlign = f.fee_pct_of_aum ? (f.fee_commissions ? 0.5 : 1) : 0
      const score =
        100 * (0.4 * pAum(f.aum_total) + 0.25 * pProd(f.aum_total / staffOf(f)) + 0.2 + 0.15 * feeAlign)
      return { firm: f, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  const atRisk = universe
    .map((f) => {
      const signals = []
      let score = 0
      if (f.disciplinary_flag_count > 0) {
        score += Math.min(f.disciplinary_flag_count, 4) * 15
        signals.push(`${f.disciplinary_flag_count} disclosure${f.disciplinary_flag_count > 1 ? 's' : ''}`)
      }
      if (f.fee_commissions && f.fee_performance_based) {
        score += 15
        signals.push('Commissions + performance fees')
      }
      if ((f.affil_count ?? 0) >= 3) {
        score += 10
        signals.push('Dense affiliations')
      }
      const load = staffOf(f) > 0 ? (f.accounts_total ?? 0) / staffOf(f) : null
      if (load != null && pLoad(load) >= 0.95) {
        score += 15
        signals.push('High client load')
      }
      return { firm: f, score, signals }
    })
    .filter((r) => r.score >= 40)
    .sort((a, b) => b.score - a.score || (b.firm.aum_total ?? 0) - (a.firm.aum_total ?? 0))
    .slice(0, 10)

  return { top, atRisk }
}

function StatTile({ label, value, sub }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

function DiscretionaryMeter({ firm }) {
  const total = firm.aum_total
  if (!total) return <span className="flag-none">—</span>
  const share = Math.max(0, Math.min(1, (firm.aum_discretionary ?? 0) / total))
  return (
    <span className="meter" title="Discretionary share of regulatory AUM">
      <span className="track">
        <span className="fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="pct">{Math.round(share * 100)}%</span>
    </span>
  )
}

function SortHeader({ id, children, sort, onSort, className }) {
  const active = sort === id
  return (
    <th className={className} aria-sort={active ? 'descending' : undefined}>
      <button type="button" onClick={() => onSort(id)}>
        {children}
        {active && <span className="arrow">▼</span>}
      </button>
    </th>
  )
}

function FirmLink({ firm }) {
  return (
    <a className="firm-link" href={iapdUrl(firm.crd)} target="_blank" rel="noreferrer">
      {firm.business_name || firm.legal_name}
    </a>
  )
}

function RankCard({ title, sub, children }) {
  return (
    <div className="rank-card">
      <div className="rank-head">
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      {children}
    </div>
  )
}

export default function App() {
  const [theme, setTheme] = useTheme()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [minAum, setMinAum] = useState(0)
  const [perfOnly, setPerfOnly] = useState(false)
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [sort, setSort] = useState('aum')
  const [limit, setLimit] = useState(PAGE)

  useEffect(() => {
    // Static snapshot exported by the ETL; all filtering happens client-side.
    fetch(`${import.meta.env.BASE_URL}firms.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`failed to load firms.json (${r.status})`)))
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [])

  const stats = useMemo(() => {
    if (!data) return null
    const aums = data.firms.map((f) => f.aum_total).filter((v) => v > 0).sort((a, b) => a - b)
    const totalAum = aums.reduce((s, v) => s + v, 0)
    const median = aums.length ? aums[Math.floor(aums.length / 2)] : null
    const perfShare = data.firms.filter((f) => f.fee_performance_based).length / data.firms.length
    const flagged = data.firms.filter((f) => f.disciplinary_flag_count > 0).length
    return { totalAum, median, perfShare, flagged }
  }, [data])

  const rankings = useMemo(() => (data ? computeRankings(data.firms) : null), [data])

  const firms = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.firms
      .filter((f) => {
        if (minAum && (f.aum_total ?? 0) < minAum) return false
        if (perfOnly && !f.fee_performance_based) return false
        if (flaggedOnly && !(f.disciplinary_flag_count > 0)) return false
        if (!q) return true
        return (
          (f.legal_name || '').toLowerCase().includes(q) ||
          (f.business_name || '').toLowerCase().includes(q) ||
          String(f.crd).startsWith(q)
        )
      })
      .sort(SORTS[sort])
  }, [data, query, minAum, perfOnly, flaggedOnly, sort])

  const visible = firms.slice(0, limit)
  const resetPage = () => setLimit(PAGE)

  return (
    <>
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">A</span>
          Advisor Analytics
        </span>
        <span className="spacer" />
        {data && <span className="snapshot">SEC Form ADV · snapshot {data.generated_at.slice(0, 10)}</span>}
        <button
          type="button"
          className="icon-btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle color theme"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      <main className="shell">
        <section className="page-head">
          <h1>Investment adviser benchmarking</h1>
          <p>
            Every SEC-registered advisory firm — assets under management, compensation structure,
            and disciplinary history — built from public Form ADV filings.
          </p>
        </section>

        {error && <div className="state error">{error}</div>}
        {!error && !data && <div className="state">Loading firm data…</div>}

        {stats && (
          <section className="tiles" aria-label="Industry totals">
            <StatTile label="Firms tracked" value={compactCount(data.count)} sub="SEC-registered advisers" />
            <StatTile label="Regulatory AUM" value={compactUsd(stats.totalAum)} sub="sum of reported RAUM" />
            <StatTile label="Median firm AUM" value={compactUsd(stats.median)} />
            <StatTile
              label="Performance-based fees"
              value={`${Math.round(stats.perfShare * 100)}%`}
              sub="of firms charge them"
            />
            <StatTile
              label="Disciplinary disclosures"
              value={compactCount(stats.flagged)}
              sub="firms with ≥ 1 flag"
            />
          </section>
        )}

        {rankings && (
          <section className="rankings" aria-label="Rankings">
            <div className="section-head">
              <h2>Standing &amp; risk screens</h2>
              <p>
                A transparent, purely quantitative read on firm standing — modeled on how Barron’s,
                CNBC’s FA 100, and Forbes/SHOOK screen advisors, but computed only from public
                Form ADV data.
              </p>
            </div>

            <div className="rank-grid">
              <RankCard
                title="Top advisory firms"
                sub="Clean record required · ≥ $100M AUM · ≥ 3 advisory professionals"
              >
                <ol className="rank-list">
                  {rankings.top.map(({ firm, score }, i) => (
                    <li key={firm.crd}>
                      <span className="rank-n">{i + 1}</span>
                      <span className="rank-firm">
                        <FirmLink firm={firm} />
                        <span className="firm-sub">
                          {compactUsd(firm.aum_total)} AUM · {staffOf(firm)} advisory staff
                        </span>
                      </span>
                      <span className="score-badge" title="Composite standing score (0–100)">
                        {score.toFixed(1)}
                      </span>
                    </li>
                  ))}
                </ol>
              </RankCard>

              <RankCard
                title="Elevated-risk signals"
                sub="Firms ≥ $100M AUM tripping two or more risk screens"
              >
                {rankings.atRisk.length === 0 ? (
                  <div className="state">No firms currently trip the risk threshold.</div>
                ) : (
                  <ol className="rank-list">
                    {rankings.atRisk.map(({ firm, score, signals }) => (
                      <li key={firm.crd}>
                        <span className="rank-n risk">⚑</span>
                        <span className="rank-firm">
                          <FirmLink firm={firm} />
                          <span className="signal-chips">
                            {signals.map((s) => (
                              <span key={s} className="signal-chip">{s}</span>
                            ))}
                          </span>
                        </span>
                        <span className="score-badge risk" title="Risk signal score (0–100)">
                          {score}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </RankCard>
            </div>

            <details className="methodology">
              <summary>Methodology &amp; how it compares to third-party rankings</summary>
              <div className="method-body">
                <p>
                  <strong>Standing score (0–100).</strong> Firms must first pass the screens the
                  major rankings apply: a clean Item 11 record (no disciplinary disclosures — the
                  same hard compliance screen Forbes/SHOOK and CNBC’s FA 100 apply), at least $100M
                  in regulatory AUM, and at least three advisory professionals. Eligible firms are
                  then scored: <em>40% scale</em> (percentile of total regulatory AUM),{' '}
                  <em>25% productivity</em> (percentile of AUM per advisory professional — akin to
                  the assets-and-revenue weighting in Barron’s rankings), <em>20% clean record</em>{' '}
                  (earned by passing the screen), and <em>15% fee alignment</em> (asset-based fees,
                  reduced when commission compensation is also reported).
                </p>
                <p>
                  <strong>Risk signals (0–100).</strong> Inspired by the regulatory-record and
                  practice-quality factors those rankings penalize: Item 11 disciplinary
                  disclosures (15 points each, capped at four), commission <em>and</em>{' '}
                  performance-fee compensation together (15 — stacked conflict exposure), three or
                  more financial-industry affiliations (10 — larger conflict surface), and an
                  accounts-per-professional ratio in the top 5% (15 — service-capacity strain, the
                  inverse of the advisor-to-client ratios CNBC’s methodology rewards). Firms
                  scoring 40+ are listed.
                </p>
                <p>
                  <strong>Where it differs.</strong> Barron’s, CNBC (with AccuPoint Solutions), and
                  Forbes (with SHOOK Research) blend quantitative screens with surveys, interviews,
                  and qualitative practice reviews, and largely rank individual advisors or teams.
                  This screen is firm-level, fully reproducible, and uses only what firms report on
                  Form ADV — so treat it as a starting point for diligence, not a substitute for
                  those lists. Context on the ultra-high-net-worth segment draws on the UBS Global
                  Family Office Report and Visual Capitalist’s wealth-management research.
                </p>
                <p className="method-sources">
                  Benchmarked against:{' '}
                  {SOURCES.map((s, i) => (
                    <span key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
                      {i < SOURCES.length - 1 ? ' · ' : ''}
                    </span>
                  ))}
                </p>
              </div>
            </details>
          </section>
        )}

        {data && (
          <>
            <section className="section-head">
              <h2>All firms</h2>
            </section>
            <section className="controls" aria-label="Filters">
              <span className="search">
                <span className="glyph">⌕</span>
                <input
                  placeholder="Search by firm name or CRD"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); resetPage() }}
                />
              </span>
              <select
                value={minAum}
                onChange={(e) => { setMinAum(Number(e.target.value)); resetPage() }}
                aria-label="Minimum AUM"
              >
                {AUM_PRESETS.map((p) => (
                  <option key={p.min} value={p.min}>{p.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="chip"
                aria-pressed={perfOnly}
                onClick={() => { setPerfOnly(!perfOnly); resetPage() }}
              >
                Performance fees
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={flaggedOnly}
                onClick={() => { setFlaggedOnly(!flaggedOnly); resetPage() }}
              >
                Has disclosures
              </button>
              <span className="result-count">
                {firms.length.toLocaleString()} of {data.count.toLocaleString()} firms
              </span>
            </section>

            <section className="table-card">
              <table>
                <thead>
                  <tr>
                    <SortHeader id="firm" sort={sort} onSort={setSort}>Firm</SortHeader>
                    <SortHeader id="aum" sort={sort} onSort={setSort} className="num">Total AUM</SortHeader>
                    <th>Discretionary</th>
                    <SortHeader id="staff" sort={sort} onSort={setSort} className="num">Advisory staff</SortHeader>
                    <th>Fee structure</th>
                    <th className="num">Affiliations</th>
                    <SortHeader id="flags" sort={sort} onSort={setSort} className="num">Disclosures</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((f) => (
                    <tr key={f.crd}>
                      <td>
                        <div className="firm-name">{f.business_name || f.legal_name}</div>
                        <div className="firm-sub">
                          <a className="crd-link" href={iapdUrl(f.crd)} target="_blank" rel="noreferrer">
                            CRD {f.crd}
                          </a>
                        </div>
                      </td>
                      <td className="num">{compactUsd(f.aum_total)}</td>
                      <td><DiscretionaryMeter firm={f} /></td>
                      <td className="num">{f.employees_advisory ?? f.employees_total ?? '—'}</td>
                      <td>
                        <span className="fee-chips">
                          {f.fee_pct_of_aum && <span className="fee-chip">% of AUM</span>}
                          {f.fee_performance_based && <span className="fee-chip">Performance</span>}
                          {f.fee_commissions && <span className="fee-chip">Commissions</span>}
                          {!f.fee_pct_of_aum && !f.fee_performance_based && !f.fee_commissions && (
                            <span className="flag-none">—</span>
                          )}
                        </span>
                      </td>
                      <td className="num">{f.affil_count || <span className="flag-none">0</span>}</td>
                      <td className="num">
                        {f.disciplinary_flag_count > 0 ? (
                          <span className="flag-badge" title="Item 11 disciplinary disclosures">
                            ⚑ {f.disciplinary_flag_count}
                          </span>
                        ) : (
                          <span className="flag-none">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={7} className="state">No firms match the current filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
              {firms.length > limit && (
                <div className="table-foot">
                  <button type="button" className="show-more" onClick={() => setLimit(limit + PAGE * 4)}>
                    Show more ({(firms.length - limit).toLocaleString()} remaining)
                  </button>
                </div>
              )}
            </section>

            <footer className="about">
              <h2>About this data</h2>
              <dl className="about-grid">
                <div>
                  <dt>Source &amp; freshness</dt>
                  <dd>
                    Built from the SEC’s{' '}
                    <a href="https://adviserinfo.sec.gov/" target="_blank" rel="noreferrer">
                      Investment Adviser Public Disclosure (IAPD)
                    </a>{' '}
                    Form ADV bulk feed, snapshot dated {data.generated_at.slice(0, 10)}, and
                    refreshed automatically. Regulatory AUM, headcount, fee structure, and client
                    figures are as reported by each firm in Form ADV Part 1A (Items 5 and 7).
                  </dd>
                </div>
                <div>
                  <dt>Self-reported figures</dt>
                  <dd>
                    Form ADV is a regulatory filing completed by the firms themselves. Figures may
                    be stale between amendments, and regulatory AUM is defined by SEC rules — it is
                    not the same as advisory assets marketed elsewhere. Always verify a firm
                    directly on its IAPD page (linked from every CRD number here).
                  </dd>
                </div>
                <div>
                  <dt>Disclosures ≠ misconduct</dt>
                  <dd>
                    “Disclosures” counts affirmative answers to Form ADV Item 11, which covers
                    criminal, regulatory, and civil-judicial events — including matters that were
                    settled, dismissed, or involve affiliates rather than the firm itself. A
                    disclosure is a reason to read the underlying record, not a finding of
                    wrongdoing.
                  </dd>
                </div>
                <div>
                  <dt>Rankings &amp; risk screens</dt>
                  <dd>
                    The standing and risk lists are computed from the published methodology above —
                    they are informational screens, not endorsements, ratings, or recommendations
                    of any firm. This site is independent and is not affiliated with, sponsored by,
                    or endorsed by the SEC, FINRA, Barron’s, CNBC, Forbes, SHOOK Research, UBS, or
                    Visual Capitalist; third-party names are referenced only to describe comparable
                    methodologies.
                  </dd>
                </div>
                <div>
                  <dt>No investment advice</dt>
                  <dd>
                    Nothing on this page is investment, legal, or tax advice, or a solicitation to
                    engage any adviser. Selecting an adviser involves factors this data cannot
                    capture. Consult a qualified professional before making financial decisions.
                  </dd>
                </div>
              </dl>
            </footer>
          </>
        )}
      </main>
    </>
  )
}
