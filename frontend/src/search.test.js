import { describe, expect, it } from 'vitest'

import { normalize, resultDetail, searchFirms } from './search.js'

const firm = (crd, legal_name, business_name, aum_total = 1e9) => ({ crd, legal_name, business_name, aum_total })
const FIRMS = [
  firm(108156, 'JACKSON, GRANT INVESTMENT ADVISERS, INC.', null, 5e8),
  firm(250, 'EDWARD D. JONES & CO., L.P.', 'EDWARD JONES', 1e12),
  firm(118, 'EDWARD JONES TRUST COMPANY', null, 2e10),
  firm(151736, 'PATHSTONE FAMILY OFFICE, LLC', 'PATHSTONE', 1.1e11),
  firm(160489, 'AH CAPITAL MANAGEMENT, L.L.C.', 'ANDREESSEN HOROWITZ', 1e11),
  firm(2501, 'GRANT STREET ADVISORS', null, 3e9),
]
const names = (q) => searchFirms(FIRMS, q).map((f) => f.crd)

describe('searchFirms', () => {
  it('ignores case and punctuation and needs every word', () => {
    expect(names('jackson grant')).toEqual([108156])
    expect(names('JACKSON, GRANT')).toEqual([108156])
  })

  it('puts the exact name first, then larger firms', () => {
    expect(names('edward jones')).toEqual([250, 118])
    expect(names('grant')).toEqual([2501, 108156])
  })

  it('matches the business name and the legal name', () => {
    expect(names('andreessen')).toEqual([160489])
    expect(names('ah capital')).toEqual([160489])
    expect(names('pathstone family office')).toEqual([151736])
  })

  it('reads digits as a CRD prefix, exact CRD first', () => {
    expect(names('250')).toEqual([250, 2501])
    expect(names('1517')).toEqual([151736])
  })

  it('waits for two letters and ignores empty input', () => {
    expect(names('e')).toEqual([])
    expect(names('  ')).toEqual([])
    expect(searchFirms(null, 'x')).toEqual([])
  })
})

describe('helpers', () => {
  it('normalizes ampersands and punctuation', () => {
    expect(normalize('A&B, Inc.')).toBe('a and b inc')
  })

  it('describes a result', () => {
    expect(resultDetail({ crd: 1, state: 'NY', aum_mix: [100, 0, 0, 0] })).toBe('Wealth manager · NY · CRD 1')
  })
})
