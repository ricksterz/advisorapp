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
// Each signal returns { points, label } when tripped, or null. `points` in
// config.risk.points overrides defaultPoints; structural params (caps,
// thresholds) live in config.risk.params. ctx carries shared percentilers.

export const RISK_PARAM_DEFAULTS = {
  disclosureCap: 4, // disclosures scored up to this many
  minAffiliations: 3, // "dense affiliations" floor
  loadPercentile: 0.95, // accounts-per-professional percentile flagged as strain
}

export const RISK_SIGNALS = [
  {
    id: 'disclosures',
    label: 'Disciplinary disclosures (points per disclosure)',
    defaultPoints: 15,
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
    id: 'commissionsPlusPerf',
    label: 'Commissions + performance fees',
    defaultPoints: 15,
    evaluate(f, points) {
      if (!(f.fee_commissions && f.fee_performance_based)) return null
      return { points, label: 'Commissions + performance fees' }
    },
  },
  {
    id: 'denseAffiliations',
    label: 'Dense affiliations',
    defaultPoints: 10,
    evaluate(f, points, params) {
      if ((f.affil_count ?? 0) < params.minAffiliations) return null
      return { points, label: 'Dense affiliations' }
    },
  },
  {
    id: 'highClientLoad',
    label: 'High client load',
    defaultPoints: 15,
    evaluate(f, points, params, ctx) {
      const s = staffOf(f)
      const load = s > 0 ? (f.accounts_total ?? 0) / s : null
      if (load == null || ctx.pLoad(load) < params.loadPercentile) return null
      return { points, label: 'High client load' }
    },
  },
]
