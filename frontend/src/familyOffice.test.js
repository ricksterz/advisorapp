import { describe, expect, it } from 'vitest'

import { isFamilyOffice } from './familyOffice.js'

describe('isFamilyOffice', () => {
  it('matches on the legal name', () => {
    expect(isFamilyOffice({ legal_name: 'PATHSTONE FAMILY OFFICE, LLC', business_name: 'PATHSTONE' })).toBe(true)
  })

  it('matches on the business name when the legal name differs', () => {
    expect(isFamilyOffice({ legal_name: 'WE ADVISORS INC', business_name: 'WE FAMILY OFFICES' })).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isFamilyOffice({ legal_name: 'stenger family office, llc' })).toBe(true)
  })

  it('requires the whole phrase, not just "family" or "office" alone', () => {
    expect(isFamilyOffice({ legal_name: 'SMITH FAMILY WEALTH MANAGEMENT' })).toBe(false)
    expect(isFamilyOffice({ legal_name: 'CORNER OFFICE CAPITAL' })).toBe(false)
  })

  it('is false for a firm with no matching name and tolerates missing fields', () => {
    expect(isFamilyOffice({ legal_name: 'ACME WEALTH ADVISORS LLC', business_name: null })).toBe(false)
    expect(isFamilyOffice({ legal_name: 'ACME WEALTH ADVISORS LLC' })).toBe(false)
  })
})
