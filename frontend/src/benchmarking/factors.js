// Registry of standing-score factors. Each factor turns a firm into a 0–1
// value; the engine weights and sums them per the active MethodologyConfig.
//
// normalize:
//   'percentile' — value is ranked against the firm's peer cohort
//   'ratio'      — accessor already returns 0–1; used as-is
// direction: 1 = higher is better, -1 = inverted before weighting.

export const staffOf = (f) => f.employees_advisory ?? f.employees_total ?? null

// Item 11 answers carry no dates in the bulk data, so the record factor is
// graded on flag count (capped, like the risk signal) rather than recency.
export const DISCLOSURE_GRADE_CAP = 4

export const FACTORS = [
  {
    id: 'scale',
    label: 'Scale',
    description: 'Total regulatory AUM, ranked within the peer cohort',
    normalize: 'percentile',
    direction: 1,
    defaultWeight: 0.4,
    accessor: (f) => f.aum_total,
  },
  {
    id: 'productivity',
    label: 'Productivity',
    description: 'AUM per advisory professional, ranked within the peer cohort',
    normalize: 'percentile',
    direction: 1,
    defaultWeight: 0.25,
    accessor: (f) => (staffOf(f) > 0 ? f.aum_total / staffOf(f) : NaN),
  },
  {
    id: 'feeAlignment',
    label: 'Fee alignment',
    description: 'Asset-based fees, reduced when commission compensation is also reported',
    normalize: 'ratio',
    direction: 1,
    defaultWeight: 0.15,
    accessor: (f) => (f.fee_pct_of_aum ? (f.fee_commissions ? 0.5 : 1) : 0),
  },
  {
    id: 'disciplinaryRecord',
    label: 'Disciplinary record',
    description: 'Graded down per Item 11 disclosure (only varies when the eligibility screen admits flagged firms)',
    normalize: 'ratio',
    direction: 1,
    defaultWeight: 0,
    accessor: (f) =>
      1 - Math.min(f.disciplinary_flag_count ?? 0, DISCLOSURE_GRADE_CAP) / DISCLOSURE_GRADE_CAP,
  },
  {
    id: 'hnwFocus',
    label: 'Individual / HNW focus',
    description: 'Share of clients who are individuals or high-net-worth individuals, ranked within the peer cohort',
    normalize: 'percentile',
    direction: 1,
    defaultWeight: 0,
    accessor: (f) => {
      const ind = f.pct_clients_individuals
      const hnw = f.pct_clients_hnw_individuals
      if (ind == null && hnw == null) return NaN
      return (ind ?? 0) + (hnw ?? 0)
    },
  },
]

export const FACTOR_BY_ID = Object.fromEntries(FACTORS.map((f) => [f.id, f]))
