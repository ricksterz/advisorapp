import { describe, expect, it } from 'vitest'

import { csvCell, csvFileName, toCsv } from './csv.js'
import { conflictIndicators, dataLimitations, diligenceQuestions, observations } from './intel.js'
import { describeRank, metricStats, peerCohort, PEER_METRIC_BY_ID, prevalence } from './peers.js'
import { baselineOf, detectChanges, parseStored, recentQuarterChanges } from './watchlist.js'

const firm = (crd, over = {}) => ({
  crd,
  legal_name: `FIRM ${crd}`,
  business_name: null,
  aum_mix: [100, 0, 0, 0],
  aum_total: 1e9,
  aum_discretionary: 9e8,
  accounts_total: 500,
  employees_total: 10,
  employees_advisory: 6,
  pct_clients_hnw_individuals: 60,
  fee_pct_of_aum: true,
  fee_performance_based: false,
  fee_commissions: false,
  affil_count: 0,
  disciplinary_flag_count: 0,
  ...over,
})

// 40 wealth managers in the $250M–$1B band, AUM 300M..690M, staff 2..41.
const universe = Array.from({ length: 40 }, (_, i) =>
  firm(1000 + i, { aum_total: 3e8 + i * 1e7, aum_discretionary: 3e8, employees_advisory: 2 + i, accounts_total: 100 + i * 10 }),
)

describe('csv', () => {
  it('quotes separators and neutralizes formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
    expect(csvCell(true)).toBe('Yes')
    expect(csvCell(Infinity)).toBe('')
  })
  it('joins rows with CRLF', () => {
    expect(toCsv([['a', 1], ['b', 2]])).toBe('a,1\r\nb,2\r\n')
  })
  it('makes a safe file name', () => {
    expect(csvFileName('Watch/list: <x>', new Date('2026-11-23T00:00:00Z'))).toBe('Watchlist x 2026-11-23.csv')
  })
})

describe('watchlist storage', () => {
  it('tolerates garbage and drops malformed entries', () => {
    expect(parseStored(null).firms).toEqual({})
    expect(parseStored('{not json').firms).toEqual({})
    expect(parseStored('[]').firms).toEqual({})
    const parsed = parseStored(JSON.stringify({ firms: { 12: { note: 'x', name: 'A' }, abc: {}, 13: 'bad' } }))
    expect(Object.keys(parsed.firms)).toEqual(['12'])
    expect(parsed.firms['12'].crd).toBe(12)
    expect(parsed.firms['12'].note).toBe('x')
  })
  it('caps note length', () => {
    const parsed = parseStored(JSON.stringify({ firms: { 1: { note: 'x'.repeat(10000) } } }))
    expect(parsed.firms['1'].note.length).toBe(4000)
  })
})

describe('material change detection', () => {
  const base = baselineOf(firm(1), '2026-09-01')
  it('reports nothing when nothing material moved', () => {
    expect(detectChanges(base, firm(1, { aum_total: 1.05e9 }))).toEqual([])
  })
  it('flags AUM, staff, disclosures, fees and broker-dealer status', () => {
    const now = firm(1, {
      aum_total: 1.3e9,
      employees_advisory: 9,
      disciplinary_flag_count: 2,
      fee_performance_based: true,
      broker_dealer: 'affiliated',
      affil_count: 1,
    })
    const ids = detectChanges(base, now).map((c) => c.id)
    expect(ids).toEqual(['aum', 'staff', 'disclosures', 'affiliations', 'fee_performance_based', 'broker_dealer'])
    expect(detectChanges(base, now)[0].text).toMatch(/not investment performance/)
  })
  it('ignores small headcount moves', () => {
    expect(detectChanges(base, firm(1, { employees_advisory: 7 }))).toEqual([])
  })
  it('notes a firm missing from the snapshot', () => {
    expect(detectChanges(base, null)[0].id).toBe('missing')
  })
  it('reads the latest two published quarters', () => {
    const history = {
      quarters: ['q1', 'q2', 'q3'],
      aum_total: [100, null, 130],
      disciplinary_flag_count: [0, null, 1],
    }
    expect(recentQuarterChanges(history).map((c) => c.id)).toEqual(['q-aum', 'q-disc'])
  })
})

describe('peers', () => {
  it('uses same-segment, same-band peers and falls back to the band', () => {
    const c = peerCohort(universe[5], universe)
    expect(c.bySegment).toBe(true)
    expect(c.peers.length).toBe(40)
    expect(c.label).toBe('wealth managers with $250M–$1B in AUM')
    const odd = firm(9, { aum_mix: [0, 0, 100, 0], aum_total: 5e8 })
    const c2 = peerCohort(odd, [...universe, odd])
    expect(c2.bySegment).toBe(false)
    expect(peerCohort(firm(9, { aum_total: 5e12 }), universe)).toBeNull()
  })
  it('computes quartiles and a rank, leaving unreported values out', () => {
    const s = metricStats(PEER_METRIC_BY_ID.staff, universe[39], universe)
    expect(s.n).toBe(40)
    expect(s.median).toBeCloseTo(21.5)
    expect(s.rank).toBeGreaterThan(0.95)
    const missing = metricStats(PEER_METRIC_BY_ID.accounts_per_pro, firm(2, { accounts_total: null }), universe)
    expect(missing.value).toBeNull()
    expect(missing.rank).toBeNull()
  })
  it('describes ranks in words', () => {
    expect(describeRank(0.8)).toEqual({ pct: 80, where: 'top quartile' })
    expect(describeRank(0.001).pct).toBe(1)
    expect(describeRank(null)).toBeNull()
  })
  it('measures how common an arrangement is among peers', () => {
    const peers = [firm(1, { fee_performance_based: true }), firm(2), firm(3), firm(4)]
    const p = prevalence(firm(5, { fee_performance_based: true }), peers).find((x) => x.id === 'fee_performance_based')
    expect(p).toEqual({ id: 'fee_performance_based', label: 'Performance-based fees', firm: true, share: 0.25 })
  })
})

