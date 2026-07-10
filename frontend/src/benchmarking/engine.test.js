import { describe, expect, it } from 'vitest'

import { aumBandOf, clientMixOf, regionOf } from './cohort.js'
import { computeRankings, normalizedWeights } from './engine.js'
import { PRESETS, PRESET_BY_ID, cloneConfig, defaultConfig, matchingPresetId } from './presets.js'
import { decodeConfig, encodeConfig, sanitizeConfig, urlForConfig } from './url.js'

let nextCrd = 1
const firm = (over = {}) => ({
  crd: nextCrd++,
  legal_name: `Firm ${nextCrd}`,
  business_name: null,
  aum_total: 5e8,
  aum_discretionary: 4e8,
  aum_non_discretionary: 1e8,
  employees_total: 20,
  employees_advisory: 10,
  accounts_total: 500,
  fee_pct_of_aum: true,
  fee_performance_based: false,
  fee_commissions: false,
  affil_count: 0,
  disciplinary_flag_count: 0,
  pct_clients_individuals: 30,
  pct_clients_hnw_individuals: 30,
  pct_clients_pooled_vehicles: 10,
  pct_clients_pension_plans: 10,
  pct_clients_corporations: 10,
  pct_clients_other: 10,
  state: 'CA',
  ...over,
})

// A varied universe big enough that every cohort clears the min sample size.
const universe = (n = 40, over = () => ({})) =>
  Array.from({ length: n }, (_, i) =>
    firm({ aum_total: 1e8 * (i + 1), employees_advisory: 5 + (i % 10), ...over(i) }),
  )

describe('clean-record scoring fix', () => {
  it('grades disclosure count when the screen admits flagged firms', () => {
    const pool = universe(8) // small enough that the test firms make the top-10 slice
    const oneFlag = firm({ aum_total: 7.77e8, employees_advisory: 7, disciplinary_flag_count: 1 })
    const twoFlags = firm({ aum_total: 7.77e8, employees_advisory: 7, disciplinary_flag_count: 2 })
    const config = defaultConfig()
    config.top.maxDisclosures = 2
    config.weights.disciplinaryRecord = 0.2

    const { top } = computeRankings([...pool, oneFlag, twoFlags], config)
    const score = (f) => top.find((t) => t.firm.crd === f.crd)?.score
    expect(score(oneFlag)).toBeDefined()
    expect(score(twoFlags)).toBeDefined()
    expect(score(oneFlag)).toBeGreaterThan(score(twoFlags))
  })

  it('no longer adds a dead constant: weights renormalize to a full 0–100 range', () => {
    // Old formula floored every eligible score at 20 (the flat clean-record
    // term). A firm at the bottom of every factor must now score near zero.
    const w = normalizedWeights(defaultConfig().weights)
    expect(w.scale).toBeCloseTo(0.5)
    expect(w.productivity).toBeCloseTo(0.3125)
    expect(w.feeAlignment).toBeCloseTo(0.1875)
    expect(w.disciplinaryRecord).toBeUndefined()

    const firms = universe(30)
    const worst = firm({
      aum_total: 1e8,
      employees_advisory: 100, // rock-bottom AUM per professional
      fee_pct_of_aum: false, // no fee-alignment credit
    })
    const { top } = computeRankings([...firms.slice(0, 8), worst], defaultConfig())
    const entry = top.find((t) => t.firm.crd === worst.crd)
    expect(entry.score).toBeLessThan(20)
  })

  it('identical firms except disclosures rank identically when the factor is unweighted', () => {
    const config = defaultConfig()
    config.top.maxDisclosures = 5
    const a = firm({ aum_total: 3e8, disciplinary_flag_count: 0 })
    const b = firm({ aum_total: 3e8, disciplinary_flag_count: 3 })
    const { top } = computeRankings([...universe(7), a, b], config)
    const score = (f) => top.find((t) => t.firm.crd === f.crd)?.score
    expect(score(a)).toBeCloseTo(score(b), 10)
  })
})

