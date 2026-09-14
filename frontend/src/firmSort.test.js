import { describe, expect, it } from 'vitest'

import { SORT_DEFS, compareFirms, makeComparator } from './firmSort.js'

const firm = (overrides) => ({
  crd: 1,
  legal_name: 'ACME LLC',
  business_name: null,
  aum_total: 100,
  aum_discretionary: 50,
  employees_advisory: 5,
  employees_total: 10,
  fee_pct_of_aum: false,
  fee_performance_based: false,
  fee_commissions: false,
  affil_count: 0,
  disciplinary_flag_count: 0,
  ...overrides,
})

describe('SORT_DEFS', () => {
  it('has a definition for every sortable column the table renders', () => {
    expect(Object.keys(SORT_DEFS)).toEqual([
      'firm',
      'aum',
      'discretionary',
      'staff',
      'fee',
      'affiliations',
      'flags',
      'deal',
      'bios',
    ])
  })

  it('names prefer the display name, falling back to the legal name', () => {
    const withBoth = firm({ business_name: 'Acme', legal_name: 'ACME LLC' })
    expect(SORT_DEFS.firm.key(withBoth)).toBe('acme')
    expect(SORT_DEFS.firm.key(firm({ business_name: null }))).toBe('acme llc')
  })

  it('sorts discretionary by share of AUM, not the dollar amount', () => {
    // Same $50 discretionary, but a $100 firm and a $1000 firm — the dollar
    // figure would rank them the same or backwards; the share must not.
    const small = firm({ aum_total: 100, aum_discretionary: 50 })
    const big = firm({ aum_total: 1000, aum_discretionary: 50 })
    expect(SORT_DEFS.discretionary.key(small)).toBe(0.5)
    expect(SORT_DEFS.discretionary.key(big)).toBe(0.05)
  })

  it('discretionary is null (not zero) for a firm with no AUM on file', () => {
    expect(SORT_DEFS.discretionary.key(firm({ aum_total: null }))).toBeNull()
  })

  it('staff falls back to total headcount when advisory headcount is missing', () => {
    expect(SORT_DEFS.staff.key(firm({ employees_advisory: null, employees_total: 7 }))).toBe(7)
  })

  it('fee ranks a performance-fee firm above one with only AUM and commission fees', () => {
    const performance = firm({ fee_performance_based: true })
    const both = firm({ fee_pct_of_aum: true, fee_commissions: true })
    expect(SORT_DEFS.fee.key(performance)).toBeGreaterThan(SORT_DEFS.fee.key(both))
  })

  it('deal structuring distinguishes a confirmed-clean scan from never scanned', () => {
    const ctx = { dealFlagsData: { firms: { 1: { pf: false, rs: false, gp: false }, 2: { pf: true, rs: false, gp: false } } } }
    expect(SORT_DEFS.deal.key(firm({ crd: 1 }), ctx)).toBe(0)
    expect(SORT_DEFS.deal.key(firm({ crd: 2 }), ctx)).toBe(1)
    expect(SORT_DEFS.deal.key(firm({ crd: 999 }), ctx)).toBeNull()
  })

  it('bios counts the firm entry, or null when the firm has none on file', () => {
    const ctx = { advisorBiosData: { firms: { 1: [{ name: 'A' }, { name: 'B' }] } } }
    expect(SORT_DEFS.bios.key(firm({ crd: 1 }), ctx)).toBe(2)
    expect(SORT_DEFS.bios.key(firm({ crd: 2 }), ctx)).toBeNull()
  })
})

describe('compareFirms', () => {
  it('pushes a missing value to the end regardless of which side it is on', () => {
    const withValue = firm({ aum_total: 5 })
    const missing = firm({ aum_total: null })
    expect(compareFirms(missing, withValue, SORT_DEFS.aum, {})).toBe(1)
    expect(compareFirms(withValue, missing, SORT_DEFS.aum, {})).toBe(-1)
  })

  it('treats two missing values as equal', () => {
    const a = firm({ aum_total: null })
    const b = firm({ aum_total: null })
    expect(compareFirms(a, b, SORT_DEFS.aum, {})).toBe(0)
  })
})

describe('makeComparator', () => {
  it('sorts numeric columns biggest-first by default', () => {
    const rows = [firm({ crd: 1, aum_total: 5 }), firm({ crd: 2, aum_total: 50 }), firm({ crd: 3, aum_total: 20 })]
    const sorted = [...rows].sort(makeComparator('aum', 'desc'))
    expect(sorted.map((f) => f.crd)).toEqual([2, 3, 1])
  })

  it('reverses on the "asc" direction', () => {
    const rows = [firm({ crd: 1, aum_total: 5 }), firm({ crd: 2, aum_total: 50 })]
    const sorted = [...rows].sort(makeComparator('aum', 'asc'))
    expect(sorted.map((f) => f.crd)).toEqual([1, 2])
  })

  it('keeps missing values last in ascending order', () => {
    const rows = [
      firm({ crd: 1, aum_total: 5 }),
      firm({ crd: 2, aum_total: null }),
      firm({ crd: 3, aum_total: 50 }),
    ]
    const ascending = [...rows].sort(makeComparator('aum', 'asc'))
    expect(ascending.map((f) => f.crd)).toEqual([1, 3, 2])
  })

  it('keeps missing values last in descending order too', () => {
    // The real bug: Bernard L. Madoff Investment Securities has no staff
    // count on file. Sorting "Advisory staff" descending (its default
    // direction) put that null row at the very top instead of the bottom —
    // the direction flip was being applied to the null sentinel along with
    // the real values, inverting "sorts last" into "sorts first".
    const rows = [
      firm({ crd: 1, employees_advisory: 5 }),
      firm({ crd: 2, employees_advisory: null, employees_total: null }),
      firm({ crd: 3, employees_advisory: 50 }),
    ]
    const descending = [...rows].sort(makeComparator('staff', 'desc'))
    expect(descending.map((f) => f.crd)).toEqual([3, 1, 2])
  })

  it('sorts the name column alphabetically ascending by default', () => {
    const rows = [
      firm({ crd: 1, business_name: 'Zebra Capital' }),
      firm({ crd: 2, business_name: 'Acme Advisors' }),
    ]
    const sorted = [...rows].sort(makeComparator('firm', 'asc'))
    expect(sorted.map((f) => f.crd)).toEqual([2, 1])
  })

  it('breaks ties on the firm name so equal-value rows do not reshuffle', () => {
    const rows = [
      firm({ crd: 1, business_name: 'Zebra', affil_count: 3 }),
      firm({ crd: 2, business_name: 'Acme', affil_count: 3 }),
    ]
    const sorted = [...rows].sort(makeComparator('affiliations', 'desc'))
    expect(sorted.map((f) => f.crd)).toEqual([2, 1])
  })
})
