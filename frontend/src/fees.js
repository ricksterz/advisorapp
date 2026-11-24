// Wealth-management fee calculator: what an advisory fee schedule costs at a
// given asset level, and what it and the investments' own expenses do to a
// portfolio over time. Every input is the user's. Nothing here is a firm's
// actual fee or an industry average: Form ADV Part 1A records which kinds of
// fees a firm charges, never the rates, so the only honest source for a
// firm's schedule is its own brochure (Part 2A, Item 5) or contract.
//
// The model, kept simple enough to check by hand:
//   each year, fee = schedule(balance at start of year) + fixed fee, at least
//   the minimum; investment costs = balance × (fund expenses + other costs);
//   end = start × (1 + gross return) − fee − investment costs + net flow.
// Real billing is usually quarterly on a balance that moves; annual billing
// on the starting balance is a close, transparent approximation.

export const MAX_RATE = 10 // % — anything above is almost certainly a typo
export const MAX_YEARS = 50
export const MAX_ASSETS = 1e12

/** Tier boundaries are "up to" amounts; the last tier has upTo null (no cap). */
export function normalizeTiers(tiers) {
  const clean = (tiers ?? [])
    .map((t) => ({
      upTo: t.upTo == null || t.upTo === '' || !Number.isFinite(Number(t.upTo)) ? null : Math.max(0, Number(t.upTo)),
      rate: clampNum(t.rate, 0, MAX_RATE, 0),
    }))
  const capped = clean.filter((t) => t.upTo != null).sort((a, b) => a.upTo - b.upTo)
  const open = clean.find((t) => t.upTo == null) ?? (capped.length ? { upTo: null, rate: capped[capped.length - 1].rate } : { upTo: null, rate: 0 })
  // Drop duplicate boundaries: a zero-width tier would never apply.
  const unique = capped.filter((t, i) => i === 0 || t.upTo !== capped[i - 1].upTo)
  return [...unique, { upTo: null, rate: open.rate }]
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Annual advisory fee in dollars for a balance.
 * mode 'tiered': each tier's rate applies only to the assets within it (the
 *   common "blended" schedule). mode 'whole': the whole balance is charged the
 *   rate of the tier it falls in (a "cliff" breakpoint schedule).
 */
export function scheduleFee(balance, schedule) {
  const b = Math.max(0, Number(balance) || 0)
  const tiers = normalizeTiers(schedule?.tiers)
  let fee = 0
  if (schedule?.mode === 'whole') {
    const tier = tiers.find((t) => t.upTo == null || b <= t.upTo)
    fee = (b * tier.rate) / 100
  } else {
    let floor = 0
    for (const t of tiers) {
      const top = t.upTo == null ? Infinity : t.upTo
      if (b <= floor) break
      fee += ((Math.min(b, top) - floor) * t.rate) / 100
      floor = top
    }
  }
  fee += Math.max(0, Number(schedule?.fixed) || 0)
  const min = Math.max(0, Number(schedule?.minimum) || 0)
  return b > 0 ? Math.max(fee, min) : 0
}

/** Effective annual rate (%) a schedule charges at a balance. */
export const effectiveRate = (balance, schedule) => (balance > 0 ? (scheduleFee(balance, schedule) / balance) * 100 : 0)

/**
 * Year-by-year projection for one scenario.
 * a: { assets, years, grossReturn %, flow $/yr (negative = withdrawals) }
 * s: { schedule, fundExpense %, otherCost % }
 * Returns { rows: [{ year, start, advisoryFee, investmentCost, growth, flow, end }], totals }.
 */
export function project(a, s) {
  const years = Math.round(clampNum(a.years, 1, MAX_YEARS, 10))
  const r = clampNum(a.grossReturn, -50, 50, 0) / 100
  const flow = clampNum(a.flow, -MAX_ASSETS, MAX_ASSETS, 0)
  const costRate = (clampNum(s.fundExpense, 0, MAX_RATE, 0) + clampNum(s.otherCost, 0, MAX_RATE, 0)) / 100
  let balance = clampNum(a.assets, 0, MAX_ASSETS, 0)
  const rows = []
  const totals = { advisoryFee: 0, investmentCost: 0 }
  for (let year = 1; year <= years; year++) {
    const start = balance
    const growth = start * r
    const advisoryFee = s.schedule ? scheduleFee(start, s.schedule) : 0
    const investmentCost = start * costRate
    // A fee can't exceed what's there to pay it.
    const charged = Math.min(advisoryFee + investmentCost, Math.max(0, start + growth))
    const scale = advisoryFee + investmentCost > 0 ? charged / (advisoryFee + investmentCost) : 0
    const end = Math.max(0, start + growth - charged + flow)
    rows.push({
      year,
      start,
      advisoryFee: advisoryFee * scale,
      investmentCost: investmentCost * scale,
      growth,
      flow,
      end,
    })
    totals.advisoryFee += advisoryFee * scale
    totals.investmentCost += investmentCost * scale
    balance = end
  }
  return { rows, totals: { ...totals, all: totals.advisoryFee + totals.investmentCost, endBalance: balance } }
}