describe('cohort bucketing', () => {
  it('assigns AUM bands at the documented cut points', () => {
    expect(aumBandOf(firm({ aum_total: 5e8 }))).toBe('under $1B')
    expect(aumBandOf(firm({ aum_total: 5e9 }))).toBe('$1B–$10B')
    expect(aumBandOf(firm({ aum_total: 5e10 }))).toBe('$10B+')
  })

  it('picks the dominant client-mix profile, null when unreported', () => {
    expect(clientMixOf(firm())).toBe('Individual / HNW')
    expect(
      clientMixOf(firm({ pct_clients_individuals: 5, pct_clients_hnw_individuals: 5, pct_clients_pooled_vehicles: 80 })),
    ).toBe('Institutional / pooled')
    expect(
      clientMixOf(firm({ pct_clients_individuals: 0, pct_clients_hnw_individuals: 0, pct_clients_pension_plans: 60 })),
    ).toBe('Pension / corporate')
    const unreported = firm()
    for (const k of Object.keys(unreported)) if (k.startsWith('pct_clients_')) unreported[k] = null
    expect(clientMixOf(unreported)).toBe(null)
  })

  it('maps states to census regions, null for territories and missing data', () => {
    expect(regionOf(firm({ state: 'NY' }))).toBe('Northeast')
    expect(regionOf(firm({ state: 'tx' }))).toBe('South')
    expect(regionOf(firm({ state: 'PR' }))).toBe(null)
    expect(regionOf(firm({ state: null }))).toBe(null)
  })
})

describe('cohorted rankings', () => {
  it('switching cohort scope changes who appears in the Top list', () => {
    // 15 mega firms dwarf 15 boutiques globally; within their own AUM band
    // the boutiques' percentiles recover.
    const megas = Array.from({ length: 15 }, (_, i) =>
      firm({ aum_total: 2e10 + i * 1e9, employees_advisory: 200 }),
    )
    const boutiques = Array.from({ length: 15 }, (_, i) =>
      firm({ aum_total: 1e8 + i * 1e7, employees_advisory: 4 }),
    )
    const global = defaultConfig()
    const banded = defaultConfig()
    banded.cohorts.aumBand = true

    const before = new Set(computeRankings([...megas, ...boutiques], global).top.map((t) => t.firm.crd))
    const after = new Set(computeRankings([...megas, ...boutiques], banded).top.map((t) => t.firm.crd))
    expect([...after]).not.toEqual([...before])
    expect(boutiques.some((b) => after.has(b.crd))).toBe(true)
  })

  it('falls back with an explanation when a cohort is under the sample floor', () => {
    // 20 Individual/HNW firms + 3 pension-focused firms, all in the same
    // $1B–$10B band: the pension × band cohort is too small, so those firms
    // rank against the AUM band only.
    const hnw = universe(20, (i) => ({ aum_total: 1e9 + i * 2e8 }))
    const pension = Array.from({ length: 3 }, (_, i) =>
      firm({
        aum_total: 9e9 - i * 5e8,
        pct_clients_individuals: 0,
        pct_clients_hnw_individuals: 0,
        pct_clients_pension_plans: 90,
      }),
    )
    const config = defaultConfig()
    config.cohorts.aumBand = true
    config.cohorts.clientMix = true

    const { top } = computeRankings([...hnw, ...pension], config)
    const pensionEntry = top.find((t) => pension.some((p) => p.crd === t.firm.crd))
    expect(pensionEntry).toBeDefined()
    expect(pensionEntry.cohort.note).toMatch(/cohort too small — showing AUM band only/)

    const hnwEntry = top.find((t) => hnw.some((p) => p.crd === t.firm.crd))
    expect(hnwEntry.cohort.note).toBe(null)
  })

  it('never computes percentiles over a tiny pool: all three dims on tiny data → global fallback', () => {
    const firms = universe(5, () => ({ state: 'WY' }))
    const config = defaultConfig()
    config.cohorts = { aumBand: true, clientMix: true, region: true }
    const { top } = computeRankings(firms, config)
    for (const entry of top) {
      expect(entry.cohort.note).toMatch(/all eligible firms/)
    }
  })
})

describe('risk list config', () => {
  it('threshold and point values drive the list', () => {
    const clean = universe(12)
    const flagged = firm({ aum_total: 6e8, disciplinary_flag_count: 1 })
    const zeroTolerance = cloneConfig(PRESET_BY_ID.cleanRecord.config)
    const lax = defaultConfig()

    expect(
      computeRankings([...clean, flagged], zeroTolerance).atRisk.map((r) => r.firm.crd),
    ).toContain(flagged.crd)
    // One disclosure = 15 points < default 40 threshold.
    expect(
      computeRankings([...clean, flagged], lax).atRisk.map((r) => r.firm.crd),
    ).not.toContain(flagged.crd)
  })

  it('a signal set to zero points stops tripping', () => {
    const conflicted = firm({ aum_total: 6e8, fee_commissions: true, fee_performance_based: true, affil_count: 5 })
    const config = defaultConfig()
    config.risk.threshold = 10
    config.risk.points.commissionsPlusPerf = 0
    const { atRisk } = computeRankings([...universe(12), conflicted], config)
    const entry = atRisk.find((r) => r.firm.crd === conflicted.crd)
    expect(entry.signals).toEqual(['Dense affiliations'])
  })
})

