import { useMemo } from 'react'

import { staffOf } from '../benchmarking/factors.js'
import { againstFirm, AGAINST_LABELS, KIND_LABELS } from '../disclosures.js'
import {
  conflictIndicators,
  coverage,
  dataLimitations,
  diligenceQuestions,
  observations,
  TOPICS,
} from '../intel.js'
import { useFirmIntel } from '../intelData.js'
import { nonAdvisoryStaff } from '../leverage.js'
import { describeRank, fmtMetric, peerStats, prevalence } from '../peers.js'
import { fmtCompactUsd, fmtQuarter, ordinal } from '../pulse.js'
import { benchmarkPath, comparePath, diligencePath, firmPath, legalPath, navigate } from '../router.js'
import { aumShare, firmSegment, firmTags, SEGMENT_BY_ID, useFundTypes } from '../segments.js'
import { firmSources, ITEMS } from '../sources.js'
import { fmtMultiple } from '../trajectory.js'
import { usePageMeta } from '../pageMeta.js'
import { resolveWebsite, useWebsiteOverrides } from '../websiteOverrides.js'
import CopyLinkButton from './CopyLinkButton.jsx'
import { websiteHost } from './FirmDetail.jsx'
import { TrendLine } from './PulsePage.jsx'
import WatchButton from './WatchButton.jsx'

const SITE_URL = 'https://open-disclosure.com'
const nameOf = (f) => f.business_name || f.legal_name

export const STATUS_LABELS = {
  disclosed: 'Disclosed',
  not_reported: 'Not reported',
  not_covered: 'Not covered',
  loading: 'Checking…',
}

export function StatusBadge({ status }) {
  return <span className={`status-badge status-${status}`}>{STATUS_LABELS[status] ?? status}</span>
}

export function ReportSection({ n, title, children, id }) {
  return (
    <section className="report-section" aria-labelledby={id}>
      <h2 id={id}>
        {n != null && <span className="report-n">{n}</span>}
        {title}
      </h2>
      {children}
    </section>
  )
}

// A report is a view of the firm page, so it carries the firm page's
// canonical (the served HTML for ?view= is the firm's own file).
export function useReportMeta(firm, kind) {
  usePageMeta({
    title: firm ? `${nameOf(firm)} — ${kind} · Open Disclosure` : `${kind} · Open Disclosure`,
    path: firm ? `firm/${firm.crd}` : null,
  })
}

const PEER_IDS = ['aum', 'staff', 'aum_per_pro', 'accounts_per_pro', 'aum_per_account', 'discretionary', 'hnw_clients', 'wealth_aum', 'aum_per_hnw', 'support_ratio', 'affiliations', 'disclosures']

