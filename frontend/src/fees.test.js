import { describe, expect, it } from 'vitest'

import {
  compareScenarios,
  decodeState,
  effectiveRate,
  encodeState,
  EXAMPLE_TIERED,
  normalizeTiers,
  project,
  sanitizeState,
  scheduleFee,
} from './fees.js'

const tiered = EXAMPLE_TIERED.schedule

describe('fee schedules', () => {
  it('charges each tier only on the assets within it', () => {
    // 1% of 1M + 0.8% of 4M + 0.6% of 5M + 0.4% of 10M
    expect(scheduleFee(20e6, tiered)).toBeCloseTo(10000 + 32000 + 30000 + 40000)
    expect(scheduleFee(1e6, tiered)).toBeCloseTo(10000)
    expect(effectiveRate(20e6, tiered)).toBeCloseTo(0.56)
  })
  it('charges the whole balance at its tier in "whole" mode', () => {
    expect(scheduleFee(20e6, { ...tiered, mode: 'whole' })).toBeCloseTo(80000)
    expect(scheduleFee(3e6, { ...tiered, mode: 'whole' })).toBeCloseTo(24000)
  })
  it('applies fixed fees and minimums', () => {
    expect(scheduleFee(1e5, { tiers: [{ upTo: null, rate: 1 }], minimum: 5000 })).toBe(5000)
    expect(scheduleFee(1e6, { tiers: [{ upTo: null, rate: 1 }], fixed: 2500 })).toBe(12500)
    expect(scheduleFee(0, { tiers: [{ upTo: null, rate: 1 }], minimum: 5000 })).toBe(0)
  })
  it('normalizes messy tiers', () => {
    expect(normalizeTiers([{ upTo: 5e6, rate: 0.5 }, { upTo: 1e6, rate: 1 }, { upTo: 1e6, rate: 9 }, { upTo: '', rate: 99 }])).toEqual([
      { upTo: 1e6, rate: 1 },
      { upTo: 5e6, rate: 0.5 },
      { upTo: null, rate: 10 },
    ])
    expect(normalizeTiers([])).toEqual([{ upTo: null, rate: 0 }])
  })
})

describe('projection', () => {
  it('compounds return net of costs, checked by hand', () => {
    const p = project(
      { assets: 1e6, years: 2, grossReturn: 10, flow: 0 },
      { schedule: { tiers: [{ upTo: null, rate: 1 }] }, fundExpense: 0.5, otherCost: 0 },
    )
    // y1: 1,000,000 + 100,000 − 10,000 − 5,000 = 1,085,000
    expect(p.rows[0].end).toBeCloseTo(1085000)
    // y2: 1,085,000 × 1.1 − 10,850 − 5,425 = 1,177,225
    expect(p.rows[1].end).toBeCloseTo(1177225)
    expect(p.totals.advisoryFee).toBeCloseTo(20850)
  })
  it('never goes negative under heavy withdrawals', () => {
    const p = project({ assets: 1e6, years: 5, grossReturn: 0, flow: -500000 }, { schedule: { tiers: [{ upTo: null, rate: 1 }] } })
    expect(p.rows.every((r) => r.end >= 0)).toBe(true)
  })
  it('measures cost against the same portfolio with no costs, including lost growth', () => {
    const r = compareScenarios({ assets: 1e6, years: 10, grossReturn: 6, flow: 0 }, [
      { label: 'A', schedule: { tiers: [{ upTo: null, rate: 1 }] }, fundExpense: 0, otherCost: 0 },
    ])
    const s = r.scenarios[0]
    expect(s.costVsBaseline).toBeGreaterThan(s.totals.all) // compounding makes the gap bigger than the fees paid
    expect(s.firstYearRate).toBeCloseTo(1)
  })
})

describe('shareable state', () => {
  it('round-trips and sanitizes', () => {
    const state = sanitizeState({ assumptions: { assets: 5e6, years: 15, grossReturn: 5 }, scenarios: [EXAMPLE_TIERED] })
    expect(decodeState(encodeState(state))).toEqual(state)
  })
  it('rejects garbage and clamps nonsense', () => {
    expect(decodeState('%%%')).toBeNull()
    expect(decodeState('x'.repeat(5000))).toBeNull()
    const s = sanitizeState({ assumptions: { assets: -5, years: 900, grossReturn: 'x' }, scenarios: [{ schedule: { tiers: [{ rate: 500 }] }, label: 7 }] })
    expect(s.assumptions.assets).toBe(0)
    expect(s.assumptions.years).toBe(50)
    expect(s.scenarios[0].schedule.tiers[0].rate).toBe(10)
    expect(s.scenarios[0].label).toBe('Schedule A')
  })
})

describe('parseMoney', () => {
  it('reads common ways of writing amounts', async () => {
    const { parseMoney } = await import('./fees.js')
    expect(parseMoney('$1,000,000')).toBe(1e6)
    expect(parseMoney('2.5m')).toBe(2.5e6)
    expect(parseMoney('750K')).toBe(750000)
    expect(parseMoney('-50k')).toBe(-50000)
    expect(parseMoney('abc')).toBeNull()
    expect(parseMoney('')).toBeNull()
  })
})
