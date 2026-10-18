import { describe, expect, it } from 'vitest'

import { compareChart, compareRows } from './compare.js'
import { comparePath, MAX_COMPARE, parseCompareFirms } from './router.js'

const firm = (crd, over = {}) => ({
  crd,
  legal_name: `FIRM ${crd}`,
  aum_mix: [100, 0, 0, 0],
  aum_total: 1e9,
  aum_discretionary: 8e8,
  accounts_total: 500,
  employees_total: 10,
  employees_advisory: 6,
  fee_pct_of_aum: true,
  disciplinary_flag_count: 0,
  ...over,
})

describe('compare URLs', () => {
  it('keeps digits only, drops repeats and caps the count', () => {
    expect(parseCompareFirms('?firms=1,2,2,abc,3')).toEqual([1, 2, 3])
    expect(parseCompareFirms('?firms=1,2,3,4,5,6')).toHaveLength(MAX_COMPARE)
    expect(parseCompareFirms('')).toEqual([])
    expect(comparePath([1, 2])).toMatch(/compare\?firms=1,2$/)
    expect(comparePath()).toMatch(/compare$/)
  })
})

describe('compareRows', () => {
  const a = firm(1)
  const b = firm(2, { aum_mix: [0, 0, 100, 0], employees_total: 4, employees_advisory: 4, fee_pct_of_aum: false })
  const extras = {
    1: { growth: { a5: 2.5, r5: 80, e5: 1.4, jump: 2024 }, growthMeta: { end_year: 2026 }, holdings: null, funds: null },
    2: { growth: { a5: 1.2 }, growthMeta: { end_year: 2026 }, holdings: null, funds: [{}, {}] },
  }
  const rows = compareRows([a, b], { allFirms: [a, b], fundTypes: null, extras })
  const get = (label) => rows.find((r) => r.label === label).values

  it('gives one value per firm, in order', () => {
    expect(get('Business model')).toEqual(['Wealth manager', 'Private fund manager'])
    expect(get('Discretionary')).toEqual(['80%', '80%'])
    expect(get('% of AUM')).toEqual(['Yes', 'No'])
  })

  it('shows growth with its peer rank when the firm has one', () => {
    expect(get('5-year AUM growth')).toEqual(['2.5× · faster than 80% of peers', '+20%'])
    expect(get('Largest one-year jump')).toEqual(['2024 (AUM at least doubled)', 'None since 2017'])
  })

  it('names firms with no support staff instead of a ratio', () => {
    expect(get('Non-advisory staff')).toEqual(['4', '0'])
    expect(get('AUM per non-advisory employee')[1]).toMatch(/No support staff|—/)
    expect(get('Private funds advised')).toEqual(['—', '2'])
  })

  it('shows a dash while a firm’s extra data is still loading', () => {
    const loading = compareRows([a], { allFirms: [a], extras: {} })
    expect(loading.find((r) => r.label === '5-year AUM growth').values).toEqual(['—'])
  })
})

describe('compareChart', () => {
  it('starts every line in the first year all firms report', () => {
    const extras = {
      1: { points: [{ year: 2013, aum: 1e8 }, { year: 2016, aum: 2e8 }, { year: 2026, aum: 4e8 }] },
      2: { points: [{ year: 2016, aum: 5e8 }, { year: 2026, aum: 6e8 }] },
    }
    const chart = compareChart([firm(1), firm(2)], extras)
    expect(chart.baseYear).toBe(2016)
    expect(chart.series.map((s) => s.slot)).toEqual([1, 2])
    expect(chart.rows.find((r) => r.year === 2026)).toEqual({ year: 2026, f1: 4e8, f2: 6e8 })
  })

  it('needs two firms with history', () => {
    expect(compareChart([firm(1), firm(2)], { 1: { points: [{ year: 2020, aum: 1 }] }, 2: { points: null } })).toBeNull()
  })
})
