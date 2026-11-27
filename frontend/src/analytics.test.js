import { afterEach, describe, expect, it } from 'vitest'

import {
  INTERNAL_KEY,
  internalParam,
  isAutomated,
  paramsFromDataset,
  resolveInternal,
  stripInternalParam,
  track,
} from './analytics.js'

describe('analytics', () => {
  afterEach(() => {
    delete globalThis.window
  })

  it('does nothing when gtag is not loaded', () => {
    expect(() => track('x', { a: 1 })).not.toThrow()
    globalThis.window = {}
    expect(() => track('x', { a: 1 })).not.toThrow()
  })

  it('sends only well-formed, short parameters', () => {
    const calls = []
    globalThis.window = { gtag: (...args) => calls.push(args) }
    track('follow_firm', { firm_crd: 151736, location: 'page', 'Bad-Key': 1, empty: '', nil: null, long: 'x'.repeat(500) })
    expect(calls).toEqual([['event', 'follow_firm', { firm_crd: 151736, location: 'page', long: 'x'.repeat(100) }]])
  })

  it('never throws if gtag does', () => {
    globalThis.window = { gtag: () => { throw new Error('blocked') } }
    expect(() => track('x')).not.toThrow()
  })

  it('maps data-track-* attributes to snake_case params', () => {
    expect(paramsFromDataset({ track: 'select_firm_tool', trackTool: 'report', trackFirmCrd: '12', other: 'x' })).toEqual({
      tool: 'report',
      firm_crd: '12',
    })
  })
})

function fakeWindow(href, stored = {}) {
  const store = { ...stored }
  const url = new URL(href)
  const win = {
    store,
    location: {
      get href() {
        return url.href
      },
      get search() {
        return url.search
      },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    history: {
      state: { s: 1 },
      replaceState: (_state, _t, next) => {
        const n = new URL(next, url)
        url.pathname = n.pathname
        url.search = n.search
        url.hash = n.hash
      },
    },
  }
  return win
}

describe('internal traffic', () => {
  it('reads the internal parameter', () => {
    expect(internalParam('?internal=1')).toBe(true)
    expect(internalParam('?a=b&internal=true')).toBe(true)
    expect(internalParam('?internal=0')).toBe(false)
    expect(internalParam('?internal=yes')).toBe(null)
    expect(internalParam('')).toBe(null)
  })

  it('strips only the internal parameter', () => {
    expect(stripInternalParam('https://x.com/firm/1?view=report&internal=1#a')).toBe('/firm/1?view=report#a')
    expect(stripInternalParam('https://x.com/?internal=1')).toBe('/')
    expect(stripInternalParam('https://x.com/?view=report')).toBe('https://x.com/?view=report')
  })

  it('?internal=1 sets the flag and cleans the address bar', () => {
    const win = fakeWindow('https://x.com/fees?internal=1&c=abc')
    expect(resolveInternal(win)).toBe(true)
    expect(win.store[INTERNAL_KEY]).toBe('1')
    expect(win.location.href).toBe('https://x.com/fees?c=abc')
  })

  it('remembers the flag on later visits and ?internal=0 clears it', () => {
    expect(resolveInternal(fakeWindow('https://x.com/', { [INTERNAL_KEY]: '1' }))).toBe(true)
    const win = fakeWindow('https://x.com/?internal=0', { [INTERNAL_KEY]: '1' })
    expect(resolveInternal(win)).toBe(false)
    expect(INTERNAL_KEY in win.store).toBe(false)
    expect(win.location.href).toBe('https://x.com/')
    expect(resolveInternal(fakeWindow('https://x.com/'))).toBe(false)
  })

  it('still honours the parameter when storage is blocked', () => {
    const win = fakeWindow('https://x.com/?internal=1')
    win.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(resolveInternal(win)).toBe(true)
    expect(win.location.href).toBe('https://x.com/')
  })

  it('detects automated browsers', () => {
    expect(isAutomated({ webdriver: true })).toBe(true)
    expect(isAutomated({ webdriver: false })).toBe(false)
    expect(isAutomated(undefined)).toBe(false)
  })
})
