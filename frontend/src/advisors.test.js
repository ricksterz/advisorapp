import { describe, expect, it } from 'vitest'

import { bucketRange, matchesName, nameTokens } from './advisors.js'
import { advisorCounts, advisorRosters, advisorSearch, separateBigRosters } from '../scripts/shard-data.mjs'

const person = (crd, name, firms = [1], extra = {}) => [
  crd, name, firms, extra.city ?? 'Denver', extra.state ?? 'CO', extra.designations ?? '', extra.disclosure ?? 0, extra.year ?? 2010,
]

describe('advisor search index', () => {
  const people = [
    person(1, 'John A. Smith'),
    person(2, 'Mary Smithers'),
    person(3, 'Smith Jones'),
    person(4, 'Anne Adams'),
    person(5, 'Zoe Zhang', [1, 2]),
  ]

  it('files each person under first and last name, in alphabetical buckets', () => {
    const { meta, buckets } = advisorSearch(people, 3)
    const filed = buckets.flat().map((e) => e[0])
    // John Smith under "john" and "smith"; Smith Jones under "smith" and "jones".
    expect(filed.filter((c) => c === 1)).toHaveLength(2)
    expect(filed.filter((c) => c === 3)).toHaveLength(2)
    expect(meta.starts).toEqual([...meta.starts].sort())
    expect(meta.people).toBe(5)
    expect(buckets.every((b) => b.length <= 3)).toBe(true)
  })

  it('finds the buckets a prefix can fall in', () => {
    const starts = ['adams', 'jones', 'smith', 'smithers', 'zhang']
    // "smiley" would sort after "jones" and before "smith", so the bucket
    // starting at "jones" can hold "smi..." names too.
    expect(bucketRange(starts, 'smi')).toEqual([1, 2, 3])
    expect(bucketRange(starts, 'smithe')).toEqual([2, 3])
    expect(bucketRange(starts, 'ad')).toEqual([0])
    expect(bucketRange(starts, 'b')).toEqual([0]) // between buckets: the one before
    expect(bucketRange(starts, 'zz')).toEqual([4])
  })

  it('reads every bucket a common name spills across', () => {
    // Chunks split the Smiths: some sit at the end of the bucket starting "adams".
    const starts = ['adams', 'smith', 'smith', 'taylor']
    expect(bucketRange(starts, 'smith')).toEqual([0, 1, 2])
    expect(bucketRange(starts, 'smithers')).toEqual([2])
  })

  it('needs every query word to start a word of the name', () => {
    expect(matchesName('John A. Smith', ['jo', 'smi'])).toBe(true)
    expect(matchesName('John A. Smith', ['smith', 'jo'])).toBe(true)
    expect(matchesName('Mary Smithers', ['john'])).toBe(false)
    expect(nameTokens("Mary O'Brien-Smith")).toEqual(['mary', 'o', 'brien', 'smith'])
  })
})

describe('rosters', () => {
  it('lists each firm’s people by last name, and gives huge rosters their own file', () => {
    const { firms } = advisorRosters([person(1, 'Zed Adams'), person(2, 'Amy Young', [1, 2]), person(3, 'Bo Brown', [2])])
    expect(firms[1].map((r) => r[1])).toEqual(['Zed Adams', 'Amy Young'])
    expect(firms[2].map((r) => r[0])).toEqual([3, 2])
    expect(firms[2][0]).toEqual([3, 'Bo Brown', 'Denver', 'CO', '', 0, 2010])

    const big = { firms: { 9: Array.from({ length: 1001 }, (_, i) => [i]), 8: [[1]] } }
    const { small, big: own } = separateBigRosters(big)
    expect(small.firms[9]).toEqual({ own_file: true, count: 1001 })
    expect(small.firms[8]).toEqual([[1]])
    expect(Object.keys(own)).toEqual(['9'])
  })
})

describe('advisor counts', () => {
  it('counts each firm’s advisors and those with disclosures', () => {
    const people = [person(1, 'A B', [1, 2], { disclosure: 1 }), person(2, 'C D', [1]), person(3, 'E F', [2], { disclosure: 1 })]
    expect(advisorCounts(people).firms).toEqual({ 1: [2, 1], 2: [2, 2] })
  })
})