describe('presets', () => {
  it('all four exist and produce materially different Top lists', () => {
    const firms = [
      ...universe(20, (i) => ({ disciplinary_flag_count: i % 7 === 0 ? 1 : 0 })),
      ...Array.from({ length: 20 }, (_, i) =>
        firm({
          aum_total: 2e9 + i * 5e8,
          employees_advisory: 30 + i,
          pct_clients_individuals: 0,
          pct_clients_hnw_individuals: 0,
          pct_clients_pooled_vehicles: 80,
        }),
      ),
    ]
    expect(PRESETS.map((p) => p.id)).toEqual(['default', 'boutique', 'institutional', 'cleanRecord'])
    const lists = PRESETS.map((p) => computeRankings(firms, p.config).top.map((t) => t.firm.crd).join(','))
    expect(new Set(lists).size).toBeGreaterThan(2)
    expect(lists[0]).not.toBe(lists[2]) // default vs institutional
  })
})

describe('URL state', () => {
  it('preset configs round-trip by id', () => {
    for (const p of PRESETS) {
      const encoded = encodeConfig(cloneConfig(p.config))
      expect(decodeConfig(encoded)).toEqual(p.config)
      expect(encoded.length).toBeLessThan(30)
    }
  })

  it('a custom config round-trips to identical rankings', () => {
    const config = defaultConfig()
    config.weights.scale = 0.3
    config.weights.hnwFocus = 0.25
    config.top.minAum = 5e7
    config.top.maxDisclosures = 1
    config.risk.threshold = 25
    config.cohorts.aumBand = true
    config.cohorts.region = true

    const decoded = decodeConfig(encodeConfig(config))
    expect(decoded).toEqual(config)

    const firms = universe(30, (i) => ({ state: i % 2 ? 'NY' : 'CA', disciplinary_flag_count: i % 9 === 0 ? 1 : 0 }))
    expect(computeRankings(firms, decoded)).toEqual(computeRankings(firms, config))
  })

  it('garbage and hostile params fail closed', () => {
    expect(decodeConfig('not-base64!!!')).toBe(null)
    expect(decodeConfig(btoa('{"p":"nope"}'))).toBe(null)
    const hostile = btoa(JSON.stringify({ d: { weights: { scale: 999, __proto__: { evil: 1 } }, top: { minAum: -5 } } }))
    const cfg = decodeConfig(hostile)
    expect(cfg.weights.scale).toBe(1) // clamped
    expect(cfg.top.minAum).toBe(0) // clamped
    expect({}.evil).toBeUndefined()
    expect(computeRankings(universe(12), cfg).top.length).toBeGreaterThan(0)
  })

  it('default methodology yields a clean URL; custom views carry ?m=', () => {
    expect(urlForConfig(defaultConfig(), 'https://x.dev/advisorapp/?m=old')).toBe('https://x.dev/advisorapp/')
    const config = defaultConfig()
    config.weights.scale = 0.2
    expect(matchingPresetId(config)).toBe(null)
    const url = new URL(urlForConfig(config, 'https://x.dev/advisorapp/'))
    expect(decodeConfig(url.searchParams.get('m'))).toEqual(config)
  })
})

describe('performance', () => {
  it('recomputes a 40K-firm universe with combined cohorts well under 200ms', () => {
    const states = ['NY', 'CA', 'TX', 'IL', 'MA', 'FL', 'WA', 'PA', 'PR']
    const firms = Array.from({ length: 40000 }, (_, i) =>
      firm({
        aum_total: 1e8 + (i % 977) * 1e8,
        employees_advisory: 3 + (i % 40),
        state: states[i % states.length],
        disciplinary_flag_count: i % 13 === 0 ? (i % 3) + 1 : 0,
        pct_clients_pooled_vehicles: i % 4 === 0 ? 90 : 10,
      }),
    )
    const config = defaultConfig()
    config.cohorts = { aumBand: true, clientMix: true, region: true }
    config.weights.hnwFocus = 0.1
    const start = performance.now()
    const { top, atRisk } = computeRankings(firms, config)
    const elapsed = performance.now() - start
    expect(top.length).toBe(10)
    expect(atRisk.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })
})
