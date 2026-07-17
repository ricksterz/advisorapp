import { describe, expect, it } from 'vitest'

import { computeDealPatterns } from './dealPatterns.js'
import { DEAL_FLAG_DEFS } from './dealFlags.js'

let nextCrd = 1
const firm = (aum_total) => ({ crd: nextCrd++, aum_total })

const flagsFile = (entries) => ({
  generated_at: '2026-01-01T00:00:00Z',
  firms: Object.fromEntries(entries.map(([crd, flags]) => [String(crd), flags])),
})

describe('computeDealPatterns', () => {
  it('returns null when deal_flags.json is unavailable', () => {
    expect(computeDealPatterns([firm(1e9)], null, DEAL_FLAG_DEFS)).toBeNull()
    expect(computeDealPatterns([firm(1e9)], undefined, DEAL_FLAG_DEFS)).toBeNull()
  })

  it('returns null with no firms', () => {
    expect(computeDealPatterns([], flagsFile([]), DEAL_FLAG_DEFS)).toBeNull()
  })

  it('returns null when the firm list has no overlap with the scanned set (dev fixture case)', () => {
    const a = firm(5e9)
    const b = firm(2e10)
    // deal_flags.json has entries, but none for these CRDs.
    const flags = flagsFile([[999999, { pf: true, rs: false, gp: false }]])
    expect(computeDealPatterns([a, b], flags, DEAL_FLAG_DEFS)).toBeNull()
  })

  it('excludes never-scanned firms from both numerator and denominator', () => {
    const scanned = firm(5e9) // $1B-$10B, flagged
    const unscanned = firm(5e9) // same band, absent from deal_flags.json entirely
    const flags = flagsFile([[scanned.crd, { pf: true, rs: false, gp: false }]])
    const result = computeDealPatterns([scanned, unscanned], flags, DEAL_FLAG_DEFS)
    const band = result.find((b) => b.id === '1b-10b')
    expect(band.scanned).toBe(1) // not 2 — the unscanned firm doesn't dilute the rate
    expect(band.flags.find((f) => f.id === 'pf').pct).toBe(100)
  })

  it('buckets firms into the four AUM bands with the $100M/$1B/$10B cut points', () => {
    const firms = [
      firm(5e7), // under $100M
      firm(9.9e7), // just under $100M
      firm(1e8), // exactly $100M -> $100M-$1B band (inclusive lower bound)
      firm(5e8), // $100M-$1B
      firm(1e9), // exactly $1B -> $1B-$10B
      firm(5e9), // $1B-$10B
      firm(1e10), // exactly $10B -> $10B+
      firm(5e10), // $10B+
    ]
    const flags = flagsFile(firms.map((f) => [f.crd, { pf: false, rs: false, gp: false }]))
    const result = computeDealPatterns(firms, flags, DEAL_FLAG_DEFS)
    const counts = Object.fromEntries(result.map((b) => [b.id, b.scanned]))
    expect(counts['lt100m']).toBe(2)
    expect(counts['100m-1b']).toBe(2)
    expect(counts['1b-10b']).toBe(2)
    expect(counts['10b+']).toBe(2)
  })

  it('treats a missing aum_total as 0 (falls into the lowest band)', () => {
    const f = firm(undefined)
    const flags = flagsFile([[f.crd, { pf: false, rs: false, gp: false }]])
    const result = computeDealPatterns([f], flags, DEAL_FLAG_DEFS)
    expect(result.map((b) => b.id)).toEqual(['lt100m'])
  })

  it('omits bands with zero scanned firms rather than showing a zero-filled bar', () => {
    const onlyBig = firm(2e10)
    const flags = flagsFile([[onlyBig.crd, { pf: true, rs: true, gp: true }]])
    const result = computeDealPatterns([onlyBig], flags, DEAL_FLAG_DEFS)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('10b+')
  })

  it('computes correct percentages per flag', () => {
    const firms = [firm(2e10), firm(2e10), firm(2e10), firm(2e10)]
    const flags = flagsFile([
      [firms[0].crd, { pf: true, rs: true, gp: true }],
      [firms[1].crd, { pf: true, rs: false, gp: false }],
      [firms[2].crd, { pf: false, rs: false, gp: true }],
      [firms[3].crd, { pf: false, rs: false, gp: false }],
    ])
    const result = computeDealPatterns(firms, flags, DEAL_FLAG_DEFS)
    const band = result.find((b) => b.id === '10b+')
    expect(band.scanned).toBe(4)
    expect(band.flags.find((f) => f.id === 'pf').pct).toBe(50)
    expect(band.flags.find((f) => f.id === 'rs').pct).toBe(25)
    expect(band.flags.find((f) => f.id === 'gp').pct).toBe(50)
  })
})