describe('conflict indicators', () => {
  it('separates disclosed, not reported and not covered', () => {
    const list = conflictIndicators(firm(1, { fee_performance_based: true }), { dealFlags: null, funds: [] })
    const by = Object.fromEntries(list.map((c) => [c.id, c.status]))
    expect(by.performance_fees).toBe('disclosed')
    expect(by.commissions).toBe('not_reported')
    expect(by.deal_pf).toBe('not_covered')
    expect(by.private_funds).toBe('not_reported')
  })
  it('shows loading rather than a negative while data is in flight', () => {
    const list = conflictIndicators(firm(1), {})
    expect(list.find((c) => c.id === 'deal_pf').status).toBe('loading')
  })
})

describe('observations', () => {
  it('never presents growth as performance', () => {
    const obs = observations(firm(1), { growth: { entry: { a5: 2.1, r5: 80 }, endYear: 2026 } })
    const g = obs.find((o) => o.id === 'growth')
    expect(g.text).toMatch(/not the investment return/)
  })
  it('frames a clean record narrowly and a disclosure as a prompt to read', () => {
    expect(observations(firm(1)).find((o) => o.id === 'record').text).toMatch(/not a review of everything/)
    expect(observations(firm(1, { disciplinary_flag_count: 2 })).find((o) => o.id === 'record').text).toMatch(/not a finding of wrongdoing/)
  })
  it('calls disclosed arrangements arrangements, not misconduct', () => {
    const o = observations(firm(1, { fee_commissions: true }), {}).find((x) => x.id === 'conflicts')
    expect(o.text).toMatch(/not misconduct/)
  })
  it('lists what the report could not see', () => {
    const lim = dataLimitations(firm(1, { aum_mix: null }), { dealFlags: null, holdings: null, growth: null })
    expect(lim.map((l) => l.id)).toEqual(expect.arrayContaining(['aum_mix', 'deal', '13f', 'growth', 'performance', 'fees']))
  })
})

describe('due-diligence questions', () => {
  it('asks the baseline questions of every firm', () => {
    const ids = diligenceQuestions(firm(1)).map((q) => q.id)
    expect(ids).toEqual(expect.arrayContaining(['fee-schedule', 'all-in-cost', 'custody', 'advisor-record', 'investment-process']))
    expect(ids).not.toContain('performance-fees')
  })
  it('adds questions only where the filing gives a reason, with evidence', () => {
    const f = firm(1, {
      fee_performance_based: true,
      fee_commissions: true,
      broker_dealer: 'registered',
      affil_count: 3,
      disciplinary_flag_count: 2,
      employees_advisory: 1,
      employees_total: 1,
      country: 'Canada',
    })
    const ctx = {
      growth: { entry: { a5: 3, e5: 1.1, jump: 2024 }, endYear: 2026 },
      disclosures: { events: [{ kind: 'R', against: 'F', date: '2025-01-02', by: 'SEC', what: 'Fine', status: 'Final' }], coversFrom: '2025-01-01' },
      owners: { owners: [{ name: 'BIG HOLDCO LP', is_individual: false, control: true, stake: '75% or more' }] },
      ownershipChanges: [{ date: '2026-04-15', events: [{ type: 'added', name: 'BIG HOLDCO LP' }] }],
      dealFlags: { pf: true, rs: false, gp: false, evidence: { proprietary_funds: 'affiliated funds' } },
      funds: [{ name: 'FUND I', gav: 5e8 }],
    }
    const qs = diligenceQuestions(f, ctx)
    const ids = qs.map((q) => q.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'performance-fees',
        'commissions',
        'broker-dealer',
        'affiliates',
        'own-funds',
        'deal-pf',
        'disclosures',
        'outside-owners',
        'ownership-changes',
        'key-person',
        'acquisition',
        'capacity-growth',
        'jurisdiction',
      ]),
    )
    for (const q of qs.filter((x) => x.specific)) expect(q.evidence.length).toBeGreaterThan(0)
    expect(qs.find((q) => q.id === 'disclosures').evidence[1].text).toMatch(/2025-01-02/)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('benchmark my firm', async () => {
  const { selectCohort, benchmark, takeaways } = await import('./benchmarkFirm.js')
  it('builds the cohort the user asks for and excludes the firm', () => {
    const me = universe[0]
    const c = selectCohort(me, universe, { segment: true, band: true, region: false, hnw: false })
    expect(c.peers.length).toBe(39)
    expect(c.label).toBe('wealth managers with $250M–$1B in AUM')
    expect(selectCohort(me, universe, { segment: true, band: true, region: false, hnw: true }).label).toMatch(/high-net-worth/)
  })
  it('adds growth from the growth file and reports outer quartiles only', () => {
    const growth = { firms: Object.fromEntries(universe.map((f, i) => [String(f.crd), { a5: 1 + i / 10 }])) }
    const sections = benchmark(universe[39], universe.slice(0, 39), growth)
    expect(sections[1].id).toBe('growth')
    const t = takeaways(sections).map((x) => x.id)
    expect(t).toContain('g5')
    expect(t).toContain('staff')
  })
})
