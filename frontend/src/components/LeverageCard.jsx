import { SEGMENT_BY_ID } from '../segments.js'
import { fmtCompactUsd } from '../pulse.js'

const fmtAccounts = (v) => (v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1))

// A fund counts as one account, so accounts per employee says little here.
const FUND_SEGMENTS = new Set(['private_funds', 'registered_funds'])

// Peer distribution on a log scale: whiskers 5th-95th percentile, box the
// middle half, a tick at the median, the firm as a dot. Log because AUM per
// employee spans three orders of magnitude within a single segment.
function DistributionStrip({ dist, value, format, label }) {
  const lo = Math.min(dist.p5, value) / 1.25
  const hi = Math.max(dist.p95, value) * 1.25
  const x = (v) => ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100
  const at = (v) => ({ left: `${x(v)}%` })
  const span = (a, b) => ({ left: `${x(a)}%`, width: `${x(b) - x(a)}%` })
  const dotX = x(value)
  return (
    <div className="dist" role="img" aria-label={`${label}: this firm ${format(value)}; peer median ${format(dist.median)}, middle half ${format(dist.p25)} to ${format(dist.p75)}`}>
      <div className="dist-plot">
        <span className="dist-whisker" style={span(dist.p5, dist.p95)} title={`5th–95th percentile: ${format(dist.p5)}–${format(dist.p95)}`} />
        <span className="dist-box" style={span(dist.p25, dist.p75)} title={`Middle half of peers: ${format(dist.p25)}–${format(dist.p75)}`} />
        <span className="dist-median" style={at(dist.median)} title={`Peer median: ${format(dist.median)}`} />
        <span className="dist-dot" style={at(value)} title={`This firm: ${format(value)}`} />
        <span
          className={`dist-dot-label${dotX > 75 ? ' end' : dotX < 25 ? ' start' : ''}`}
          style={at(value)}
        >
          {format(value)}
        </span>
      </div>
      <div className="dist-caption">
        Peers: median <strong>{format(dist.median)}</strong> · middle half {format(dist.p25)}–{format(dist.p75)} ·
        5th–95th percentile {format(dist.p5)}–{format(dist.p95)}
      </div>
    </div>
  )
}

function Metric({ title, stat, format, note }) {
  return (
    <div className="leverage-metric">
      <div className="leverage-metric-head">
        <span className="leverage-metric-title">{title}</span>
        <span className="leverage-metric-rank">
          higher than {Math.round(stat.rank * 100)}% of peers
        </span>
      </div>
      <DistributionStrip dist={stat} value={stat.value} format={format} label={title} />
      {note && <p className="detail-note">{note}</p>}
    </div>
  )
}

function trendSentence(profile, aum) {
  const { trend, staff, segment } = profile
  const seg = SEGMENT_BY_ID[segment]
  const expected = trend.expected >= 10 ? Math.round(trend.expected).toLocaleString() : trend.expected.toFixed(1)
  const ratio = trend.vsExpected + 1
  // Percentages stop reading well past a doubling: "1767% more" is 18.7 times.
  const verdict =
    Math.abs(ratio - 1) < 0.1
      ? 'in line with firms its size'
      : ratio >= 2
        ? `about ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} times the typical number for its size`
        : ratio <= 0.5
          ? `about ${Math.round(ratio * 100)}% of the typical number for its size`
          : ratio < 1
            ? `${Math.round((1 - ratio) * 100)}% fewer than typical for its size`
            : `${Math.round((ratio - 1) * 100)}% more than typical for its size`
  const subject = segment === 'mixed' ? 'firms with a mixed client base' : seg.plural
  return `At ${fmtCompactUsd(aum)}, the trend across ${subject} points to about ${expected} non-advisory employees. This firm has ${staff.toLocaleString()}, ${verdict}.`
}

export default function LeverageCard({ profile, firm }) {
  if (!profile) return null
  const seg = SEGMENT_BY_ID[profile.segment]
  const firmName = firm.business_name || firm.legal_name
  const zeroShare = profile.segmentFirms ? profile.zeroStaffInSegment / profile.segmentFirms : 0
  const zeroNote = `${profile.zeroStaffInSegment.toLocaleString()} of ${profile.segmentFirms.toLocaleString()} ${seg.plural} (${Math.round(zeroShare * 100)}%) report no non-advisory staff and are left out of these comparisons.`

  return (
    <section className="detail-card leverage-card">
      <h2>Operational leverage</h2>
      {profile.noSupportStaff ? (
        <p className="detail-note leverage-intro">
          All {firm.employees_total?.toLocaleString()} of {firmName}’s employees do advisory work, so
          there’s no support staff to measure assets or accounts against. {zeroNote}
        </p>
      ) : (
        <>
          <p className="detail-note leverage-intro">
            How much each non-advisory employee supports, compared with{' '}
            {profile.peerCount.toLocaleString()} {seg.plural}
            {profile.peerBand ? ` with ${profile.peerBand} in AUM` : ' of every size (too few firms in its AUM band to compare within it)'}.
          </p>
          <div className="leverage-metrics">
            <Metric title="AUM per non-advisory employee" stat={profile.aumPer} format={fmtCompactUsd} />
            {profile.accountsPer && !FUND_SEGMENTS.has(profile.segment) && (
              <Metric title="Accounts per non-advisory employee" stat={profile.accountsPer} format={fmtAccounts} />
            )}
          </div>
          {FUND_SEGMENTS.has(profile.segment) && (
            <p className="detail-note">
              Accounts per employee isn’t compared for fund managers, where each fund counts as a
              single account.
            </p>
          )}
          {profile.trend && (
            <p className="leverage-trend">
              {trendSentence(profile, firm.aum_total)} Across{' '}
              {profile.segment === 'mixed' ? 'these firms' : seg.plural}, a firm with twice the AUM
              typically has about {Math.round(profile.trend.doubling * 100)}% more non-advisory staff.
            </p>
          )}
        </>
      )}
      <p className="detail-note">
        Non-advisory employees are all employees (Form ADV Item 5.A) minus those doing advisory
        work (Item 5.B(1)): operations, compliance, client service and support. Segments come from
        where the firm says its AUM comes from (Item 5.D). Peers are compared by median and
        percentile, not average. The trend line compares firms of different sizes at one point in
        time; it doesn’t track how any firm actually grew.
        {!profile.noSupportStaff && ` ${zeroNote}`}
      </p>
    </section>
  )
}
