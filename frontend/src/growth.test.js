import { describe, expect, it } from 'vitest'

import { annualized, leaders } from './growth.js'

const firm = (crd, mix, aum) => ({ crd, legal_name: `F${crd}`, aum_mix: mix, aum_total: aum })
const WEALTH = [100, 0, 0, 0]
const FUNDS = [0, 0, 100, 0]

const FIRMS = [
  firm(1, WEALTH, 5e9),
  firm(2, WEALTH, 5e8),
  firm(3, FUNDS, 2e10),
  firm(4, WEALTH, 2e9),
  firm(5, WEALTH, 3e9),
]
const GROWTH = {
  end_year: 2026,
  firms: {
    1: { a5: 3.0, e5: 1.5, r5: 95 },
    2: { a5: 4.0, r5: 99 },
    3: { a5: 9.0, r5: 99, jump: 2024 },
    4: { a5: 6.0, r5: 98, jump: 2019 }, // before the 5-year window: still steady
    5: { a5: 2.0 }, // started below the floor, so no rank: not listed
  },
}

describe('leaders', () => {
  it('ranks firms with a rank for the period by AUM multiple', () => {
    expect(leaders(GROWTH, FIRMS, { period: 5 }).map((r) => r.firm.crd)).toEqual([3, 4, 2, 1])
  })

  it('filters by business model and today’s size', () => {
    expect(leaders(GROWTH, FIRMS, { period: 5, segment: 'wealth' }).map((r) => r.firm.crd)).toEqual([4, 2, 1])
    expect(leaders(GROWTH, FIRMS, { period: 5, segment: 'wealth', size: '1b' }).map((r) => r.firm.crd)).toEqual([4, 1])
  })

  it('can leave out firms whose growth came in one step inside the window', () => {
    const rows = leaders(GROWTH, FIRMS, { period: 5, steadyOnly: true })
    expect(rows.map((r) => r.firm.crd)).toEqual([4, 2, 1])
    expect(leaders(GROWTH, FIRMS, { period: 5 })[0].jump).toBe(2024)
    expect(rows[0].jump).toBeNull()
  })

  it('is empty until both files load', () => {
    expect(leaders(undefined, FIRMS, { period: 5 })).toEqual([])
    expect(leaders(GROWTH, null, { period: 5 })).toEqual([])
  })
})

describe('annualized', () => {
  it('turns a multiple into a yearly rate', () => {
    expect(annualized(2, 1)).toBeCloseTo(1)
    expect(annualized(1.21, 2)).toBeCloseTo(0.1)
  })
})
