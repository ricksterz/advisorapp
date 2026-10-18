import { describe, expect, it } from 'vitest'

import { SHARD_COUNT as BUILD_SHARDS, listIndexes, shardOf, splitDataset } from './shard-data.mjs'
import { SHARD_COUNT as APP_SHARDS, shardPath } from '../src/shards.js'

describe('shard-data', () => {
  it('uses the same shard count as the app', () => {
    expect(BUILD_SHARDS).toBe(APP_SHARDS)
    expect(shardPath('firm_owners', 65)).toMatch(new RegExp(`shards/firm_owners/${65 % APP_SHARDS}\\.json$`))
  })

  it('puts each firm in CRD % SHARD_COUNT and copies the dataset fields into every shard', () => {
    const shards = splitDataset('firm_trajectory', {
      years: [2025, 2026],
      segment_growth: { wealth: { slope: 0.3 } },
      firms: { 1: 'a', [1 + BUILD_SHARDS]: 'b', 2: 'c' },
    })
    expect(shards).toHaveLength(BUILD_SHARDS)
    expect(shards[shardOf(1)].firms).toEqual({ 1: 'a', [1 + BUILD_SHARDS]: 'b' })
    expect(shards[shardOf(2)].firms).toEqual({ 2: 'c' })
    expect(shards[7].years).toEqual([2025, 2026])
    expect(shards[7].firms).toEqual({})
  })

  it('keeps only the 13F filers each shard’s firms point to', () => {
    const shards = splitDataset('form_13f', {
      period: '2026-06-30',
      filers: { A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' } },
      firms: { 1: { cik: 'A' }, 2: { cik: 'B' }, [1 + BUILD_SHARDS]: { cik: 'B' } },
    })
    expect(Object.keys(shards[shardOf(1)].filers).sort()).toEqual(['A', 'B'])
    expect(Object.keys(shards[shardOf(2)].filers)).toEqual(['B'])
    expect(shards[shardOf(2)].period).toBe('2026-06-30')
  })

  it('gives the firm list flags without evidence, and bio counts', () => {
    const out = listIndexes(
      { generated_at: 'x', firms: { 1: { pf: true, rs: false, gp: false, evidence: { proprietary_funds: 'long text' } } } },
      { generated_at: 'y', firms: { 1: [{}, {}], 2: [] } },
    )
    expect(out.deal_flags_index.firms).toEqual({ 1: { pf: true, rs: false, gp: false } })
    expect(out.advisor_bios_index.firms).toEqual({ 1: 2 })
  })
})
