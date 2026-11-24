import { useEffect, useState } from 'react'

import { holdingsView } from './form13f.js'
import { leverageProfile, nonAdvisoryStaff } from './leverage.js'
import { fmtCompactUsd, fmtCount, ordinal } from './pulse.js'
import { aumShare, firmSegment, firmTags, SEGMENT_BY_ID } from './segments.js'
import { loadShard } from './shards.js'
import { firmTrajectory, fmtMultiple } from './trajectory.js'
import { staffOf } from './benchmarking/factors.js'
import { conflictIndicators } from './intel.js'
import { describeRank, metricStats, peerCohort, PEER_METRIC_BY_ID } from './peers.js'
import { ITEMS } from './sources.js'

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
const ordinalPct = (r) => `${ordinal(Math.max(1, Math.min(99, Math.round(r * 100))))} percentile`

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
  const cohorts = firms.map((f) => peerCohort(f, allFirms))
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

    row('Peer position', 'AUM per advisory professional', (f, i) => peerCell(f, cohorts[i], 'aum_per_pro')),
    row('Peer position', 'Accounts per advisory professional', (f, i) => peerCell(f, cohorts[i], 'accounts_per_pro')),
    row('Peer position', 'High-net-worth share of clients', (f, i) => peerCell(f, cohorts[i], 'hnw_clients')),
    row('Peer position', 'Peer group', (f, i) => (cohorts[i] ? `${cohorts[i].peers.length.toLocaleString()} ${cohorts[i].label}` : 'Too few comparable firms')),

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

    ...CONFLICT_ROWS.map((id) =>
      row('Conflict indicators', CONFLICT_LABELS[id], (f) => {
        const ex = x(f)
        const c = conflictIndicators(f, {
          dealFlags: ex ? ex.flags : undefined,
          funds: ex ? (ex.funds ?? []) : undefined,
        }).find((k) => k.id === id)
        return STATUS_TEXT[c.status]
      }),
    ),

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


// Where each row group's figures come from, shown in the group's header.
export const GROUP_SOURCES = {
  Overview: `${ITEMS.aum}; ${ITEMS.clients}`,
  Staffing: ITEMS.staff,
  'Peer position': 'Calculated by this site within each firm’s own peer group (same business model and AUM band)',
  Growth: `${ITEMS.history}. Growth in assets managed, not investment returns`,
  Clients: ITEMS.clients,
  Fees: `${ITEMS.fees}. Fee types only; rates are in each brochure`,
  'Conflict indicators': `${ITEMS.fees}; ${ITEMS.affiliations}; ${ITEMS.privateFunds}; ${ITEMS.brochure} (keyword scan). Disclosed arrangements, not misconduct`,
  'Holdings & funds': `${ITEMS.holdings}; ${ITEMS.privateFunds}`,
  Record: `${ITEMS.disclosures}; ${ITEMS.affiliations}. A disclosure is not a finding of wrongdoing`,
}

const CONFLICT_ROWS = ['performance_fees', 'commissions', 'broker_dealer', 'private_funds', 'deal_pf', 'deal_rs', 'deal_gp']
const CONFLICT_LABELS = {
  performance_fees: 'Performance-based fees',
  commissions: 'Commissions',
  broker_dealer: 'Broker-dealer ties',
  private_funds: 'Advises private funds',
  deal_pf: 'Proprietary funds (brochure)',
  deal_rs: 'Revenue sharing / referrals (brochure)',
  deal_gp: 'Affiliated GP / LP (brochure)',
}
const STATUS_TEXT = { disclosed: 'Disclosed', not_reported: 'Not reported', not_covered: 'Not covered', loading: '…' }

function peerCell(f, cohort, id) {
  if (!cohort) return '—'
  const m = metricStats(PEER_METRIC_BY_ID[id], f, cohort.peers)
  const r = describeRank(m.rank)
  if (m.value == null) return 'Not reported'
  const v = m.kind === 'usd' ? fmtCompactUsd(m.value) : m.kind === 'pct' ? `${Math.round(m.value)}%` : Math.round(m.value).toLocaleString()
  return r ? `${v} · ${ordinal(r.pct)} percentile` : v
}

