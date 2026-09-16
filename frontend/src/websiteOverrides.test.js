import { describe, expect, it } from 'vitest'

import { resolveWebsite, websiteNote } from './websiteOverrides.js'

// The real case this exists for: PATHSTONE FAMILY OFFICE files
// hallcapital.com, which now redirects to pathstone.com after the acquisition.
const OVERRIDES = {
  firms: {
    151736: {
      filed: 'https://hallcapital.com/',
      resolved: 'https://pathstone.com/',
      domain: 'pathstone.com',
      via: 'redirect',
    },
    // The other kind: VANGUARD GROUP files a Reddit user profile, which is a
    // perfectly live link that is simply not a website. No redirect can fix
    // that, so the real site was researched.
    105958: {
      filed: 'https://www.reddit.com/user/VanguardGroup/',
      resolved: 'https://investor.vanguard.com/',
      domain: 'investor.vanguard.com',
      via: 'research',
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
    expect(resolveWebsite(OVERRIDES, '151736', 'https://hallcapital.com/').url).toBe('https://pathstone.com/')
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

  it('uses the researched site when the firm filed a social profile', () => {
    const r = resolveWebsite(OVERRIDES, 105958, 'https://www.reddit.com/user/VanguardGroup/')
    expect(r.url).toBe('https://investor.vanguard.com/')
    expect(r.via).toBe('research')
  })

  it('treats an entry with no via as a redirect', () => {
    // Older exports predate the field; they were all redirects.
    const legacy = { firms: { 1: { filed: 'https://a.com', resolved: 'https://b.com' } } }
    expect(resolveWebsite(legacy, 1, 'https://a.com').via).toBe('redirect')
  })

  it('ignores a redirect measured on a URL the firm no longer lists first', () => {
    // The override was computed against an old pick; applying it now would
    // replace the firm's correct current website with a stale destination.
    const r = resolveWebsite(OVERRIDES, 151736, 'https://pathstone.com/')
    expect(r.url).toBe('https://pathstone.com/')
    expect(r.redirected).toBe(false)
    const stale = resolveWebsite(OVERRIDES, 151736, 'https://www.blackrock.com')
    expect(stale.url).toBe('https://www.blackrock.com')
  })

  it('tolerates whitespace differences when matching the filed URL', () => {
    expect(resolveWebsite(OVERRIDES, 151736, ' https://hallcapital.com/ ').url).toBe('https://pathstone.com/')
  })

  it('applies a researched website even when the firm has no usable filed address', () => {
    // A firm whose only filed addresses are platforms ends up with no
    // website_url at all — those are exactly the firms research exists for.
    const r = resolveWebsite(OVERRIDES, 105958, null)
    expect(r.url).toBe('https://investor.vanguard.com/')
    expect(r.via).toBe('research')
  })

  it('reports no URL when the firm filed none', () => {
    expect(resolveWebsite(OVERRIDES, 151736, null).url).toBeNull()
    expect(resolveWebsite(OVERRIDES, 151736, null).redirected).toBe(false)
  })
})

describe('websiteNote', () => {
  it('distinguishes a redirect from a researched replacement', () => {
    const filed = 'https://www.reddit.com/user/VanguardGroup/'
    expect(websiteNote(resolveWebsite(OVERRIDES, 151736, 'https://hallcapital.com/')))
      .toBe('firm website · redirected')
    expect(websiteNote(resolveWebsite(OVERRIDES, 105958, filed)))
      .toBe('firm website · researched')
  })

  it('does not caption a researched site the firm also filed itself', () => {
    const overrides = { firms: { 7: { resolved: 'https://www.sequoiacap.com/', via: 'research' } } }
    expect(websiteNote(resolveWebsite(overrides, 7, 'HTTP://WWW.SEQUOIACAP.COM'))).toBe('firm website')
  })

  it('captions a researched site when the firm filed no usable website', () => {
    const overrides = { firms: { 8: { resolved: 'https://www.maryandpip.com/', via: 'research' } } }
    expect(websiteNote(resolveWebsite(overrides, 8, null))).toBe('firm website · researched')
  })

  it('says nothing extra when the filed link stands', () => {
    expect(websiteNote(resolveWebsite(OVERRIDES, 999, 'https://example.com'))).toBe('firm website')
  })
})
