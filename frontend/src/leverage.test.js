import { describe, expect, it } from 'vitest'

import {
  bandLabelOf,
  distribution,
  fitLogLog,
  leverageHeadline,
  leverageProfile,
  MIN_PEERS,
  nonAdvisoryStaff,
  percentileRank,
  scalingCurves,
} from './leverage.js'

const usd = (v) => `$${Math.round(v / 1e6)}M`

describe('nonAdvisoryStaff', () => {
  it('is all employees minus advisory employees', () => {
    expect(nonAdvisoryStaff({ employees_total: 8, employees_advisory: 4 })).toBe(4)
    expect(nonAdvisoryStaff({ employees_total: 3, employees_advisory: 3 })).toBe(0)
  })

  it('is unknown when either count is missing or they contradict each other', () => {
    expect(nonAdvisoryStaff({ employees_total: 8 })).toBeNull()
    expect(nonAdvisoryStaff({ employees_total: 2, employees_advisory: 5 })).toBeNull()
  })
})

describe('statistics', () => {
  it('interpolates quantiles and ranks ties as half', () => {
    const d = distribution([4, 1, 3, 2, 5])
    expect(d.median).toBe(3)
    expect(d.p25).toBe(2)
    expect(percentileRank(d.sorted, 3)).toBe(0.5)
    expect(percentileRank(d.sorted, 10)).toBe(1)
  })

  it('recovers the scaling exponent of a power law', () => {
    // staff = 0.001 * aum^0.5: doubling AUM multiplies staff by sqrt(2).
    const pts = [1e8, 4e8, 1.6e9, 6.4e9].map((a) => [a, 0.001 * Math.sqrt(a)])
    const fit = fitLogLog(pts)
    expect(fit.slope).toBeCloseTo(0.5, 6)
    expect(fit.doubling).toBeCloseTo(Math.SQRT2 - 1, 6)
    expect(fit.expectedStaff(1e10)).toBeCloseTo(100, 4)
  })

  it('bands AUM', () => {
    expect(bandLabelOf(1e8)).toBe('under $250M')
    expect(bandLabelOf(5.78e8)).toBe('$250M–$1B')
    expect(bandLabelOf(3e10)).toBe('$25B+')
  })
})

// Wealth managers between $250M and $1B, non-advisory staff rising with AUM.
function wealthFirms(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    crd: 1000 + i,
    legal_name: `FIRM ${i}`,
    aum_mix: [100, 0, 0, 0],
    aum_total: 3e8 + i * 1e7,
    accounts_total: 200 + i,
    employees_advisory: 3,
    employees_total: 3 + 2 + (i % 4),
    ...over,
  }))
}

describe('leverageProfile', () => {
  it('compares a firm with its segment and AUM band', () => {
    const firms = wealthFirms(MIN_PEERS + 10)
    const target = { crd: 1, legal_name: 'T', aum_mix: [100, 0, 0, 0], aum_total: 5.78e8, accounts_total: 94, employees_total: 8, employees_advisory: 4 }
    firms.push(target)
    const p = leverageProfile(target, firms)
    expect(p.segment).toBe('wealth')
    expect(p.peerBand).toBe('$250M–$1B')
    expect(p.staff).toBe(4)
    expect(p.aumPer.value).toBeCloseTo(1.445e8)
    expect(p.aumPer.rank).toBeGreaterThan(0.5)
    expect(p.accountsPer.value).toBeCloseTo(23.5)
    expect(p.trend.expected).toBeGreaterThan(0)
    expect(leverageHeadline(p, target.aum_total, usd)).toMatch(
      /^A wealth manager with \$578M in AUM: each of its 4 non-advisory employees supports \$145M, (above|below|close to) the \$\d+M median for wealth managers with \$250M–\$1B\.$/,
    )
  })

  it('falls back to the whole segment when the band is too small to rank against', () => {
    const firms = wealthFirms(MIN_PEERS + 5)
    const giant = { crd: 2, legal_name: 'G', aum_mix: [100, 0, 0, 0], aum_total: 5e10, employees_total: 400, employees_advisory: 100 }
    firms.push(giant)
    const p = leverageProfile(giant, firms)
    expect(p.peerBand).toBeNull()
    expect(p.peerCount).toBe(MIN_PEERS + 6)
    expect(leverageHeadline(p, giant.aum_total, usd)).toContain('all wealth managers')
  })

  it('names firms with no support staff instead of ranking them', () => {
    const firms = wealthFirms(MIN_PEERS)
    const solo = { crd: 3, legal_name: 'S', aum_mix: [100, 0, 0, 0], aum_total: 9e7, employees_total: 1, employees_advisory: 1 }
    firms.push(solo)
    const p = leverageProfile(solo, firms)
    expect(p.noSupportStaff).toBe(true)
    expect(p.zeroStaffInSegment).toBe(1)
    expect(leverageHeadline(p, solo.aum_total, usd)).toContain('reports no separate operations or support staff')
  })

  it('is null when the firm has no segment or headcount', () => {
    const firms = wealthFirms(5)
    expect(leverageProfile({ crd: 4, aum_total: 1e9, employees_total: 5, employees_advisory: 1 }, firms)).toBeNull()
    expect(leverageProfile({ crd: 5, aum_mix: [100, 0, 0, 0], aum_total: 1e9 }, firms)).toBeNull()
  })
})

describe('scalingCurves', () => {
  it('bins firms by half-decade of AUM and drops thin bins', () => {
    const firms = [
      ...wealthFirms(20, { aum_total: 2e8 }), // one bin: $100M–$316M
      ...wealthFirms(5, { aum_total: 5e9 }), // too few to plot
    ]
    const curve = scalingCurves(firms).wealth
    expect(curve).toHaveLength(1)
    expect(curve[0].n).toBe(20)
    expect(curve[0].aum).toBeCloseTo(10 ** 8.25)
    expect(curve[0].staff).toBeGreaterThan(0)
  })
})
