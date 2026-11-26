import { afterEach, describe, expect, it } from 'vitest'

import { paramsFromDataset, track } from './analytics.js'

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
