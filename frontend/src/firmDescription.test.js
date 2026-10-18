import { describe, expect, it } from 'vitest'

import { firmDescription } from './components/FirmDetail.jsx'

describe('firmDescription', () => {
  it('matches the description etl/firm_prerender.py writes into the served page', () => {
    // Same firm and expected text as etl/tests/test_firm_prerender.py.
    const firm = {
      crd: 151736,
      business_name: 'PATHSTONE',
      legal_name: 'PATHSTONE FAMILY OFFICE, LLC',
      state: 'NJ',
      aum_mix: [83, 0, 10, 7],
      aum_total: 110_000_000_000,
      employees_total: 704,
      disciplinary_flag_count: 1,
    }
    expect(firmDescription(firm)).toBe(
      'PATHSTONE (CRD 151736, NJ): wealth manager with $110B in regulatory AUM, 704 employees, ' +
        '1 disciplinary disclosure. Fees, client mix, staffing and growth from SEC Form ADV filings.',
    )
  })
})
