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
