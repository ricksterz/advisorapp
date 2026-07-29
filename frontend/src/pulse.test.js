import { describe, expect, it } from 'vitest'

import { deltaView, fmtCompactUsd, fmtCount, fmtPct, fmtQuarter } from './pulse.js'

describe('fmtQuarter', () => {
  it('renders quarter-end ISO dates as Q-labels', () => {
    expect(fmtQuarter('2026-06-30')).toBe('Q2 2026')
    expect(fmtQuarter('2025-12-31')).toBe('Q4 2025')
    expect(fmtQuarter('2025-03-31')).toBe('Q1 2025')
    expect(fmtQuarter(null)).toBe('')
  })
})

describe('formatters', () => {
  it('fmtCompactUsd scales units', () => {
    expect(fmtCompactUsd(177.5e12)).toBe('$177.5T')
    expect(fmtCompactUsd(4.4e8)).toBe('$440M')
    expect(fmtCompactUsd(2.5e9)).toBe('$2.5B')
    expect(fmtCompactUsd(null)).toBe('—')
  })

  it('fmtCompactUsd keeps a decimal in single-digit millions', () => {
    // Form D medians sit in the $1-2M range; rounding to whole millions made
    // a nearly-flat series read as if it were swinging between $1M and $2M.
    expect(fmtCompactUsd(1_311_618)).toBe('$1.3M')
    expect(fmtCompactUsd(1_600_000)).toBe('$1.6M')
    expect(fmtCompactUsd(9_900_000)).toBe('$9.9M')
    // Double-digit millions and up stay whole — unchanged from before.
    expect(fmtCompactUsd(10_000_000)).toBe('$10M')
    expect(fmtCompactUsd(48_000_000)).toBe('$48M')
  })

  it('fmtCount and fmtPct', () => {
    expect(fmtCount(17151)).toBe('17,151')
    expect(fmtCount(null)).toBe('—')
    expect(fmtPct(0.1174)).toBe('11.7%')
    expect(fmtPct(null)).toBe('—')
  })
})

describe('deltaView', () => {
  it('positive delta is an up arrow, good by default', () => {
    const v = deltaView(0.059)
    expect(v.arrow).toBe('▲')
    expect(v.text).toBe('+5.9%')
    expect(v.tone).toBe('good')
  })

  it('negative delta is a down arrow, bad by default', () => {
    const v = deltaView(-0.028)
    expect(v.arrow).toBe('▼')
    expect(v.text).toBe('−2.8%')
    expect(v.tone).toBe('bad')
  })

  it('goodWhenDown flips tone, not direction', () => {
    // fewer firms with disclosures is an improvement
    const v = deltaView(-0.023, { goodWhenDown: true })
    expect(v.arrow).toBe('▼')
    expect(v.tone).toBe('good')
    const w = deltaView(0.02, { goodWhenDown: true })
    expect(w.arrow).toBe('▲')
    expect(w.tone).toBe('bad')
  })

  it('null delta hides, near-zero renders flat', () => {
    expect(deltaView(null)).toBeNull()
    const v = deltaView(0.0001)
    expect(v.arrow).toBe('–')
    expect(v.tone).toBe('flat')
  })
})

describe('concentration', () => {
  it('computes $1B+ share from band sums, with deltas', async () => {
    const { concentrationSeries, concentrationKpi } = await import('./pulse.js')
    const q = (small, big) => ({
      bands: [
        { id: 'lt100m', raum: small / 2 },
        { id: '100m-1b', raum: small / 2 },
        { id: '1b-10b', raum: big / 2 },
        { id: '10b+', raum: big / 2 },
      ],
    })
    const series = [q(20, 80), q(10, 90)] // 80% then 90%
    expect(concentrationSeries(series)).toEqual([0.8, 0.9])
    const kpi = concentrationKpi(series)
    expect(kpi.value).toBe(0.9)
    expect(kpi.qoq).toBeCloseTo(0.125)
    expect(kpi.yoy).toBeNull() // fewer than 5 quarters
  })

  it('returns null share when a quarter has no band totals', async () => {
    const { concentrationSeries } = await import('./pulse.js')
    expect(concentrationSeries([{ bands: [{ id: '10b+', raum: 0 }] }])).toEqual([null])
  })
})
