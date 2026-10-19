import { useFirmGrowth } from '../growth.js'
import { fmtCompactUsd, fmtCount } from '../pulse.js'
import { navigate, pulsePath } from '../router.js'
import { SEGMENT_BY_ID } from '../segments.js'
import { firmTrajectory, fmtMultiple, growthSummary, useTrajectoryData } from '../trajectory.js'
import IndexChart from './IndexChart.jsx'
import DataNote from './DataNote.jsx'

// AUM and both kinds of staff, indexed to the first year both AUM and
// support staff are above zero.
const SERIES = [
  { key: 'aum', label: 'AUM', slot: 1, fmt: fmtCompactUsd },
  { key: 'advisory', label: 'Advisory staff', slot: 2, fmt: fmtCount },
  { key: 'support', label: 'Non-advisory staff', slot: 3, fmt: fmtCount },
]

function withAdvisory(points) {
  return points.map((p) => ({
    ...p,
    advisory: p.employees != null && p.support != null ? p.employees - p.support : null,
  }))
}

function summarySentence(g, segment) {
  const aum = `AUM grew ${fmtMultiple(g.aumMultiple)}`.replace('grew −', 'fell ').replace('grew unchanged', 'was unchanged')
  const support = `non-advisory staff went from ${fmtCount(g.first.support)} to ${fmtCount(g.last.support)}`
  let out = `From ${g.first.year} to ${g.last.year}, ${aum} and ${support}.`
  if (g.expectedSupport != null && segment) {
    const seg = SEGMENT_BY_ID[segment]
    const expected = g.expectedSupport >= 10 ? fmtCount(g.expectedSupport) : g.expectedSupport.toFixed(1)
    const ratio = g.last.support / g.expectedSupport
    const verdict =
      Math.abs(ratio - 1) < 0.15
        ? 'about the typical number'
        : ratio < 1
          ? `${Math.round((1 - ratio) * 100)}% fewer than typical`
          : ratio >= 2
            ? `${ratio.toFixed(1)} times the typical number`
            : `${Math.round((ratio - 1) * 100)}% more than typical`
    const who = segment === 'mixed' ? 'A firm with a mixed client base' : `A typical ${seg.label.toLowerCase()}`
    out += ` ${who} whose AUM changed that much over ${g.years} years would have about ${expected}, so this firm has ${verdict}.`
  }
  return out
}

// Where the firm's AUM growth ranks among peers, for the longest period it
// has a rank for: "faster than 88% of wealth managers ...".
function PeerRank({ crd, segment }) {
  const growth = useFirmGrowth(crd)
  if (!growth || !segment) return null
  const { entry, medians, endYear, rankFloor } = growth
  const period = [10, 5, 3].find((k) => entry[`r${k}`] != null)
  if (!period) return null
  const rank = entry[`r${period}`]
  const median = medians?.[segment]?.[String(period)]?.median
  const seg = SEGMENT_BY_ID[segment]
  const peers = segment === 'mixed' ? 'firms with a mixed client base' : seg.plural
  const path = pulsePath('growth')
  const jumped = entry.jump != null && entry.jump > endYear - period
  return (
    <p className="growth-rank">
      Over the last {period} years, AUM grew <strong>{fmtMultiple(entry[`a${period}`])}</strong>, faster
      than {Math.max(1, Math.min(99, rank))}% of {peers} that started above $
      {Math.round(rankFloor / 1e6)}M{median ? ` (median ${fmtMultiple(median)})` : ''}.
      {jumped && ` Much of it came in ${entry.jump}, when AUM at least doubled in a single year, usually an acquisition or merger.`}{' '}
      <a href={path} onClick={(e) => navigate(e, path)}>
        See the fastest growers →
      </a>
    </p>
  )
}

export default function GrowthCard({ crd, segment }) {
  const data = useTrajectoryData(crd)
  const raw = firmTrajectory(data, crd)
  if (!raw) return null
  const points = withAdvisory(raw)
  const fit = segment ? data.segment_growth?.[segment] : null
  const g = growthSummary(points, fit, data.span_years)
  const baseYear = g ? g.first.year : points[0].year

  return (
    <section className="detail-card growth-card">
      <h2>Growth since {points[0].year}</h2>
      {g ? (
        <p className="leverage-trend growth-summary">{summarySentence(g, segment)}</p>
      ) : (
        <p className="detail-note">
          The firm reports no non-advisory staff in enough years to compare its growth.
        </p>
      )}
      <PeerRank crd={crd} segment={segment} />
      <IndexChart
        rows={points}
        series={SERIES}
        baseYear={baseYear}
        describe={`AUM and staff as multiples of their ${baseYear} level. Values are listed in the table below.`}
      />
      <details className="growth-table">
        <summary>Year by year</summary>
        <div className="scaling-table-wrap">
          <table className="pulse-table">
            <thead>
              <tr>
                <th>January</th>
                <th className="num">AUM</th>
                <th className="num">Employees</th>
                <th className="num">Non-advisory</th>
                <th className="num">Accounts</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.year}>
                  <td>{p.year}</td>
                  <td className="num">{fmtCompactUsd(p.aum)}</td>
                  <td className="num">{fmtCount(p.employees)}</td>
                  <td className="num">{fmtCount(p.support)}</td>
                  <td className="num">{fmtCount(p.accounts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <DataNote>
        From the SEC’s registered-adviser report published each January, which shows each firm’s
        latest Form ADV, usually filed the spring before. A firm that didn’t amend repeats its
        figures, and a missing year means it wasn’t SEC-registered that January. AUM moves with
        markets as well as new clients. The comparison is fitted on how firms with the same
        business model changed their own non-advisory staff over five-year spans as their AUM
        changed.
      </DataNote>
    </section>
  )
}
