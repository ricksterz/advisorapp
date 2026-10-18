import { useEffect, useState } from 'react'

import { holdingsView } from './form13f.js'
import { leverageProfile, nonAdvisoryStaff } from './leverage.js'
import { fmtCompactUsd, fmtCount } from './pulse.js'
import { aumShare, firmSegment, firmTags, SEGMENT_BY_ID } from './segments.js'
import { loadShard } from './shards.js'
import { firmTrajectory, fmtMultiple } from './trajectory.js'
import { staffOf } from './benchmarking/factors.js'

// Side-by-side comparison of 2-4 firms (/compare?firms=...). Each firm's
// extra data comes from its own shards, the same slices its profile page
// loads, so comparing four firms costs at most four shards per dataset.

/** { [crd]: extras } once every firm's shards have loaded; {} until then. */
export function useCompareExtras(crds) {
  const [extras, setExtras] = useState({})
  const key = crds.join(',')
  useEffect(() => {
    let alive = true
    Promise.all(
      crds.map(async (crd) => {
        const [trajectory, growth, f13, funds, flags] = await Promise.all([
          loadShard('firm_trajectory', crd),
          loadShard('firm_growth', crd),
          loadShard('form_13f', crd),
          loadShard('firm_private_funds', crd),
          loadShard('deal_flags', crd),
        ])
        return [
          crd,
          {
            points: firmTrajectory(trajectory, crd),
            growth: growth?.firms?.[String(crd)] ?? null,
            growthMeta: growth,
            holdings: holdingsView(f13, crd),
            funds: funds?.firms?.[String(crd)] ?? null,
            flags: flags?.firms?.[String(crd)] ?? null,
          },
        ]
      }),
    ).then((entries) => {
      if (alive) setExtras(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
    // crds is rebuilt on every render; its joined value is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return extras
}

const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`)
const yesNo = (v) => (v == null ? '—' : v ? 'Yes' : 'No')
const ordinalPct = (r) => `${Math.max(1, Math.min(99, Math.round(r * 100)))}th percentile`

function growthCell(x, period) {
  const g = x?.growth
  const m = g?.[`a${period}`]
  if (m == null) return '—'
  const rank = g[`r${period}`]
  return rank != null
    ? `${fmtMultiple(m)} · faster than ${Math.max(1, Math.min(99, rank))}% of peers`
    : fmtMultiple(m)
}

/**
 * Table rows: [{ group, label, values: string[] }] for the firms in order.
 * ctx: { allFirms, fundTypes, extras }. Pure, so every row is testable.
 */
export function compareRows(firms, ctx) {
  const { allFirms, fundTypes, extras = {} } = ctx
  const leverage = firms.map((f) => leverageProfile(f, allFirms))
  const x = (f) => extras[f.crd]
  const row = (group, label, fn) => ({ group, label, values: firms.map((f, i) => fn(f, i)) })

  return [
    row('Overview', 'Business model', (f) => SEGMENT_BY_ID[firmSegment(f)]?.label ?? '—'),
    row('Overview', 'Tags', (f) => firmTags(f, fundTypes).map((t) => t.label).join(', ') || '—'),
    row('Overview', 'State', (f) => f.state ?? f.country ?? '—'),
    row('Overview', 'Regulatory AUM', (f) => fmtCompactUsd(f.aum_total)),
    row('Overview', 'Discretionary', (f) =>
      f.aum_total ? pct(((f.aum_discretionary ?? 0) / f.aum_total) * 100) : '—',
    ),
    row('Overview', 'Accounts', (f) => fmtCount(f.accounts_total)),

    row('Staffing', 'Employees', (f) => fmtCount(f.employees_total)),
    row('Staffing', 'Advisory staff', (f) => fmtCount(staffOf(f))),
    row('Staffing', 'Non-advisory staff', (f) => fmtCount(nonAdvisoryStaff(f))),
    row('Staffing', 'AUM per advisory professional', (f) =>
      staffOf(f) > 0 ? fmtCompactUsd(f.aum_total / staffOf(f)) : '—',
    ),
    row('Staffing', 'AUM per non-advisory employee', (f, i) => {
      const p = leverage[i]
      if (!p) return '—'
      if (p.noSupportStaff) return 'No support staff'
      return `${fmtCompactUsd(p.aumPer.value)} · ${ordinalPct(p.aumPer.rank)}`
    }),

    row('Growth', '5-year AUM growth', (f) => growthCell(x(f), 5)),
    row('Growth', '10-year AUM growth', (f) => growthCell(x(f), 10)),
    row('Growth', '5-year headcount change', (f) => {
      const e = x(f)?.growth?.e5
      return e == null ? '—' : fmtMultiple(e)
    }),
    row('Growth', 'Largest one-year jump', (f) => {
      const ex = x(f)
      if (!ex?.growthMeta) return '—'
      // growth_table looks back over the last ten reports.
      return ex.growth?.jump ? `${ex.growth.jump} (AUM at least doubled)` : `None since ${ex.growthMeta.end_year - 9}`
    }),

    row('Clients', 'AUM from individuals & HNW', (f) => pct(aumShare(f, 'wealth'))),
    row('Clients', 'AUM in private funds', (f) => pct(aumShare(f, 'private_funds'))),
    row('Clients', 'AUM in mutual funds, ETFs & BDCs', (f) => pct(aumShare(f, 'registered_funds'))),
    row('Clients', 'AUM from institutions', (f) => pct(aumShare(f, 'institutional'))),

    row('Fees', '% of AUM', (f) => yesNo(f.fee_pct_of_aum)),
    row('Fees', 'Performance-based', (f) => yesNo(f.fee_performance_based)),
    row('Fees', 'Commissions', (f) => yesNo(f.fee_commissions)),

    row('Holdings & funds', '13F reported value', (f) => {
      const h = x(f)?.holdings
      if (!h) return '—'
      if (!h.own) return `In ${h.filer.name}’s filing`
      return h.filer.values_reliable ? fmtCompactUsd(h.filer.value) : `${fmtCount(h.filer.positions)} positions`
    }),
    row('Holdings & funds', 'Largest 13F position', (f) => {
      const h = x(f)?.holdings
      return h?.own && h.filer.top?.[0] ? h.filer.top[0].issuer : '—'
    }),
    row('Holdings & funds', 'Private funds advised', (f) => {
      const funds = x(f)?.funds
      return funds?.length ? fmtCount(funds.length) : '—'
    }),

    row('Record', 'Disciplinary disclosures', (f) => fmtCount(f.disciplinary_flag_count ?? 0)),
    row('Record', 'Financial-industry affiliations', (f) => fmtCount(f.affil_count ?? 0)),
  ]
}

/**
 * Chart input: each firm's AUM by year, indexed from the latest year every
 * firm has AUM, so all lines start together at 1×.
 */
export function compareChart(firms, extras) {
  const withPoints = firms.filter((f) => extras[f.crd]?.points?.length)
  if (withPoints.length < 2) return null
  const byYear = new Map()
  for (const f of withPoints) {
    for (const p of extras[f.crd].points) {
      if (!byYear.has(p.year)) byYear.set(p.year, { year: p.year })
      byYear.get(p.year)[`f${f.crd}`] = p.aum
    }
  }
  const rows = [...byYear.values()].sort((a, b) => a.year - b.year)
  const baseRow = rows.find((r) => withPoints.every((f) => r[`f${f.crd}`] > 0))
  if (!baseRow) return null
  return {
    rows,
    baseYear: baseRow.year,
    series: withPoints.map((f) => ({
      key: `f${f.crd}`,
      label: f.business_name || f.legal_name,
      slot: firms.indexOf(f) + 1,
      fmt: fmtCompactUsd,
    })),
  }
}
