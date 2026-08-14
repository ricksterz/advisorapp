import { useEffect, useMemo, useState } from 'react'

import { computeRankings, normalizedWeights } from './benchmarking/engine.js'
import { FACTOR_BY_ID, staffOf } from './benchmarking/factors.js'
import { RISK_PARAM_DEFAULTS } from './benchmarking/screens.js'
import { DIMENSION_ORDER, MIN_COHORT_SIZE } from './benchmarking/cohort.js'
import { PRESETS, defaultConfig } from './benchmarking/presets.js'
import { configFromLocation, urlForConfig } from './benchmarking/url.js'
import MethodologyPanel from './components/MethodologyPanel.jsx'
import FirmDetail, { websiteHost } from './components/FirmDetail.jsx'
import DealPatternsSection from './components/DealPatternsSection.jsx'
import PulsePage from './components/PulsePage.jsx'
import {
  DrilldownAdvisers,
  DrilldownAssets,
  DrilldownCapitalFormation,
  DrilldownDisclosures,
  DrilldownPrivateFunds,
  DrilldownServiceProviders,
} from './components/PulseDrilldowns.jsx'
import { BASE, firmPath, navigate, pulsePath, useRoute } from './router.js'
import { fmtCount } from './pulse.js'
import { DEAL_FLAG_DEFS, useAllDealFlags } from './dealFlags.js'
import { useAllAdvisorBios } from './advisorBios.js'
import { computeDealPatterns } from './dealPatterns.js'

const compactUsd = (v) => {
  if (v == null || Number.isNaN(v)) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(v >= 1e13 ? 0 : 1)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  return `$${Math.round(v).toLocaleString()}`
}

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
  { name: 'Altrata World Ultra Wealth Report', url: 'https://altrata.com/reports/world-ultra-wealth-report-2025' },
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

// Screen/cohort summaries for the rank-card subtitles and methodology prose.
function topScreenSummary(config) {
  const parts = [
    config.top.maxDisclosures === 0
      ? 'Clean record required'
      : `≤ ${config.top.maxDisclosures} disclosure${config.top.maxDisclosures > 1 ? 's' : ''}`,
    `≥ ${compactUsd(config.top.minAum)} AUM`,
    `≥ ${config.top.minStaff} advisory professional${config.top.minStaff === 1 ? '' : 's'}`,
  ]
  return parts.join(' · ')
}

function cohortSummary(config) {
  const dims = DIMENSION_ORDER.filter((d) => config.cohorts[d.id]).map((d) => d.label)
  return dims.length ? `peers grouped by ${dims.join(' × ')}` : null
}

function weightSummary(config) {
  const weights = normalizedWeights(config.weights)
  return Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .map(([id, w]) => `${Math.round(w * 100)}% ${FACTOR_BY_ID[id].label.toLowerCase()}`)
    .join(', ')
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
        {active && <span className="arrow" aria-hidden="true">▼</span>}
      </button>
    </th>
  )
}

function FirmLink({ firm }) {
  const path = firmPath(firm.crd)
  return (
    <a className="firm-link" href={path} onClick={(e) => navigate(e, path)}>
      {firm.business_name || firm.legal_name}
    </a>
  )
}

// Compact per-row indicator for the deal-structuring flags (etl/brochures.py
// scan of Part 2A brochures) — "…" while the shared file is still loading,
// "—" for a firm that was never scanned, otherwise one chip per active flag.
function DealFlagsCell({ crd, data }) {
  if (data === undefined) return <span className="flag-none">…</span>
  const flags = data?.firms?.[String(crd)]
  const active = flags ? DEAL_FLAG_DEFS.filter((d) => flags[d.id]) : []
  if (!active.length) return <span className="flag-none">—</span>
  return (
    <span className="deal-flag-chips">
      {active.map((d) => (
        <span key={d.id} className="deal-flag-mini" title={d.description}>
          {d.label}
        </span>
      ))}
    </span>
  )
}

