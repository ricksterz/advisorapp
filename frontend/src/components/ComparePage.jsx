import { useEffect, useMemo } from 'react'

import { compareChart, compareRows, useCompareExtras } from '../compare.js'
import { comparePath, firmPath, MAX_COMPARE, navigate } from '../router.js'
import { useFundTypes } from '../segments.js'
import { resolveWebsite, useWebsiteOverrides } from '../websiteOverrides.js'
import FirmFavicon from './FirmFavicon.jsx'
import { websiteHost } from './FirmDetail.jsx'
import FirmSearch from './FirmSearch.jsx'
import IndexChart from './IndexChart.jsx'

const go = (crds) => {
  window.history.pushState(null, '', comparePath(crds))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const nameOf = (f) => f.business_name || f.legal_name

export default function ComparePage({ crds, allFirms }) {
  const overrides = useWebsiteOverrides()
  const fundTypes = useFundTypes()
  const firms = useMemo(
    () => (allFirms ? crds.map((crd) => allFirms.find((f) => f.crd === crd)).filter(Boolean) : []),
    [allFirms, crds],
  )
  const extras = useCompareExtras(firms.map((f) => f.crd))
  const loaded = firms.every((f) => extras[f.crd])

  useEffect(() => {
    document.title = firms.length
      ? `Compare ${firms.map(nameOf).join(' vs ')} · Open Disclosure`
      : 'Compare advisers · Open Disclosure'
  }, [firms])

  if (!allFirms) return <div className="state">Loading firm data…</div>

  const rows = compareRows(firms, { allFirms, fundTypes, extras })
  const chart = loaded ? compareChart(firms, extras) : null
  const missing = crds.filter((crd) => !firms.some((f) => f.crd === crd))

  return (
    <section className="compare-page" aria-label="Compare advisers">
      <div className="page-head">
        <h1>Compare advisers</h1>
        <p className="page-tagline">
          Up to {MAX_COMPARE} firms side by side, from their Form ADV filings. Share the page’s link to
          share the comparison.
        </p>
      </div>

      {firms.length < MAX_COMPARE && (
        <FirmSearch
          firms={allFirms}
          exclude={firms.map((f) => f.crd)}
          onSelect={(f) => go([...firms.map((g) => g.crd), f.crd])}
          placeholder="Add a firm by name or CRD"
          label="Add a firm to compare"
          className="compare-add"
        />
      )}
      {missing.length > 0 && (
        <p className="detail-note">
          No firm with CRD {missing.join(', ')} in this snapshot; it may have withdrawn its registration.
        </p>
      )}

      {firms.length === 0 ? (
        <p className="detail-empty">Search above to add firms, or use “Compare” on any firm’s page.</p>
      ) : (
        <>
          <div className="detail-card compare-card">
            <div className="compare-table-wrap">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th scope="col" className="compare-label-col">
                      <span className="sr-only">Measure</span>
                    </th>
                    {firms.map((f, i) => {
                      const site = resolveWebsite(overrides, f.crd, f.website_url)
                      const host = site.url ? websiteHost(site.url) : null
                      return (
                        <th key={f.crd} scope="col">
                          <div className="compare-firm">
                            <span className={`scaling-swatch series-${i + 1}`} aria-hidden="true" />
                            <FirmFavicon host={host} className="rank-favicon" />
                            <a className="firm-link" href={firmPath(f.crd)} onClick={(e) => navigate(e, firmPath(f.crd))}>
                              {nameOf(f)}
                            </a>
                            <button
                              type="button"
                              className="compare-remove"
                              aria-label={`Remove ${nameOf(f)}`}
                              title="Remove from comparison"
                              onClick={() => go(firms.filter((g) => g.crd !== f.crd).map((g) => g.crd))}
                            >
                              ×
                            </button>
                          </div>
                          <div className="compare-sub">CRD {f.crd}</div>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <FragmentRow key={r.label} row={r} first={i === 0 || rows[i - 1].group !== r.group} cols={firms.length} />
                  ))}
                </tbody>
              </table>
            </div>
            {!loaded && <p className="detail-note">Loading growth, holdings and fund data…</p>}
          </div>

          {chart && (
            <div className="detail-card compare-card compare-chart">
              <h2>AUM growth since {chart.baseYear}</h2>
              <IndexChart
                rows={chart.rows}
                series={chart.series}
                baseYear={chart.baseYear}
                describe={`Each firm's AUM as a multiple of its ${chart.baseYear} level. Values are on each firm's page.`}
              />
              <p className="detail-note">
                Each firm’s regulatory AUM from the SEC’s January report of each year, as a multiple of
                its {chart.baseYear} level, the first year all of them report. Growth includes markets,
                new clients and acquisitions alike.
              </p>
            </div>
          )}

          <p className="detail-note">
            Percentiles and “peers” compare each firm with firms of the same business model and size,
            as on its own page. Business model comes from where the firm says its AUM comes from (Form
            ADV Item 5.D). A dash means the firm didn’t report the figure or isn’t covered by that
            data set.
          </p>
        </>
      )}
    </section>
  )
}

function FragmentRow({ row, first, cols }) {
  return (
    <>
      {first && (
        <tr className="compare-group">
          <th scope="rowgroup" colSpan={cols + 1}>
            {row.group}
          </th>
        </tr>
      )}
      <tr>
        <th scope="row" className="compare-label-col">
          {row.label}
        </th>
        {row.values.map((v, i) => (
          <td key={i}>{v}</td>
        ))}
      </tr>
    </>
  )
}
