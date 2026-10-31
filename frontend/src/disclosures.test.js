import { describe, expect, it } from 'vitest'

import { titleCase } from './components/DisclosuresCard.jsx'

describe('titleCase', () => {
  it('softens capitals but keeps acronyms', () => {
    expect(titleCase('FINANCIAL INDUSTRY REGULATORY AUTHORITY (FINRA)')).toBe('Financial Industry Regulatory Authority (FINRA)')
    expect(titleCase('CME GROUP INC.')).toBe('CME Group Inc.')
    expect(titleCase('SECURITIES AND EXCHANGE COMMISSION')).toBe('Securities And Exchange Commission')
    expect(titleCase('Already Mixed')).toBe('Already Mixed')
  })
})
