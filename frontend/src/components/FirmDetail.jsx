import { useEffect, useState } from 'react'

import { staffOf } from '../benchmarking/factors.js'
import { percentiler } from '../benchmarking/engine.js'
import { BASE, navigate } from '../router.js'
import { DEAL_FLAG_DEFS, useDealFlags } from '../dealFlags.js'
import { useAdvisorBios } from '../advisorBios.js'

// Public IAPD document endpoints (all CORS-enabled, no key required).
const firmApiUrl = (crd) => `https://api.adviserinfo.sec.gov/search/firm/${crd}`
const brochureUrl = (id) =>
  `https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=${id}`
const advPdfUrl = (crd) => `https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf`
const crsUrl = (crd) => `https://reports.adviserinfo.sec.gov/crs/crs_${crd}.pdf`
const iapdUrl = (crd) => `https://adviserinfo.sec.gov/firm/summary/${crd}`

const CLIENT_MIX_FIELDS = [
  ['pct_clients_individuals', 'Individuals'],
  ['pct_clients_hnw_individuals', 'High-net-worth individuals'],
  ['pct_clients_pooled_vehicles', 'Pooled investment vehicles'],
  ['pct_clients_pension_plans', 'Pension & profit-sharing plans'],
  ['pct_clients_corporations', 'Corporations'],
  ['pct_clients_other', 'Other'],
]

export const websiteHost = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Brochure and Form CRS links, fetched on demand when a detail view opens —
 * these have no bulk-data equivalent, so they are never in firms.json.
 * Anything that can't be confirmed to exist is simply not rendered.
 */
function useFirmDocs(crd) {
  const [docs, setDocs] = useState({ loading: true, brochures: [], crs: null, advPdf: null })

  useEffect(() => {
    let alive = true
    setDocs({ loading: true, brochures: [], crs: null, advPdf: null })

    const meta = fetch(firmApiUrl(crd))
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const source = json?.hits?.hits?.[0]?._source
        const content = source?.iacontent ? JSON.parse(source.iacontent) : null
        return {
          brochures: (content?.brochures?.brochuredetails ?? []).map((b) => ({
            id: b.brochureVersionID,
            name: b.brochureName,
            date: b.dateSubmitted,
          })),
          hasPdf: content?.basicInformation?.hasPdf === 'Y',
        }
      })
      .catch(() => ({ brochures: [], hasPdf: false }))

    // Form CRS only exists for firms with retail investors; probe and read
    // just the status, aborting before the PDF body downloads.
    const crsController = new AbortController()
    const crs = fetch(crsUrl(crd), { signal: crsController.signal })
      .then((r) => {
        const ok = r.ok
        crsController.abort()
        return ok
      })
      .catch(() => false)

    Promise.all([meta, crs]).then(([m, hasCrs]) => {
      if (!alive) return
      setDocs({
        loading: false,
        brochures: m.brochures,
        crs: hasCrs ? crsUrl(crd) : null,
        advPdf: m.hasPdf ? advPdfUrl(crd) : null,
      })
    })

    return () => {
      alive = false
      crsController.abort()
    }
  }, [crd])

  return docs
}

const fmtUsd = (v) =>
  v == null ? '—' : `$${Math.round(v).toLocaleString()}`

