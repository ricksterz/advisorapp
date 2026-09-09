import { describe, expect, it } from 'vitest'

import { resolveWebsite } from './websiteOverrides.js'

// The real case this exists for: PATHSTONE FAMILY OFFICE files
// hallcapital.com, which now redirects to pathstone.com after the acquisition.
const OVERRIDES = {
  firms: {
    151736: {
      filed: 'https://hallcapital.com/',
      resolved: 'https://pathstone.com/',
      domain: 'pathstone.com',
    },
  },
}

describe('resolveWebsite', () => {
  it('prefers the resolved URL and flags it as redirected', () => {
    const r = resolveWebsite(OVERRIDES, 151736, 'https://hallcapital.com/')
    expect(r.url).toBe('https://pathstone.com/')
    expect(r.redirected).toBe(true)
    expect(r.filed).toBe('https://hallcapital.com/') // still available to show
  })

  it('accepts a numeric or string CRD', () => {
    expect(resolveWebsite(OVERRIDES, '151736', 'x').url).toBe('https://pathstone.com/')
  })

  it('falls back to the filed URL when the firm has no override', () => {
    const r = resolveWebsite(OVERRIDES, 999, 'https://example.com')
    expect(r.url).toBe('https://example.com')
    expect(r.redirected).toBe(false)
  })

  it('falls back while the overrides file is still loading', () => {
    // undefined (in flight) and null (unavailable) must both degrade to the
    // filed URL rather than rendering no link at all.
    for (const state of [undefined, null]) {
      const r = resolveWebsite(state, 151736, 'https://hallcapital.com/')
      expect(r.url).toBe('https://hallcapital.com/')
      expect(r.redirected).toBe(false)
    }
  })

  it('reports no URL when the firm filed none', () => {
    expect(resolveWebsite(OVERRIDES, 151736, null).url).toBeNull()
    expect(resolveWebsite(OVERRIDES, 151736, null).redirected).toBe(false)
  })
})
