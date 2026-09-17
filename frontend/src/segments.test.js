import { describe, expect, it } from 'vitest'

import { firmSegment, firmTags, hasBrokerDealerTies, isFamilyOfficeStyle } from './segments.js'

// Shares by name, packed the way firms.json carries them.
const firm = ({ wealth = 0, registered = 0, privateFunds = 0, institutional = 0, ...over } = {}) => ({
  crd: 1,
  legal_name: 'ACME ADVISORS LLC',
  aum_mix: [wealth, registered, privateFunds, institutional],
  ...over,
})

describe('firmSegment', () => {
  it('puts a firm in the group holding more than half its AUM', () => {
    expect(firmSegment(firm({ wealth: 85, institutional: 15 }))).toBe('wealth')
    expect(firmSegment(firm({ privateFunds: 60, institutional: 40 }))).toBe('private_funds')
    expect(firmSegment(firm({ registered: 51, wealth: 49 }))).toBe('registered_funds')
    expect(firmSegment(firm({ institutional: 100 }))).toBe('institutional')
  })

  it('calls a book with no majority mixed, including an exact split', () => {
    expect(firmSegment(firm({ wealth: 40, privateFunds: 35, institutional: 25 }))).toBe('mixed')
    expect(firmSegment(firm({ wealth: 50, institutional: 50 }))).toBe('mixed')
  })

  it('has no segment when the filing breaks out no AUM by client type', () => {
    expect(firmSegment({ crd: 1, legal_name: 'X' })).toBeNull()
  })
})

describe('tags', () => {
  it('marks wealth managers with very large average clients as family-office style', () => {
    expect(isFamilyOfficeStyle(firm({ wealth: 100, aum_per_hnw_client: 40e6 }))).toBe(true)
    expect(isFamilyOfficeStyle(firm({ wealth: 100, aum_per_hnw_client: 3e6 }))).toBe(false)
    // A fund manager with large investors is not a family office.
    expect(isFamilyOfficeStyle(firm({ privateFunds: 100, aum_per_hnw_client: 90e6 }))).toBe(false)
  })

  it('always counts a firm that calls itself a family office', () => {
    expect(isFamilyOfficeStyle(firm({ legal_name: 'SMITH FAMILY OFFICE LLC', institutional: 100 }))).toBe(true)
  })

  it('counts broker-dealer registration or affiliation as broker-dealer ties', () => {
    expect(hasBrokerDealerTies(firm({ broker_dealer: 'registered' }))).toBe(true)
    expect(hasBrokerDealerTies(firm({ broker_dealer: 'affiliated' }))).toBe(true)
    expect(hasBrokerDealerTies(firm({}))).toBe(false)
  })

  it('shows a private fund manager its main fund type, and no one else', () => {
    const fundTypes = { firms: { 1: 'venture', 2: 'hedge' } }
    expect(firmTags(firm({ privateFunds: 90 }), fundTypes).map((t) => t.label)).toEqual(['Venture capital'])
    expect(firmTags(firm({ crd: 2, wealth: 90 }), fundTypes)).toEqual([])
    expect(firmTags(firm({ privateFunds: 90 }), undefined)).toEqual([])
  })
})
