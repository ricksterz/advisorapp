import { DEAL_FLAG_DEFS } from './dealFlags.js'

// Every sortable column in the dense "all firms" table, keyed by the id its
// SortHeader uses. `key` pulls the value to compare out of a firm (plus the
// async deal-flags/advisor-bios maps for the two columns backed by those
// separate files, passed in as `ctx`); `type` picks numeric vs. locale-aware
// string comparison; `defaultDir` is which way a first click on that header
// sorts — biggest/most first for numbers, A→Z for the name.
//
// A missing value always sorts to the very end regardless of direction, so
// reversing a numeric column doesn't dredge up every "—" row to the top.
export const SORT_DEFS = {
  firm: {
    defaultDir: 'asc',
    type: 'string',
    key: (f) => (f.business_name || f.legal_name || '').toLowerCase(),
  },
  aum: {
    defaultDir: 'desc',
    type: 'number',
    key: (f) => f.aum_total,
  },
  discretionary: {
    // Sorts by discretionary *share* of AUM, not the dollar amount — that's
    // what the meter in this column actually shows.
    defaultDir: 'desc',
    type: 'number',
    key: (f) => (f.aum_total ? (f.aum_discretionary ?? 0) / f.aum_total : null),
  },
  staff: {
    defaultDir: 'desc',
    type: 'number',
    key: (f) => f.employees_advisory ?? f.employees_total,
  },
  fee: {
    // Fee structure is a handful of independent yes/no chips, not a single
    // scalar, so there's no one "correct" order. This ranks a firm by how
    // many — and which — chips it discloses: any performance-based fee first
    // (the least common and most consequential), then AUM-based, then
    // commissions, so firms with more disclosed structures float up.
    defaultDir: 'desc',
    type: 'number',
    key: (f) =>
      (f.fee_performance_based ? 4 : 0) + (f.fee_pct_of_aum ? 2 : 0) + (f.fee_commissions ? 1 : 0),
  },
  affiliations: {
    defaultDir: 'desc',
    type: 'number',
    key: (f) => f.affil_count,
  },
  flags: {
    defaultDir: 'desc',
    type: 'number',
    key: (f) => f.disciplinary_flag_count,
  },
  deal: {
    // Distinguishes "scanned, nothing found" (0) from "not scanned" (null,
    // sorts last) even though the cell itself renders both as "—" — for
    // sorting, a confirmed clean firm is more informative than an unknown one.
    defaultDir: 'desc',
    type: 'number',
    key: (f, ctx) => {
      const flags = ctx.dealFlagsData?.firms?.[String(f.crd)]
      return flags ? DEAL_FLAG_DEFS.filter((d) => flags[d.id]).length : null
    },
  },
  bios: {
    defaultDir: 'desc',
    type: 'number',
    key: (f, ctx) => ctx.advisorBiosData?.firms?.[String(f.crd)]?.length ?? null,
  },
}

// `sign` flips the *value* comparison only (1 = ascending, -1 = descending).
// A missing value always returns 1/-1 to sort last, independent of `sign` —
// applying the direction flip to that sentinel too was the bug: it put
// Bernard L. Madoff Investment Securities' null staff count at the very top
// of a descending "Advisory staff" sort instead of the bottom, because -1
// (missing, "sorts after") times sign -1 (descending) came out to +1
// ("sorts before"). Missing data has no direction; only real values do.
export function compareFirms(a, b, def, ctx, sign = 1) {
  const av = def.key(a, ctx)
  const bv = def.key(b, ctx)
  const aMissing = av == null
  const bMissing = bv == null
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1
  const cmp = def.type === 'string' ? av.localeCompare(bv) : av - bv
  return cmp * sign
}

/** A ready-to-use Array.prototype.sort comparator for one column + direction. */
export function makeComparator(sortField, sortDir, ctx = {}) {
  const def = SORT_DEFS[sortField]
  const sign = sortDir === 'asc' ? 1 : -1
  return (a, b) => {
    const cmp = compareFirms(a, b, def, ctx, sign)
    if (cmp !== 0) return cmp
    // Stable, readable tie-break so equal values (two firms both with 0
    // affiliations, say) don't reshuffle on every render.
    return (a.business_name || a.legal_name || '').localeCompare(b.business_name || b.legal_name || '')
  }
}
