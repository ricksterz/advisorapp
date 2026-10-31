// Eligibility screens and risk signals as data. The Top list and the Risk
// list each get their own screen set — they intentionally do not share one.

import { staffOf } from './factors.js'

// --- Top-list eligibility -------------------------------------------------
// params live in config.top; each predicate reads its own param by id.

export const TOP_SCREENS = [
  {
    id: 'minAum',
    label: 'Minimum regulatory AUM',
    unit: 'usd',
    defaultParam: 1e8,
    predicate: (f, v) => (f.aum_total ?? 0) >= v,
  },
  {
    id: 'minStaff',
    label: 'Minimum advisory professionals',
    unit: 'count',
    defaultParam: 3,
    predicate: (f, v) => (staffOf(f) ?? 0) >= v,
  },
  {
    id: 'maxDisclosures',
    label: 'Maximum disciplinary disclosures',
    unit: 'count',
    defaultParam: 0,
    predicate: (f, v) => (f.disciplinary_flag_count ?? 0) <= v,
  },
]

// --- Risk-list eligibility ------------------------------------------------

export const RISK_SCREENS = [
  {
    id: 'minAum',
    label: 'Minimum regulatory AUM',
    unit: 'usd',
    defaultParam: 1e8,
    predicate: (f, v) => (f.aum_total ?? 0) >= v,
  },
]

// --- Risk signals -----------------------------------------------------------
// The list is "disclosure outliers": firms whose record stands out against
// their peers, not firms whose record is merely long. Two traps it avoids:
//
//  * Form ADV Item 11 asks about the firm *or any advisory affiliate*, so a
//    conglomerate inherits every affiliate's history and the raw count climbs
//    with size: 63% of $100B+ firms report one, against 8% under $1B. Counted
//    raw and capped, it put more than half of all $100B+ firms on the list and
//    ranked the largest first.
//  * Affiliations and account counts describe large, diversified firms and
//    wrap-account platforms, not misconduct.
//
// So the default leads with a rate (the share of a firm's own registered
// advisors with disclosures), judges Item 11 counts within the firm's size
// band, and scores both on a sliding scale so the list is ordered by how far
// a firm stands out. The older raw signals stay available at zero points.
//
// Each signal returns { points, label } when tripped, or null. `points` in
// config.risk.points overrides defaultPoints; structural params live in
// config.risk.params. ctx carries the shared peer distributions.

export const RISK_PARAM_DEFAULTS = {
  minAdvisors: 20, // advisor share is only judged with at least this many advisors
  advisorShareCut: 0.9, // flag firms whose advisor share beats this share of peers
  sizeCut: 0.95, // flag Item 11 counts that beat this share of same-size peers
  disclosureCap: 4, // raw-count signal: disclosures scored up to this many
  minAffiliations: 3, // "dense affiliations" floor
  loadPercentile: 0.95, // accounts-per-professional percentile flagged as strain
}

// Item 11 peer bands: the count is compared within these, never across them.
export const RISK_SIZE_BANDS = [1e9, 1e10, 1e11]
export const riskSizeBand = (aum) => RISK_SIZE_BANDS.filter((b) => (aum ?? 0) >= b).length

/** Points on a sliding scale: 40% at the cut, all of them at the very top. */
export const slidingPoints = (points, share, cut) =>
  Math.round(points * (0.4 + (0.6 * (share - cut)) / (1 - cut)))

/** [advisors, advisors with disclosures] for a firm, or null. */
export const advisorCountsOf = (f, ctx) => ctx.advisorCounts?.[String(f.crd)] ?? null

export const RISK_SIGNALS = [
  {
    id: 'advisorDisclosures',
    label: 'Share of advisors with disclosures, top 10% of firms (sliding)',
    defaultPoints: 50,
    evaluate(f, points, params, ctx) {
      const counts = advisorCountsOf(f, ctx)
      if (!counts || counts[0] < params.minAdvisors || !ctx.advisorShareBelow) return null
      const rate = counts[1] / counts[0]
      const share = ctx.advisorShareBelow(rate)
      if (share < params.advisorShareCut) return null
      return {
        points: slidingPoints(points, share, params.advisorShareCut),
        label: `${Math.round(rate * 100)}% of ${counts[0].toLocaleString()} advisors have disclosures`,
      }
    },
  },
  {
    id: 'recentFirmDisclosures',
    label: 'Recent disclosure events against the firm itself, top 5% for its size (sliding)',
    defaultPoints: 25,
    evaluate(f, points, params, ctx) {
      const counts = ctx.disclosureIndex?.firms?.[String(f.crd)]
      const n = counts?.[0] ?? 0
      if (n <= 0 || !ctx.recentShareBelow) return null
      const share = ctx.recentShareBelow[riskSizeBand(f.aum_total)]?.(n) ?? 0
      if (share < params.sizeCut) return null
      return {
        points: slidingPoints(points, share, params.sizeCut),
        label: `${n} event${n === 1 ? '' : 's'} against the firm since ${ctx.disclosureIndex.since.slice(0, 4)}, top ${Math.max(1, Math.round((1 - share) * 100))}% for its size`,
      }
    },
  },
  {
    id: 'disclosuresForSize',
    label: 'Item 11 yes answers (firm and affiliates, undated), top 5% for its size (sliding)',
    defaultPoints: 0,
    evaluate(f, points, params, ctx) {
      const n = f.disciplinary_flag_count ?? 0
      if (n <= 0) return null
      const share = ctx.disclosureShareBelow[riskSizeBand(f.aum_total)]?.(n) ?? 0
      if (share < params.sizeCut) return null
      return {
        points: slidingPoints(points, share, params.sizeCut),
        label: `${n} Item 11 disclosures, top ${Math.max(1, Math.round((1 - share) * 100))}% for its size`,
      }
    },
  },
  {
    id: 'commissionsPlusPerf',
    label: 'Commissions + performance fees',
    defaultPoints: 10,
    evaluate(f, points) {
      if (!(f.fee_commissions && f.fee_performance_based)) return null
      return { points, label: 'Commissions + performance fees' }
    },
  },
  {
    id: 'disclosures',
    label: 'Item 11 disclosures, raw count (points per disclosure)',
    defaultPoints: 0,
    evaluate(f, points, params) {
      const n = f.disciplinary_flag_count ?? 0
      if (n <= 0) return null
      return {
        points: Math.min(n, params.disclosureCap) * points,
        label: `${n} disclosure${n > 1 ? 's' : ''}`,
      }
    },
  },
  {
    id: 'denseAffiliations',
    label: 'Dense affiliations',
    defaultPoints: 0,
    evaluate(f, points, params) {
      if ((f.affil_count ?? 0) < params.minAffiliations) return null
      return { points, label: 'Dense affiliations' }
    },
  },
  {
    id: 'highClientLoad',
    label: 'High client load',
    defaultPoints: 0,
    evaluate(f, points, params, ctx) {
      const s = staffOf(f)
      const load = s > 0 ? (f.accounts_total ?? 0) / s : null
      if (load == null || ctx.pLoad(load) < params.loadPercentile) return null
      return { points, label: 'High client load' }
    },
  },
]