function DealStructuringCard({ crd }) {
  const flags = useDealFlags(crd)
  if (!flags) return null // still loading, file unavailable, or firm not scanned
  return (
    <div className="detail-card">
      <h2>Deal-structuring signals</h2>
      <div className="deal-flags">
        {DEAL_FLAG_DEFS.map(({ id, label, description, evidenceKey }) => (
          <div key={id} className="deal-flag" title={description}>
            <span
              className={flags[id] ? 'deal-flag-chip on' : 'deal-flag-chip'}
              role="img"
              aria-label={flags[id] ? 'Flagged' : 'Not flagged'}
            >
              {flags[id] ? '⚑' : '—'}
            </span>
            <span className="deal-flag-body">
              <span className="deal-flag-label">{label}</span>
              {flags[id] && flags.evidence?.[evidenceKey] && (
                <span className="deal-flag-quote">“…{flags.evidence[evidenceKey]}…”</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="detail-note">
        Keyword scan of the firm’s Form ADV Part 2A brochure(s) — a flag means the language
        appears affirmatively; it is context, not a finding. Read the brochure itself (linked
        above) before drawing conclusions.
      </p>
    </div>
  )
}

function AdvisorBiosCard({ crd }) {
  const bios = useAdvisorBios(crd)
  if (!bios || bios.length === 0) return null // loading, unavailable, or no advisors extracted for this firm
  return (
    <div className="detail-card advisor-bios-card">
      <h2>Advisor bios</h2>
      <div className="advisor-bios">
        {bios.map((b, i) => (
          <div key={`${b.source_version_id}-${i}`} className="advisor-bio">
            <div className="advisor-bio-name">
              {b.name}
              {b.crd && <span className="advisor-bio-crd">CRD {b.crd}</span>}
            </div>
            <p className="advisor-bio-text">{b.bio}</p>
          </div>
        ))}
      </div>
      <p className="detail-note">
        Text extracted from Form ADV Part 2B brochure supplement filings — each advisor’s own
        regulatory disclosure of their education and business background. Not verified or
        curated; it is context, not a finding. Read the source brochure (linked above) before
        drawing conclusions.
      </p>
    </div>
  )
}

const DEFAULT_TITLE = 'Open Disclosure — SEC Form ADV adviser benchmarking'
const SITE_URL = 'https://open-disclosure.com'

// Per-firm title + meta description: crawlers render JS, so this is what a
// firm's search result shows.
function usePageMeta(firm) {
  useEffect(() => {
    if (!firm) return undefined
    const name = firm.business_name || firm.legal_name
    document.title = `${name} — Form ADV profile · Open Disclosure`
    const meta = document.querySelector('meta[name="description"]')
    const prev = meta?.getAttribute('content')
    meta?.setAttribute(
      'content',
      `${name} (CRD ${firm.crd}${firm.state ? `, ${firm.state}` : ''}): regulatory AUM, ` +
        'client mix, fee structure, and disciplinary history from SEC Form ADV filings.',
    )
    // Without a per-route canonical, every firm page would claim the homepage
    // as its canonical URL and drop out of the index.
    const canonical = document.querySelector('link[rel="canonical"]')
    const prevCanonical = canonical?.getAttribute('href')
    canonical?.setAttribute('href', `${SITE_URL}/firm/${firm.crd}`)
    return () => {
      document.title = DEFAULT_TITLE
      if (prev != null) meta?.setAttribute('content', prev)
      if (prevCanonical != null) canonical?.setAttribute('href', prevCanonical)
    }
  }, [firm])
}

// "How does this compare?" — live percentile ranks vs same-AUM-band peers,
// computed client-side with the ranking engine's own percentiler (read-only
// reuse; no ranking behavior is touched). Bands match the app's canonical
// $100M/$1B/$10B cut points.
const bandOf = (aum) => {
  const v = aum ?? 0
  if (v >= 1e10) return '$10B+'
  if (v >= 1e9) return '$1B–$10B'
  if (v >= 1e8) return '$100M–$1B'
  return 'under $100M'
}

function CompareStrip({ firm, allFirms }) {
  if (!allFirms?.length) return null
  const band = bandOf(firm.aum_total)
  const peers = allFirms.filter((f) => bandOf(f.aum_total) === band)
  if (peers.length < 10) return null // a percentile over a handful of peers is noise

  const staff = staffOf(firm)
  const metrics = [
    {
      label: 'AUM',
      pct: percentiler(peers.map((f) => f.aum_total))(firm.aum_total),
      have: firm.aum_total != null,
    },
    {
      label: 'AUM per professional',
      pct: percentiler(peers.map((f) => (staffOf(f) > 0 ? f.aum_total / staffOf(f) : NaN)))(
        staff > 0 ? firm.aum_total / staff : NaN,
      ),
      have: staff > 0 && firm.aum_total != null,
    },
  ]
  const peerDisclosures = peers.map((f) => f.disciplinary_flag_count ?? 0).sort((a, b) => a - b)
  const medianDisclosures = peerDisclosures[Math.floor(peerDisclosures.length / 2)]

  return (
    <div className="compare-strip">
      <span className="compare-title">vs {peers.length.toLocaleString()} peers ({band}):</span>
      {metrics.filter((m) => m.have).map((m) => (
        <span key={m.label} className="compare-item">
          {m.label} <strong>{Math.round(m.pct * 100)}th</strong> pctile
        </span>
      ))}
      <span
        className={`compare-item ${
          (firm.disciplinary_flag_count ?? 0) > medianDisclosures ? 'compare-worse' : ''
        }`}
      >
        Disclosures <strong>{firm.disciplinary_flag_count ?? 0}</strong> vs median{' '}
        {medianDisclosures}
      </span>
    </div>
  )
}

function BackLink() {
  return (
    <a className="back-link" href={BASE} onClick={(e) => navigate(e, BASE)}>
      ← All firms
    </a>
  )
}

function OutboundLink({ href, children, sub }) {
  return (
    <a className="doc-link" href={href} target="_blank" rel="noreferrer">
      <span className="doc-link-name">{children} ↗</span>
      {sub && <span className="doc-link-sub">{sub}</span>}
    </a>
  )
}

export default function FirmDetail({ firm, crd, allFirms }) {
  const docs = useFirmDocs(crd)
  usePageMeta(firm)

  if (!firm) {
    return (
      <section className="firm-detail">
        <BackLink />
        <div className="state">No firm with CRD {crd} in this snapshot.</div>
      </section>
    )
  }

  const host = firm.website_url ? websiteHost(firm.website_url) : null
  const mixReported = CLIENT_MIX_FIELDS.some(([f]) => firm[f] != null)
  const discShare = firm.aum_total
    ? Math.max(0, Math.min(1, (firm.aum_discretionary ?? 0) / firm.aum_total))
    : null

  return (
    <section className="firm-detail">
      <BackLink />

      <div className="detail-head">
        <h1>{firm.business_name || firm.legal_name}</h1>
        <p className="detail-sub">
          {firm.business_name && firm.business_name !== firm.legal_name && (
            <>{firm.legal_name} · </>
          )}
          CRD {firm.crd}
          {firm.state && <> · {firm.state}</>}
        </p>
        <CompareStrip firm={firm} allFirms={allFirms} />
      </div>

      <div className="doc-links">
        {host && (
          <OutboundLink href={firm.website_url} sub="firm website">
            <img
              className="site-favicon"
              src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
              alt=""
              width="14"
              height="14"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
            {host}
          </OutboundLink>
        )}
        <OutboundLink href={iapdUrl(firm.crd)} sub="SEC / IAPD profile">
          adviserinfo.sec.gov
        </OutboundLink>
        {docs.advPdf && (
          <OutboundLink href={docs.advPdf} sub="full filing (PDF)">
            Form ADV
          </OutboundLink>
        )}
        {docs.crs && (
          <OutboundLink href={docs.crs} sub="relationship summary (PDF)">
            Form CRS
          </OutboundLink>
        )}
        {docs.brochures.map((b) => (
          <OutboundLink key={b.id} href={brochureUrl(b.id)} sub={`brochure · ${b.date}`}>
            {b.name.toLowerCase()}
          </OutboundLink>
        ))}
        {docs.loading && <span className="doc-loading">checking SEC filings…</span>}
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Regulatory AUM</div>
          <div className="value">{fmtUsd(firm.aum_total)}</div>
          {discShare != null && (
            <div className="sub">{Math.round(discShare * 100)}% discretionary</div>
          )}
        </div>
        <div className="tile">
          <div className="label">Advisory professionals</div>
          <div className="value">{staffOf(firm) ?? '—'}</div>
          {firm.employees_total != null && <div className="sub">{firm.employees_total} employees total</div>}
        </div>
        <div className="tile">
          <div className="label">Accounts</div>
          <div className="value">{firm.accounts_total?.toLocaleString() ?? '—'}</div>
        </div>
        <div className="tile">
          <div className="label">Disciplinary disclosures</div>
          <div className="value">{firm.disciplinary_flag_count ?? 0}</div>
          <div className="sub">Form ADV Item 11 — see IAPD for the underlying records</div>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-card">
          <h2>Client mix</h2>
          {mixReported ? (
            <div className="mix-bars">
              {CLIENT_MIX_FIELDS.map(([field, label]) => {
                const v = firm[field]
                if (v == null || v === 0) return null
                return (
                  <div key={field} className="mix-row">
                    <span className="mix-label">{label}</span>
                    <span className="track"><span className="fill" style={{ width: `${Math.min(100, v)}%` }} /></span>
                    <span className="mix-pct">{Math.round(v)}%</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="detail-empty">Not reported in this filing.</p>
          )}
        </div>

        <div className="detail-card">
          <h2>Compensation & affiliations</h2>
          <div className="fee-chips">
            {firm.fee_pct_of_aum && <span className="fee-chip">% of AUM</span>}
            {firm.fee_performance_based && <span className="fee-chip">Performance-based</span>}
            {firm.fee_commissions && <span className="fee-chip">Commissions</span>}
            {!firm.fee_pct_of_aum && !firm.fee_performance_based && !firm.fee_commissions && (
              <span className="flag-none">No fee types reported</span>
            )}
          </div>
          <p className="detail-note">
            {firm.affil_count
              ? `${firm.affil_count} financial-industry affiliation${firm.affil_count > 1 ? 's' : ''} reported (Item 7.A).`
              : 'No financial-industry affiliations reported (Item 7.A).'}
          </p>
        </div>

        <DealStructuringCard crd={firm.crd} />
        <AdvisorBiosCard crd={firm.crd} />
      </div>
    </section>
  )
}
