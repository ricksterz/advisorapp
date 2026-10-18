import { describe, expect, it } from 'vitest'

import { firmTrajectory, fmtMultiple, growthSummary } from './trajectory.js'

const DATA = {
  years: [2013, 2014, 2015, 2016, 2017, 2018],
  span_years: 5,
  segment_growth: { wealth: { pairs: 100, slope: 0.5, intercept: 0 } },
  firms: {
    1: [
      [100, 200, null, 300, 400, 400],
      [10, 12, null, 14, 15, 16],
      [4, 0, null, 6, 7, 8],
      [50, 60, null, 70, 80, 90],
    ],
    2: [[null, null, null, null, null, 50], [null, null, null, null, null, 3], [null, null, null, null, null, 1], [null, null, null, null, null, 9]],
  },
}

describe('firmTrajectory', () => {
  it('unpacks the yearly arrays and skips years with no AUM', () => {
    const pts = firmTrajectory(DATA, 1)
    expect(pts.map((p) => p.year)).toEqual([2013, 2014, 2016, 2017, 2018])
    expect(pts[0]).toEqual({ year: 2013, aum: 1e8, employees: 10, support: 4, accounts: 50 })
  })

  it('is null for a firm with fewer than two years', () => {
    expect(firmTrajectory(DATA, 2)).toBeNull()
    expect(firmTrajectory(DATA, 3)).toBeNull()
    expect(firmTrajectory(undefined, 1)).toBeNull()
  })
})

describe('growthSummary', () => {
  it('compares first and last years, and the typical staff for that AUM growth', () => {
    const pts = firmTrajectory(DATA, 1)
    const g = growthSummary(pts, DATA.segment_growth.wealth, DATA.span_years)
    expect(g.first.year).toBe(2013)
    expect(g.last.year).toBe(2018)
    expect(g.years).toBe(5)
    expect(g.aumMultiple).toBe(4)
    expect(g.supportMultiple).toBe(2)
    // slope 0.5: four times the AUM -> twice the staff, from 4 people.
    expect(g.expectedSupport).toBeCloseTo(8)
  })

  it('scales the flat-AUM drift to the firm’s own span', () => {
    const pts = [
      { year: 2013, aum: 1e8, support: 10 },
      { year: 2023, aum: 1e8, support: 10 },
    ]
    const g = growthSummary(pts, { slope: 0.5, intercept: Math.log(1.1) }, 5)
    expect(g.expectedSupport).toBeCloseTo(12.1) // two five-year spans at +10%
  })

  it('needs two years with support staff, at least two years apart', () => {
    expect(growthSummary([{ year: 2013, aum: 1, support: 0 }, { year: 2020, aum: 2, support: 3 }], null, 5)).toBeNull()
    expect(growthSummary([{ year: 2019, aum: 1, support: 2 }, { year: 2020, aum: 2, support: 3 }], null, 5)).toBeNull()
    const g = growthSummary([{ year: 2013, aum: 1, support: 2 }, { year: 2020, aum: 2, support: 3 }], null, 5)
    expect(g.expectedSupport).toBeNull()
  })
})

describe('fmtMultiple', () => {
  it('uses × from a doubling up, percentages below', () => {
    expect([3.2, 12.4, 2, 1.4, 0.75, 1].map(fmtMultiple)).toEqual(['3.2×', '12×', '2.0×', '+40%', '−25%', 'unchanged'])
  })
})