/**
 * Compare scenarios against the same portfolio with no costs at all, so the
 * "cost" includes the growth the fees would otherwise have earned.
 * Returns { baseline, scenarios: [{ ...projection, firstYearFee, firstYearRate, allInRate, costVsBaseline }] }.
 */
export function compareScenarios(assumptions, scenarios) {
  const baseline = project(assumptions, { schedule: null, fundExpense: 0, otherCost: 0 })
  return {
    baseline,
    scenarios: scenarios.map((s) => {
      const p = project(assumptions, s)
      const first = p.rows[0]
      const assets = Math.max(0, Number(assumptions.assets) || 0)
      return {
        ...p,
        label: s.label,
        firstYearFee: first?.advisoryFee ?? 0,
        firstYearRate: assets > 0 ? effectiveRate(assets, s.schedule) : 0,
        allInRate: assets > 0 ? ((first.advisoryFee + first.investmentCost) / assets) * 100 : 0,
        costVsBaseline: baseline.totals.endBalance - p.totals.endBalance,
      }
    }),
  }
}

export const ASSET_PRESETS = [1e6, 2.5e6, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6]

// Example inputs. Labelled as examples everywhere they appear: they are not
// any firm's schedule and not an industry average.
export const EXAMPLE_TIERED = {
  label: 'Schedule A',
  schedule: {
    mode: 'tiered',
    tiers: [
      { upTo: 1e6, rate: 1.0 },
      { upTo: 5e6, rate: 0.8 },
      { upTo: 10e6, rate: 0.6 },
      { upTo: null, rate: 0.4 },
    ],
    fixed: 0,
    minimum: 0,
  },
  fundExpense: 0.2,
  otherCost: 0,
}

export const EXAMPLE_FLAT = {
  label: 'Schedule B',
  schedule: { mode: 'tiered', tiers: [{ upTo: null, rate: 0.5 }], fixed: 0, minimum: 0 },
  fundExpense: 0.2,
  otherCost: 0,
}

export const DEFAULT_ASSUMPTIONS = { assets: 10e6, years: 20, grossReturn: 6, flow: 0 }

// ---- shareable state (?c=) ---------------------------------------------------

function sanitizeScenario(s, fallback) {
  if (!s || typeof s !== 'object') return fallback
  const sched = s.schedule && typeof s.schedule === 'object' ? s.schedule : {}
  return {
    label: typeof s.label === 'string' ? s.label.slice(0, 40) : fallback.label,
    schedule: {
      mode: sched.mode === 'whole' ? 'whole' : 'tiered',
      tiers: normalizeTiers(Array.isArray(sched.tiers) ? sched.tiers.slice(0, 12) : fallback.schedule.tiers),
      fixed: clampNum(sched.fixed, 0, 1e9, 0),
      minimum: clampNum(sched.minimum, 0, 1e9, 0),
    },
    fundExpense: clampNum(s.fundExpense, 0, MAX_RATE, 0),
    otherCost: clampNum(s.otherCost, 0, MAX_RATE, 0),
  }
}

export function sanitizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const a = r.assumptions && typeof r.assumptions === 'object' ? r.assumptions : {}
  const list = Array.isArray(r.scenarios) ? r.scenarios.slice(0, 3) : []
  return {
    assumptions: {
      assets: clampNum(a.assets, 0, MAX_ASSETS, DEFAULT_ASSUMPTIONS.assets),
      years: Math.round(clampNum(a.years, 1, MAX_YEARS, DEFAULT_ASSUMPTIONS.years)),
      grossReturn: clampNum(a.grossReturn, -50, 50, DEFAULT_ASSUMPTIONS.grossReturn),
      flow: clampNum(a.flow, -MAX_ASSETS, MAX_ASSETS, 0),
    },
    scenarios: list.length
      ? list.map((s, i) => sanitizeScenario(s, i === 0 ? EXAMPLE_TIERED : EXAMPLE_FLAT))
      : [EXAMPLE_TIERED, EXAMPLE_FLAT],
  }
}

const toB64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))

export const encodeState = (state) => toB64(JSON.stringify(state))

export function decodeState(param) {
  if (!param || param.length > 4000) return null
  try {
    return sanitizeState(JSON.parse(fromB64(param)))
  } catch {
    return null
  }
}

/** "2.5m", "$1,000,000", "750k" → number; null when it can't be read. */
export function parseMoney(text) {
  if (text == null) return null
  const s = String(text).trim().toLowerCase().replace(/[$,\s]/g, '')
  if (!s) return null
  const m = s.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/)
  if (!m) return null
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] ?? 1
  const v = Number(m[1]) * mult
  return Number.isFinite(v) ? v : null
}