// Compact per-row indicator for advisor bios (etl/advisor_bios.py scan of
// Part 2B brochure supplements) — "…" while the shared file is still
// loading, "—" for a firm with none on file, otherwise the person count.
// Same "…"/"—" convention as DealFlagsCell so a scanning-in-progress row
// never looks identical to a confirmed-empty one.
function AdvisorBiosCell({ crd, data }) {
  if (data === undefined) return <span className="flag-none">…</span>
  const bios = data?.firms?.[String(crd)]
  if (!bios?.length) return <span className="flag-none">—</span>
  return (
    <span className="deal-flag-mini" title={`${bios.length} advisor bio${bios.length === 1 ? '' : 's'} on file`}>
      {bios.length}
    </span>
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

const PULSE_TITLES = {
  '': 'Industry Pulse',
  advisers: 'Adviser counts & growth — Industry Pulse',
  assets: 'Assets & AUM bands — Industry Pulse',
  'private-funds': 'Private funds — Industry Pulse',
  disclosures: 'Disclosures — Industry Pulse',
  'capital-formation': 'Capital formation — Industry Pulse',
  'service-providers': 'Service providers — Industry Pulse',
}

export default function App() {
  const [theme, setTheme] = useTheme()
  const { firmCrd, pulse } = useRoute()

  useEffect(() => {
    // Firm pages manage their own title (usePageMeta); pulse routes here.
    if (pulse == null) return undefined
    const prev = document.title
    document.title = `${PULSE_TITLES[pulse] ?? PULSE_TITLES['']} · Open Disclosure`
    return () => {
      document.title = prev
    }
  }, [pulse])
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [minAum, setMinAum] = useState(0)
  const [perfOnly, setPerfOnly] = useState(false)
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [bioOnly, setBioOnly] = useState(false)
  const [dealFilters, setDealFilters] = useState({})
  const [sort, setSort] = useState('aum')
  const [limit, setLimit] = useState(PAGE)
  // Methodology config: seeded from the ?m= URL param so a shared link
  // reproduces the exact same ranking view on a cold load.
  const [config, setConfig] = useState(() => configFromLocation() ?? defaultConfig())

  useEffect(() => {
    // Keep the address bar shareable/bookmarkable without polluting history.
    window.history.replaceState(null, '', urlForConfig(config))
  }, [config])

  useEffect(() => {
    // Static snapshot exported by the ETL; all filtering happens client-side.
    fetch(`${import.meta.env.BASE_URL}firms.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`failed to load firms.json (${r.status})`)))
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [])

  // Deal-structuring flags (etl/brochures.py) — a separate committed file,
  // since the brochure corpus that produces it can't be built in CI.
  const dealFlagsData = useAllDealFlags()

  // Advisor bios (etl/advisor_bios.py) — same reasoning, same pattern. Only
  // ~12% of firms have any bios on file, so a filter/column here is what
  // actually lets someone find one instead of guessing at random firms.
  const advisorBiosData = useAllAdvisorBios()

  const stats = useMemo(() => {
    if (!data) return null
    const aums = data.firms.map((f) => f.aum_total).filter((v) => v > 0).sort((a, b) => a - b)
    const totalAum = aums.reduce((s, v) => s + v, 0)
    const median = aums.length ? aums[Math.floor(aums.length / 2)] : null
    // Concentration beats a gross aggregate as a headline: summed regulatory
    // AUM double-counts fund complexes and sub-advised assets (see About).
    const billionAum = aums.filter((v) => v >= 1e9)
    const billionShare = totalAum ? billionAum.reduce((s, v) => s + v, 0) / totalAum : 0
    const perfShare = data.firms.filter((f) => f.fee_performance_based).length / data.firms.length
    // A single Item 11 disclosure is common enough (~12% of firms) that it
    // reads as noise rather than signal; a repeated pattern is the more
    // meaningful headline number.
    const flagged = data.firms.filter((f) => f.disciplinary_flag_count > 3).length
    return { median, billionCount: billionAum.length, billionShare, perfShare, flagged }
  }, [data])

  const rankings = useMemo(() => (data ? computeRankings(data.firms, config) : null), [data, config])

  const dealPatterns = useMemo(
    () => (data ? computeDealPatterns(data.firms, dealFlagsData, DEAL_FLAG_DEFS) : null),
    [data, dealFlagsData],
  )

  const activeDealFilters = useMemo(
    () => DEAL_FLAG_DEFS.filter((d) => dealFilters[d.id]),
    [dealFilters],
  )

  const firms = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.firms
      .filter((f) => {
        if (minAum && (f.aum_total ?? 0) < minAum) return false
        if (perfOnly && !f.fee_performance_based) return false
        if (flaggedOnly && !(f.disciplinary_flag_count > 0)) return false
        if (bioOnly && !(advisorBiosData?.firms?.[String(f.crd)]?.length > 0)) return false
        if (activeDealFilters.length) {
          const flags = dealFlagsData?.firms?.[String(f.crd)]
          if (!flags || !activeDealFilters.every((d) => flags[d.id])) return false
        }
        if (!q) return true
        return (
          (f.legal_name || '').toLowerCase().includes(q) ||
          (f.business_name || '').toLowerCase().includes(q) ||
          String(f.crd).startsWith(q)
        )
      })
      .sort(SORTS[sort])
  }, [data, query, minAum, perfOnly, flaggedOnly, bioOnly, sort, activeDealFilters, dealFlagsData, advisorBiosData])

  const visible = firms.slice(0, limit)
  const resetPage = () => setLimit(PAGE)

  return (
    <>
      <header className="topbar">
        <a className="brand" href={BASE} onClick={(e) => navigate(e, BASE)} aria-label="Open Disclosure home">
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          Open Disclosure
        </a>
        <span className="spacer" />
        <a
          className={`topbar-link${pulse != null ? ' active' : ''}`}
          href={pulsePath()}
          onClick={(e) => navigate(e, pulsePath())}
        >
          Pulse
        </a>
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

      {firmCrd != null ? (
        <main className="shell">
          {error && <div className="state error">{error}</div>}
          {!error && !data && <div className="state">Loading firm data…</div>}
          {data && (
            <FirmDetail firm={data.firms.find((f) => f.crd === firmCrd)} crd={firmCrd} allFirms={data.firms} />
          )}
        </main>
      ) : pulse != null ? (
        <main className="shell">
          {pulse === 'advisers' ? (
            <DrilldownAdvisers />
          ) : pulse === 'assets' ? (
            <DrilldownAssets />
          ) : pulse === 'private-funds' ? (
            <DrilldownPrivateFunds />
          ) : pulse === 'disclosures' ? (
            <DrilldownDisclosures />
          ) : pulse === 'capital-formation' ? (
            <DrilldownCapitalFormation />
          ) : pulse === 'service-providers' ? (
            <DrilldownServiceProviders />
          ) : (
            <PulsePage />
          )}
        </main>
      ) : (
      <>
      <main className="shell">
        <section className="page-head">
          <h1>Open Disclosure</h1>
          <p className="page-tagline">Investment adviser benchmarking, from the public record.</p>
          <p>
            Every SEC-registered advisory firm — assets under management, compensation structure,
            and disciplinary history — built from public Form ADV filings.
          </p>
        </section>

        {error && <div className="state error">{error}</div>}
        {!error && !data && <div className="state">Loading firm data…</div>}

        {stats && (
          <section className="tiles" aria-label="Industry totals">
            <StatTile label="Firms tracked" value={fmtCount(data.count)} sub="SEC-registered advisers" />
            <StatTile
              label="Firms managing ≥ $1B"
              value={fmtCount(stats.billionCount)}
              sub={`hold ${Math.round(stats.billionShare * 100)}% of reported AUM`}
            />
            <StatTile label="Median firm AUM" value={compactUsd(stats.median)} />
            <StatTile
              label="Performance-based fees"
              value={`${Math.round(stats.perfShare * 100)}%`}
              sub="of firms charge them"
            />
            <StatTile
              label="Disciplinary disclosures"
              value={fmtCount(stats.flagged)}
              sub="firms with > 3 flags"
            />
          </section>
        )}

        <a className="pulse-banner" href={pulsePath()} onClick={(e) => navigate(e, pulsePath())}>
          <span className="pulse-banner-title">Industry Pulse →</span>
          <span className="pulse-banner-sub">
            Quarterly statistics on the adviser industry: registrations, assets, size-band
            migration, and disclosure trends.
          </span>
        </a>

        <DealPatternsSection patterns={dealPatterns} />

        {rankings && (
          <section className="rankings" aria-label="Rankings">
            <div className="section-head">
              <h2>Standing &amp; risk screens</h2>
              <p>
                A transparent, purely quantitative read on firm standing — modeled on how Barron’s,
                CNBC’s FA 100, and Forbes/SHOOK screen advisors, but computed only from public
                Form ADV data. Unlike those lists, every weight, screen, and peer group below is
                yours to change — and to share as a link.
              </p>
            </div>

            <MethodologyPanel config={config} onChange={setConfig} />

            <div className="rank-grid">
              <RankCard
                title="Top advisory firms"
                sub={[topScreenSummary(config), cohortSummary(config)].filter(Boolean).join(' · ')}
              >
                {rankings.top.length === 0 ? (
                  <div className="state">No firms pass the current eligibility screens.</div>
                ) : (
                  <ol className="rank-list">
                    {rankings.top.map(({ firm, score, cohort }, i) => (
                      <li key={firm.crd}>
                        <span className="rank-n">{i + 1}</span>
                        <span className="rank-firm">
                          <FirmLink firm={firm} />
                          <span className="firm-sub">
                            {compactUsd(firm.aum_total)} AUM · {staffOf(firm)} advisory staff
                            {cohortSummary(config) && <> · vs {cohort.label}</>}
                          </span>
                          {cohort.note && <span className="cohort-note">{cohort.note}</span>}
                        </span>
                        <span className="score-badge" title="Composite standing score (0–100)">
                          {score.toFixed(1)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </RankCard>

              <RankCard
                title="Elevated-risk signals"
                sub={`Firms ≥ ${compactUsd(config.risk.minAum)} AUM scoring ${config.risk.threshold}+ across the risk screens`}
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
                  <strong>Standing score (0–100).</strong> Firms must first pass the active
                  eligibility screens:{' '}
                  {config.top.maxDisclosures === 0
                    ? 'a clean Item 11 record (no disciplinary disclosures — the same hard compliance screen Forbes/SHOOK and CNBC’s FA 100 apply)'
                    : `no more than ${config.top.maxDisclosures} Item 11 disciplinary disclosure${config.top.maxDisclosures > 1 ? 's' : ''}`}
                  , at least {compactUsd(config.top.minAum)} in regulatory AUM, and at least{' '}
                  {config.top.minStaff} advisory professional{config.top.minStaff === 1 ? '' : 's'}.
                  Eligible firms are then scored on the active weights:{' '}
                  <em>{weightSummary(config)}</em>.{' '}
                  {cohortSummary(config) ? (
                    <>
                      Percentile factors rank each firm within its peer cohort ({cohortSummary(config)});
                      a cohort with fewer than {MIN_COHORT_SIZE} firms falls back to the
                      next-broadest pool, and affected entries say so. Because every cohort has
                      its own leaders, scores are comparable within a cohort rather than across
                      the whole list.
                    </>
                  ) : (
                    <>Percentile factors rank each firm against all eligible firms.</>
                  )}
                </p>
                <p>
                  <strong>Risk signals (0–100).</strong> Inspired by the regulatory-record and
                  practice-quality factors those rankings penalize: Item 11 disciplinary
                  disclosures ({config.risk.points.disclosures} points each, capped at{' '}
                  {RISK_PARAM_DEFAULTS.disclosureCap}), commission <em>and</em> performance-fee
                  compensation together ({config.risk.points.commissionsPlusPerf} — stacked
                  conflict exposure), {RISK_PARAM_DEFAULTS.minAffiliations} or more
                  financial-industry affiliations ({config.risk.points.denseAffiliations} — larger
                  conflict surface), and an accounts-per-professional ratio in the top{' '}
                  {Math.round((1 - RISK_PARAM_DEFAULTS.loadPercentile) * 100)}% (
                  {config.risk.points.highClientLoad} — service-capacity strain, the inverse of the
                  advisor-to-client ratios CNBC’s methodology rewards). Firms at or above{' '}
                  {compactUsd(config.risk.minAum)} AUM scoring {config.risk.threshold}+ are listed.
                </p>
                <p>
                  <strong>Presets.</strong>{' '}
                  {PRESETS.map((p, i) => (
                    <span key={p.id}>
                      <em>{p.label}</em> — {p.description}
                      {i < PRESETS.length - 1 ? ' ' : ''}
                    </span>
                  ))}{' '}
                  Any control you change becomes a “Custom” methodology you can share with the
                  copy-link button — the URL encodes the full configuration, so the same link
                  always reproduces the same ranking.
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
              {advisorBiosData !== null && (
                <button
                  type="button"
                  className="chip"
                  aria-pressed={bioOnly}
                  disabled={advisorBiosData === undefined}
                  title="Advisor bios, extracted from Form ADV Part 2B brochure supplement filings — on file for ~12% of firms"
                  onClick={() => { setBioOnly(!bioOnly); resetPage() }}
                >
                  Has advisor bios
                </button>
              )}
              {dealFlagsData !== null &&
                DEAL_FLAG_DEFS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="chip"
                    aria-pressed={!!dealFilters[d.id]}
                    disabled={dealFlagsData === undefined}
                    title={d.description}
                    onClick={() => {
                      setDealFilters((prev) => ({ ...prev, [d.id]: !prev[d.id] }))
                      resetPage()
                    }}
                  >
                    {d.label}
                  </button>
                ))}
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
                    {dealFlagsData !== null && <th>Deal structuring</th>}
                    {advisorBiosData !== null && <th className="num">Advisor bios</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((f) => (
                    <tr key={f.crd}>
                      <td>
                        <div className="firm-name">
                          <a className="firm-link" href={firmPath(f.crd)} onClick={(e) => navigate(e, firmPath(f.crd))}>
                            {f.business_name || f.legal_name}
                          </a>
                        </div>
                        <div className="firm-sub">
                          <a className="crd-link" href={iapdUrl(f.crd)} target="_blank" rel="noreferrer">
                            CRD {f.crd}
                          </a>
                          {f.website_url && websiteHost(f.website_url) && (
                            <>
                              {' · '}
                              <a className="crd-link" href={f.website_url} target="_blank" rel="noreferrer">
                                {websiteHost(f.website_url)} ↗
                              </a>
                            </>
                          )}
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
                      {dealFlagsData !== null && (
                        <td>
                          <DealFlagsCell crd={f.crd} data={dealFlagsData} />
                        </td>
                      )}
                      {advisorBiosData !== null && (
                        <td className="num">
                          <AdvisorBiosCell crd={f.crd} data={advisorBiosData} />
                        </td>
                      )}
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td
                        colSpan={7 + (dealFlagsData !== null ? 1 : 0) + (advisorBiosData !== null ? 1 : 0)}
                        className="state"
                      >
                        No firms match the current filters.
                      </td>
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
          </>
        )}
      </main>

      {data && (
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
                  <dt>Why regulatory AUM figures look enormous</dt>
                  <dd>
                    Regulatory AUM is not private client wealth. It counts institutional and fund
                    assets (mutual funds, ETFs, pensions) gross of leverage, and related advisers
                    within one complex each file separately — three Vanguard-affiliated advisers
                    alone report roughly $22T combined, and sub-advised assets can appear at both
                    the adviser and the sub-adviser. Summing it across firms is therefore
                    misleading, which is why no aggregate is shown here. For scale:{' '}
                    <a
                      href="https://altrata.com/reports/world-ultra-wealth-report-2025"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Altrata’s World Ultra Wealth Report 2025
                    </a>{' '}
                    puts the combined net worth of all 510,810 ultra-high-net-worth individuals
                    worldwide at $59.8T — roughly a third of what these firms report in regulatory
                    AUM combined. Exempt reporting advisers (which file no regulatory AUM) are
                    excluded from this dataset.
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
                <div>
                  <dt>Abbreviations used on this site</dt>
                  <dd>
                    <strong>AUM</strong> = assets under management. <strong>CRD</strong> = Central
                    Registration Depository number, the SEC/FINRA identifier for a firm or
                    individual (links to the IAPD page above use it). <strong>GP / LP</strong> =
                    general partner / limited partner — in the “Affiliated GP / LP”
                    deal-structuring flag, the general partner is the entity that manages a fund
                    and the limited partners are the passive investors in it.
                  </dd>
                </div>
          </dl>
        </footer>
      )}
      </>
      )}
    </>
  )
}
