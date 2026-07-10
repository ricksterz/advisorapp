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

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])
  return [theme, setTheme]
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

        {data && (
          <>
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
                        <div className="firm-sub">CRD {f.crd}</div>
                      </td>
                      <td className="num">{compactUsd(f.aum_total)}</td>
                      <td><DiscretionaryMeter firm={f} /></td>
                      <td className="num">{f.employees_advisory ?? f.employees_total ?? '—'}</td>
                      <td>
                        <span className="fee-chips">
                          {f.fee_pct_of_aum && <span className="fee-chip">% of AUM</span>}
                          {f.fee_performance_based && <span className="fee-chip">Performance</span>}
                          {!f.fee_pct_of_aum && !f.fee_performance_based && (
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

            <p className="foot-note">
              Source: SEC Investment Adviser Public Disclosure (IAPD) Form ADV bulk feed. Regulatory
              AUM as reported in Item 5.F; disclosures are Item 11 affirmative answers. Public data —
              not investment advice.
            </p>
          </>
        )}
      </main>
    </>
  )
}