export default function IntelligenceReport({ firm, crd, allFirms, snapshot }) {
  const { ctx, loading } = useFirmIntel(firm, allFirms)
  const overrides = useWebsiteOverrides()
  const fundTypes = useFundTypes()
  useReportMeta(firm, 'Advisor Intelligence Report')

  const analysis = useMemo(() => {
    if (!firm) return null
    return {
      obs: observations(firm, ctx),
      conflicts: conflictIndicators(firm, ctx),
      limits: dataLimitations(firm, ctx),
      questions: diligenceQuestions(firm, ctx),
      peers: ctx.cohort ? peerStats(firm, ctx.cohort.peers, PEER_IDS) : null,
      prev: ctx.cohort ? prevalence(firm, ctx.cohort.peers) : null,
      cov: coverage(ctx),
    }
  }, [firm, ctx])

  if (!firm) {
    return (
      <section className="report">
        <div className="state">No firm with CRD {crd} in this snapshot.</div>
      </section>
    )
  }

  const segment = firmSegment(firm)
  const tags = firmTags(firm, fundTypes)
  const site = resolveWebsite(overrides, firm.crd, firm.website_url)
  const host = site.url ? websiteHost(site.url) : null
  const staff = staffOf(firm)
  const support = nonAdvisoryStaff(firm)
  const disc = firm.aum_total > 0 && firm.aum_discretionary != null ? firm.aum_discretionary / firm.aum_total : null
  const g = ctx.growth?.entry
  const events = ctx.disclosures?.events ?? []
  const sortedEvents = [...events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const controlOwners = (ctx.owners?.owners ?? []).filter((o) => o.control).slice(0, 8)
  const today = new Date().toLocaleDateString('en-CA') // local YYYY-MM-DD
  const { obs, conflicts, limits, questions, peers, prev, cov } = analysis

  return (
    <article className="report" aria-label={`Advisor Intelligence Report: ${nameOf(firm)}`}>
      <div className="report-toolbar no-print">
        <a className="back-link" href={firmPath(firm.crd)} onClick={(e) => navigate(e, firmPath(firm.crd))}>
          ← {nameOf(firm)} profile
        </a>
        <span className="spacer" />
        <button type="button" className="chip share-link" onClick={() => window.print()}>
          Print / save PDF
        </button>
        <CopyLinkButton url={`${SITE_URL}/firm/${firm.crd}?view=report`} label="Copy link" className="chip share-link" />
        <WatchButton firm={firm} snapshotDate={snapshot} />
        <a className="chip share-link" href={diligencePath(firm.crd)} onClick={(e) => navigate(e, diligencePath(firm.crd))}>
          Due-diligence questionnaire
        </a>
      </div>

      <header className="report-head">
        <p className="report-kicker">Advisor Intelligence Report</p>
        <h1>{nameOf(firm)}</h1>
        <p className="report-meta">
          {firm.business_name && firm.business_name !== firm.legal_name && <>{firm.legal_name} · </>}
          CRD {firm.crd}
          {firm.state ? ` · ${firm.state}` : firm.country ? ` · ${firm.country}` : ''}
          {segment && <> · {SEGMENT_BY_ID[segment].label}</>}
        </p>
        <dl className="report-provenance">
          <div>
            <dt>Data snapshot</dt>
            <dd>SEC Form ADV bulk data, {snapshot ?? 'date unavailable'}</dd>
          </div>
          <div>
            <dt>Report generated</dt>
            <dd>{today}</dd>
          </div>
          <div>
            <dt>Official record</dt>
            <dd>
              <a href={`https://adviserinfo.sec.gov/firm/summary/${firm.crd}`} target="_blank" rel="noreferrer">
                adviserinfo.sec.gov ↗
              </a>
            </dd>
          </div>
        </dl>
        {loading && <p className="detail-note no-print">Loading growth, disclosure, ownership and holdings data…</p>}
      </header>

      <ReportSection n="1" title="Executive summary" id="r-summary">
        <div className="tiles report-tiles">
          <div className="tile">
            <div className="label">Regulatory AUM</div>
            <div className="value">{fmtCompactUsd(firm.aum_total)}</div>
            <div className="sub">{disc != null ? `${Math.round(disc * 100)}% discretionary` : 'Discretion not reported'}</div>
          </div>
          <div className="tile">
            <div className="label">Advisory professionals</div>
            <div className="value">{staff != null ? staff.toLocaleString() : 'Not reported'}</div>
            <div className="sub">{firm.employees_total != null ? `${firm.employees_total.toLocaleString()} employees total` : ' '}</div>
          </div>
          <div className="tile">
            <div className="label">5-year AUM change</div>
            <div className="value">{g?.a5 != null ? fmtMultiple(g.a5) : ctx.growth === undefined ? '…' : 'No history'}</div>
            <div className="sub">Assets managed, not investment returns</div>
          </div>
          <div className="tile">
            <div className="label">Item 11 disclosures</div>
            <div className="value">{(firm.disciplinary_flag_count ?? 0).toLocaleString()}</div>
            <div className="sub">Firm and affiliates; not findings</div>
          </div>
        </div>
        <h3 className="report-sub">Key observations</h3>
        <ul className="observations">
          {obs.map((o) => (
            <li key={o.id} className={`observation tone-${o.tone}`}>
              <span className="observation-tag">{o.tone === 'review' ? 'Worth asking about' : 'Context'}</span>
              <span className="observation-body">
                <strong>{o.title}.</strong> {o.text}
                <span className="observation-source">Source: {o.source}</span>
              </span>
            </li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection n="2" title="Firm characteristics and AUM history" id="r-firm">
        <div className="report-two">
          <table className="kv-table">
            <tbody>
              <tr><th scope="row">Legal name</th><td>{firm.legal_name}</td></tr>
              {firm.business_name && <tr><th scope="row">Business name</th><td>{firm.business_name}</td></tr>}
              <tr><th scope="row">Main office</th><td>{[firm.state, firm.country].filter(Boolean).join(', ') || 'Not reported'}</td></tr>
              <tr><th scope="row">Website</th><td>{host ? <a href={site.url} target="_blank" rel="noreferrer">{host} ↗</a> : 'Not reported'}</td></tr>
              <tr><th scope="row">Business model</th><td>{segment ? SEGMENT_BY_ID[segment].label : 'Not classifiable (AUM by client type not reported)'}</td></tr>
              {tags.length > 0 && <tr><th scope="row">Tags</th><td>{tags.map((t) => t.label).join(', ')}</td></tr>}
              <tr><th scope="row">Discretionary AUM</th><td>{fmtMetric('usd', firm.aum_discretionary)}</td></tr>
              <tr><th scope="row">Non-discretionary AUM</th><td>{fmtMetric('usd', firm.aum_non_discretionary)}</td></tr>
              <tr><th scope="row">Accounts</th><td>{fmtMetric('count', firm.accounts_total)}</td></tr>
              <tr><th scope="row">Non-advisory staff</th><td>{fmtMetric('count', support)}</td></tr>
              <tr><th scope="row">AUM from individuals &amp; HNW</th><td>{fmtMetric('pct', aumShare(firm, 'wealth'))}</td></tr>
              <tr><th scope="row">High-net-worth share of clients</th><td>{fmtMetric('pct', firm.pct_clients_hnw_individuals)}</td></tr>
            </tbody>
          </table>
          <div>
            {ctx.trajectory?.length ? (
              <>
                <div className="report-spark">
                  <span className="firm-history-spark-label">Regulatory AUM, {ctx.trajectory[0].year}–{ctx.trajectory[ctx.trajectory.length - 1].year}</span>
                  <TrendLine values={ctx.trajectory.map((p) => p.aum)} width={220} height={44} />
                </div>
                <table className="pulse-table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th className="num">AUM</th>
                      <th className="num">Employees</th>
                      <th className="num">Accounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ctx.trajectory.slice(-8).map((p) => (
                      <tr key={p.year}>
                        <td>{p.year}</td>
                        <td className="num">{fmtCompactUsd(p.aum)}</td>
                        <td className="num">{fmtMetric('count', p.employees)}</td>
                        <td className="num">{fmtMetric('count', p.accounts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="detail-empty">{ctx.trajectory === undefined ? 'Loading history…' : 'No multi-year history on file for this firm.'}</p>
            )}
            {g && (
              <p className="detail-note">
                AUM change: {['3', '5', '10'].filter((p) => g[`a${p}`] != null).map((p) => `${p}y ${fmtMultiple(g[`a${p}`])}${g[`r${p}`] != null ? ` (faster than ${Math.max(1, Math.min(99, g[`r${p}`]))}% of peers)` : ''}`).join(' · ')}.
              </p>
            )}
            <p className="detail-note">
              From the SEC’s January registered-adviser report each year ({ITEMS.history}). AUM growth includes market
              movements, new clients and acquisitions. It is not investment performance, which Form ADV does not report.
            </p>
          </div>
        </div>
      </ReportSection>

      <ReportSection n="3" title="Peer benchmarking and HNW specialization" id="r-peers">
        {peers ? (
          <>
            <p className="report-lede">
              Compared with {ctx.cohort.peers.length.toLocaleString()} {ctx.cohort.label}. Percentiles are positions, not grades:
              a high or low figure is a description of the business, not a verdict on it.
            </p>
            <div className="table-scroll">
              <table className="pulse-table bench-table">
                <thead>
                  <tr>
                    <th>Measure</th>
                    <th className="num">This firm</th>
                    <th className="num">Peer 25th</th>
                    <th className="num">Peer median</th>
                    <th className="num">Peer 75th</th>
                    <th className="num">Percentile</th>
                  </tr>
                </thead>
                <tbody>
                  {peers.map((m) => {
                    const r = describeRank(m.rank)
                    return (
                      <tr key={m.id}>
                        <td>{m.label}</td>
                        <td className="num"><strong>{fmtMetric(m.kind, m.value)}</strong></td>
                        <td className="num">{m.n ? fmtMetric(m.kind, m.p25) : '—'}</td>
                        <td className="num">{m.n ? fmtMetric(m.kind, m.median) : '—'}</td>
                        <td className="num">{m.n ? fmtMetric(m.kind, m.p75) : '—'}</td>
                        <td className="num">{r ? <PercentileBar rank={m.rank} label={ordinal(r.pct)} /> : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <h3 className="report-sub">How common each arrangement is among these peers</h3>
            <table className="pulse-table">
              <thead>
                <tr>
                  <th>Arrangement</th>
                  <th>This firm</th>
                  <th className="num">Share of peers</th>
                </tr>
              </thead>
              <tbody>
                {prev.map((p) => (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td>{p.firm ? 'Yes' : 'Not reported'}</td>
                    <td className="num">{p.share != null ? `${Math.round(p.share * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="detail-note no-print">
              <a href={benchmarkPath(firm.crd)} onClick={(e) => navigate(e, benchmarkPath(firm.crd))}>
                Open the full benchmark with other peer groups →
              </a>
            </p>
          </>
        ) : (
          <p className="detail-empty">Too few comparable firms to benchmark against meaningfully.</p>
        )}
      </ReportSection>

      <ReportSection n="4" title="Compensation arrangements and potential conflicts of interest" id="r-conflicts">
        <p className="report-lede">
          Arrangements the firm has disclosed. Each can create a conflict of interest; none is misconduct. Firms are required
          to disclose them and to explain how they are managed — that explanation, in the brochure and Form CRS, is what to read next.
        </p>
        <div className="table-scroll">
          <table className="pulse-table conflict-table">
            <thead>
              <tr>
                <th>Arrangement</th>
                <th>Status</th>
                <th>Why it matters</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.label}</strong>
                    {c.detail && <div className="conflict-detail">{c.detail}</div>}
                  </td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.why}</td>
                  <td className="conflict-source">{c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="detail-note">
          “Not reported” means the filing doesn’t report the arrangement. “Not covered” means the data set that would show it
          doesn’t include this firm, so the answer is unknown — not no.
        </p>
      </ReportSection>

      <ReportSection n="5" title="Regulatory disclosures" id="r-record">
        <p className="report-lede">
          {firm.disciplinary_flag_count > 0
            ? `${firm.disciplinary_flag_count} affirmative answer${firm.disciplinary_flag_count === 1 ? '' : 's'} to Form ADV Item 11, which covers criminal, regulatory and civil events involving the firm and every advisory affiliate, including settled, dismissed and pending matters.`
            : 'No affirmative answers to Form ADV Item 11. That covers the criminal, regulatory and civil events the form asks about, for the firm and its advisory affiliates; it is not a review of everything that could matter.'}{' '}
          A disclosure is a reason to read the record, not a finding of wrongdoing.
        </p>
        {sortedEvents.length > 0 && (
          <div className="table-scroll">
            <table className="pulse-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Against</th>
                  <th>Initiated by</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {sortedEvents.slice(0, 12).map((e, i) => (
                  <tr key={`${e.ref ?? i}-${e.date}`}>
                    <td className="nowrap">{e.date ?? 'Undated'}</td>
                    <td>{KIND_LABELS[e.kind] ?? '—'}</td>
                    <td>{AGAINST_LABELS[e.against] ?? '—'}</td>
                    <td>{e.by ?? '—'}</td>
                    <td>{[e.what, e.status, e.resolution].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="detail-note">
              {events.filter(againstFirm).length} of {events.length} dated events concern the firm itself. Events filed or updated
              between {ctx.disclosures.coversFrom ?? 'the first archive'} and {ctx.disclosures.asOf ?? 'the latest archive'}
              {sortedEvents.length > 12 ? `; the ${sortedEvents.length - 12} older ones are on the firm’s profile page` : ''}. Older
              events the firm hasn’t updated since are on IAPD only.
            </p>
          </div>
        )}
        {ctx.history?.quarters?.length > 1 && (
          <p className="detail-note">
            Item 11 count by quarter:{' '}
            {ctx.history.quarters.map((q, i) => `${fmtQuarter(q)} ${ctx.history.disciplinary_flag_count[i] ?? '—'}`).join(' · ')}.
          </p>
        )}
      </ReportSection>

      <ReportSection n="6" title="Ownership and control" id="r-owners">
        {controlOwners.length ? (
          <table className="pulse-table">
            <thead>
              <tr>
                <th>Control person or entity</th>
                <th>Title or status</th>
                <th className="num">Stake</th>
              </tr>
            </thead>
            <tbody>
              {controlOwners.map((o, i) => (
                <tr key={`${o.name}-${i}`}>
                  <td>
                    {o.name}
                    {!o.is_individual && <span className="fund-tag">entity</span>}
                  </td>
                  <td>{o.title ?? '—'}</td>
                  <td className="num">{o.stake ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="detail-empty">{ctx.owners === undefined ? 'Loading…' : 'No control persons on file in the data reviewed.'}</p>
        )}
        {Array.isArray(ctx.ownershipChanges) && ctx.ownershipChanges.length > 0 && (
          <p className="detail-note">
            {ctx.ownershipChanges.length} filing{ctx.ownershipChanges.length === 1 ? '' : 's'} changed owners or officers; most recent{' '}
            {ctx.ownershipChanges[0].date}. Dates are when a filing first reported the change.
          </p>
        )}
        <p className="detail-note">Source: {ITEMS.owners}. Stakes are the SEC’s ownership bands, not exact percentages.</p>
      </ReportSection>

      <ReportSection n="7" title="Investment holdings and private funds" id="r-holdings">
        {ctx.holdings ? (
          <>
            <p className="report-lede">
              {ctx.holdings.own
                ? `${fmtQuarter(ctx.holdings.period)} Form 13F: ${ctx.holdings.filer.positions.toLocaleString()} positions${ctx.holdings.filer.values_reliable ? `, ${fmtCompactUsd(ctx.holdings.filer.value)} reported value` : ''}.`
                : `Reported within ${ctx.holdings.filer.name}’s combined ${fmtQuarter(ctx.holdings.period)} 13F; figures are for the whole combined filing.`}
            </p>
            {ctx.holdings.filer.top?.length > 0 && (
              <table className="pulse-table">
                <thead>
                  <tr>
                    <th>Largest positions</th>
                    {ctx.holdings.filer.values_reliable && <th className="num">Share of reported value</th>}
                  </tr>
                </thead>
                <tbody>
                  {ctx.holdings.filer.top.slice(0, 10).map((h) => (
                    <tr key={h.cusip}>
                      <td>{h.issuer}</td>
                      {ctx.holdings.filer.values_reliable && <td className="num">{(h.pct * 100).toFixed(1)}%</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="detail-note">
              A 13F lists US-listed equities, ETFs, options and convertibles at quarter end. It is not AUM, not a recommendation,
              and not the portfolio any one client holds.
            </p>
          </>
        ) : (
          <p className="detail-empty">
            {ctx.holdings === undefined ? 'Loading…' : 'No Form 13F covers this firm, so equity holdings are unknown, not absent.'}
          </p>
        )}
        {Array.isArray(ctx.funds) && ctx.funds.length > 0 && (
          <>
            <h3 className="report-sub">Private funds advised ({ctx.funds.length})</h3>
            <table className="pulse-table">
              <thead>
                <tr>
                  <th>Fund</th>
                  <th>Type</th>
                  <th className="num">Gross assets</th>
                </tr>
              </thead>
              <tbody>
                {[...ctx.funds].sort((a, b) => (b.gav ?? 0) - (a.gav ?? 0)).slice(0, 8).map((f) => (
                  <tr key={f.fund_id}>
                    <td>{f.name}</td>
                    <td>{f.type}</td>
                    <td className="num">{fmtCompactUsd(f.gav)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="detail-note">Source: {ITEMS.privateFunds}. Feeder and master funds overlap; don’t add the figures.</p>
          </>
        )}
      </ReportSection>

      <ReportSection n="8" title="Firm-specific due-diligence questions" id="r-questions">
        <p className="report-lede">
          Generated from this firm’s filings: each specific question cites the disclosure that prompted it. Baseline questions
          apply to any adviser. <span className="no-print">For a checklist with notes, use the{' '}
          <a href={diligencePath(firm.crd)} onClick={(e) => navigate(e, diligencePath(firm.crd))}>interactive questionnaire</a>.</span>
        </p>
        {TOPICS.map((t) => {
          const qs = questions.filter((x) => x.topic === t.id)
          if (!qs.length) return null
          return (
            <div key={t.id} className="question-group">
              <h3 className="report-sub">{t.label}</h3>
              <ol className="question-list">
                {qs.map((x) => (
                  <li key={x.id}>
                    <p className="question-text">
                      {x.question}
                      {x.specific && <span className="question-tag">Firm-specific</span>}
                    </p>
                    {x.evidence.length > 0 && (
                      <ul className="evidence-list">
                        {x.evidence.map((e, i) => (
                          <li key={i}>
                            {e.text} <span className="evidence-source">— {e.source}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )
        })}
      </ReportSection>

      <ReportSection n="9" title="Primary sources and data limitations" id="r-sources">
        <h3 className="report-sub">Primary sources</h3>
        <ul className="source-list">
          {firmSources(firm.crd, ctx.docs).map((s) => (
            <li key={s.href}>
              <a href={s.href} target="_blank" rel="noreferrer">{s.label} ↗</a>
              {s.note && <span className="source-note"> — {s.note}</span>}
            </li>
          ))}
        </ul>
        <h3 className="report-sub">Data sets used in this report</h3>
        <table className="pulse-table">
          <tbody>
            {cov.map((c) => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td>{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="report-sub">Limitations</h3>
        <ul className="limit-list">
          {limits.map((l) => (
            <li key={l.id}>{l.text}</li>
          ))}
        </ul>
        <p className="pulse-disclaimer">
          For informational purposes only. Open Disclosure is independent and is not affiliated with, endorsed by or acting
          on behalf of {nameOf(firm)}, the SEC or FINRA. This report is a calculation from public regulatory filings, provided
          as is without warranty as to accuracy, completeness or timeliness. It is not investment, legal or tax advice, a
          rating, or a recommendation to engage or avoid any firm, and a disclosure is not a finding of wrongdoing. Verify
          everything against the official record.{' '}
          <a className="no-print" href={legalPath()} onClick={(e) => navigate(e, legalPath())}>Full disclaimer</a>
        </p>
        <p className="detail-note no-print">
          <a href={comparePath([firm.crd])} onClick={(e) => navigate(e, comparePath([firm.crd]))}>Compare this firm with others →</a>
        </p>
      </ReportSection>
    </article>
  )
}

export function PercentileBar({ rank, label }) {
  const pct = Math.max(0, Math.min(1, rank)) * 100
  return (
    <span className="pctile" title={`${label} percentile among peers`}>
      <span className="pctile-track" aria-hidden="true">
        <span className="pctile-mid" />
        <span className="pctile-dot" style={{ left: `${pct}%` }} />
      </span>
      <span className="pctile-label">{label}</span>
    </span>
  )
}
