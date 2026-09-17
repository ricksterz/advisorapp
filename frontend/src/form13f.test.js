import { describe, expect, it } from 'vitest'

import { edgarFilingUrl, holdingsView } from './form13f.js'

const DATA = {
  period: '2026-06-30',
  filers: {
    '0001214717': { name: 'GEODE CAPITAL MANAGEMENT, LLC', cik: '0001214717', accession: '0001214717-26-000005', value: 1875315674155, positions: 4447, top: [], values_reliable: true },
    '0002012383': { name: 'BlackRock, Inc.', cik: '0002012383', accession: '0002012383-26-000010', value: 6712575664618, positions: 5652, top: [], values_reliable: true },
  },
  firms: {
    115504: { cik: '0001214717', own: true, matched: 'crd' },
    105247: { cik: '0002012383', own: false, matched: 'included_manager' },
  },
}

describe('holdingsView', () => {
  it("shows a firm's own filing", () => {
    const v = holdingsView(DATA, 115504)
    expect(v.own).toBe(true)
    expect(v.filer.name).toBe('GEODE CAPITAL MANAGEMENT, LLC')
    expect(v.period).toBe('2026-06-30')
  })

  it("marks a subsidiary as covered by its parent's combined filing, not its own", () => {
    const v = holdingsView(DATA, '105247')
    expect(v.own).toBe(false)
    expect(v.filer.name).toBe('BlackRock, Inc.')
  })

  it('is null for a firm with no 13F, or before the file loads', () => {
    expect(holdingsView(DATA, 999)).toBeNull()
    expect(holdingsView(undefined, 115504)).toBeNull()
    expect(holdingsView(null, 115504)).toBeNull()
  })
})

describe('edgarFilingUrl', () => {
  it('points at the filing folder on EDGAR', () => {
    expect(edgarFilingUrl('0001214717', '0001214717-26-000005')).toBe(
      'https://www.sec.gov/Archives/edgar/data/1214717/000121471726000005/',
    )
    expect(edgarFilingUrl(null, 'x')).toBeNull()
  })
})