/**
 * The differences worth reading first, in plain English: [{ id, text }].
 * Numeric gaps of 2× or more, and arrangements some firms report and others
 * don't. Pure.
 */
export function meaningfulDifferences(firms) {
  if (firms.length < 2) return []
  const out = []
  const name = (f) => f.business_name || f.legal_name
  const ratios = [
    ['aum', 'regulatory AUM', (f) => f.aum_total, fmtCompactUsd],
    ['aum_per_pro', 'AUM per advisory professional', (f) => (staffOf(f) > 0 ? f.aum_total / staffOf(f) : null), fmtCompactUsd],
    ['accounts_per_pro', 'accounts per advisory professional', (f) => (staffOf(f) > 0 && f.accounts_total != null ? f.accounts_total / staffOf(f) : null), (v) => Math.round(v).toLocaleString()],
    ['aum_per_account', 'AUM per account', (f) => (f.accounts_total > 0 ? f.aum_total / f.accounts_total : null), fmtCompactUsd],
  ]
  for (const [id, label, fn, fmt] of ratios) {
    const vals = firms.map((f) => ({ f, v: fn(f) })).filter((x) => x.v != null && x.v > 0)
    if (vals.length < 2) continue
    vals.sort((a, b) => b.v - a.v)
    const hi = vals[0]
    const lo = vals[vals.length - 1]
    const r = hi.v / lo.v
    if (r >= 2) {
      out.push({ id, text: `${name(hi.f)} has ${r >= 10 ? Math.round(r) : r.toFixed(1)}× the ${label} of ${name(lo.f)} (${fmt(hi.v)} vs ${fmt(lo.v)}).` })
    }
  }
  const shareGap = [
    ['hnw', 'high-net-worth share of clients', (f) => f.pct_clients_hnw_individuals],
    ['disc', 'discretionary share of AUM', (f) => (f.aum_total > 0 && f.aum_discretionary != null ? (f.aum_discretionary / f.aum_total) * 100 : null)],
  ]
  for (const [id, label, fn] of shareGap) {
    const vals = firms.map((f) => ({ f, v: fn(f) })).filter((x) => x.v != null)
    if (vals.length < 2) continue
    vals.sort((a, b) => b.v - a.v)
    const gap = vals[0].v - vals[vals.length - 1].v
    if (gap >= 25) {
      out.push({ id, text: `The ${label} ranges from ${Math.round(vals[vals.length - 1].v)}% (${name(vals[vals.length - 1].f)}) to ${Math.round(vals[0].v)}% (${name(vals[0].f)}).` })
    }
  }
  const segs = new Set(firms.map((f) => firmSegment(f)).filter(Boolean))
  if (segs.size > 1) out.push({ id: 'segment', text: 'The firms have different business models, so their staffing and size figures describe different kinds of businesses.' })
  const yesNo = [
    ['fee_performance_based', 'performance-based fees', (f) => f.fee_performance_based === true],
    ['fee_commissions', 'commissions', (f) => f.fee_commissions === true],
    ['broker_dealer', 'broker-dealer ties', (f) => f.broker_dealer != null],
  ]
  for (const [id, label, test] of yesNo) {
    const yes = firms.filter(test)
    if (yes.length && yes.length < firms.length) {
      out.push({ id, text: `${yes.map(name).join(' and ')} report${yes.length === 1 ? 's' : ''} ${label}; ${firms.length - yes.length === 1 ? 'the other doesn’t' : 'the others don’t'}. A disclosed arrangement, not misconduct.` })
    }
  }
  const d = firms.map((f) => f.disciplinary_flag_count ?? 0)
  if (Math.max(...d) !== Math.min(...d)) {
    out.push({ id: 'record', text: `Item 11 disclosures range from ${Math.min(...d)} to ${Math.max(...d)}. Item 11 covers affiliates and settled matters; read the records before comparing counts.` })
  }
  return out
}

/** The comparison as CSV rows. */
export function compareCsvRows(firms, rows) {
  const name = (f) => f.business_name || f.legal_name
  return [
    ['Group', 'Measure', ...firms.map((f) => `${name(f)} (CRD ${f.crd})`), 'Source'],
    ...rows.map((r) => [r.group, r.label, ...r.values, GROUP_SOURCES[r.group] ?? '']),
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
