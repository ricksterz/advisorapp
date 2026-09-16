import { describe, expect, it } from 'vitest'

import { DUCKDUCKGO, GOOGLE, faviconUrl } from './favicons.js'

const LIST = {
  google: new Set(['troweprice.com']), // DuckDuckGo only has its gray arrow
  none: new Set(['arrowstreetcapital.com']), // neither source has a logo
}

describe('faviconUrl', () => {
  it('uses Google for a host DuckDuckGo only has a placeholder for', () => {
    expect(faviconUrl(LIST, 'troweprice.com')).toBe(GOOGLE('troweprice.com'))
  })

  it('shows no icon rather than a placeholder when neither source has one', () => {
    expect(faviconUrl(LIST, 'arrowstreetcapital.com')).toBeNull()
  })

  it('defaults to DuckDuckGo for a checked host that is not an exception', () => {
    expect(faviconUrl(LIST, 'blackrock.com')).toBe(DUCKDUCKGO('blackrock.com'))
  })

  it('renders nothing while the list is still loading, so no placeholder flashes', () => {
    expect(faviconUrl(undefined, 'troweprice.com')).toBeNull()
  })

  it('falls back to DuckDuckGo when the list is unavailable', () => {
    expect(faviconUrl(null, 'blackrock.com')).toBe(DUCKDUCKGO('blackrock.com'))
  })

  it('has no icon for a firm without a website', () => {
    expect(faviconUrl(LIST, null)).toBeNull()
    expect(faviconUrl(LIST, '')).toBeNull()
  })
})
